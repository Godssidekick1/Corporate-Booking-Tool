import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { requireTmcPermission } from '@/app/lib/permissions/requireTmcPermission'
import { gstinFinding } from '@/app/lib/data/gstin'
import { NextRequest } from 'next/server'

// ── /api/tmc/clients/[id]/gst ────────────────────────────────────────────────
// The GST registrations a client bills under.
//
// A corporate bills through several: different cost centres, different validity
// windows, sometimes a new certificate replacing an expiring one. Which applies
// to a booking is a lookup, not a field, which is why this is a table and not
// the single clients.gst_number column it replaced.
//
// WARNS, NEVER REJECTS on a malformed or state-mismatched GSTIN — the same call
// the branch master makes, for the same reason: the TMC holds the certificate on
// paper and the software does not get to overrule it. The finding rides back on
// the response so the screen can show it.
//
// A registration may have NO number yet. Holder, address, cost centre and
// validity are often on file first, and refusing the row would mean keeping it
// in a spreadsheet until the number arrives.
// ─────────────────────────────────────────────────────────────────────────────

const COLUMNS =
  'id, client_id, gstin, gst_holder, email, contact, ' +
  'address_1, address_2, city, state, country, zip, ' +
  'registration_date, valid_from, valid_to, cost_centre_id, is_primary, created_at'

const TEXT_FIELDS = [
  'gst_holder', 'email', 'contact',
  'address_1', 'address_2', 'city', 'state', 'country', 'zip',
] as const

const DATE_FIELDS = ['registration_date', 'valid_from', 'valid_to'] as const

interface Body {
  entryId?: string
  gstin?: string | null
  cost_centre_id?: string | null
  is_primary?: boolean
}

async function authorise(clientId: string) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) {
    return { error: Response.json({ error: 'Not authenticated' }, { status: 401 }) }
  }

  const service = createServiceClient()
  const check = await requireTmcPermission(service, user.id, 'manage_clients', clientId)
  if (!check.authorized || !check.tmcId) {
    return { error: Response.json({ error: check.error ?? 'Forbidden' }, { status: check.status ?? 403 }) }
  }

  const { data: client } = await service
    .from('clients')
    .select('id')
    .eq('id', clientId)
    .eq('tmc_id', check.tmcId)
    .maybeSingle()

  if (!client) {
    return { error: Response.json({ error: 'Client not found' }, { status: 404 }) }
  }

  return { service }
}

type Service = ReturnType<typeof createServiceClient>

// Shared by POST and PATCH. Returns either the column updates or a Response to
// send instead, so both verbs validate identically — a cost centre that may be
// set on create but not on edit is the kind of gap nobody notices.
async function buildUpdate(
  service: Service,
  clientId: string,
  body: Record<string, unknown>
): Promise<{ update: Record<string, unknown> } | { error: Response }> {
  const update: Record<string, unknown> = {}

  if (body.gstin !== undefined) {
    const raw = typeof body.gstin === 'string' ? body.gstin.trim().toUpperCase() : ''
    update.gstin = raw || null
  }

  for (const field of TEXT_FIELDS) {
    if (body[field] === undefined) continue
    const raw = typeof body[field] === 'string' ? (body[field] as string).trim() : ''
    update[field] = raw || null
  }

  for (const field of DATE_FIELDS) {
    if (body[field] === undefined) continue
    const raw = typeof body[field] === 'string' ? (body[field] as string).trim() : ''
    update[field] = raw || null
  }

  // The cost centre must belong to THIS client. cost_centres is a plain FK, so
  // another client's centre satisfies the constraint and would put this
  // corporate's invoices under someone else's accounting code.
  if (body.cost_centre_id !== undefined) {
    const value = body.cost_centre_id
    if (!value) {
      update.cost_centre_id = null
    } else {
      const { data: centre } = await service
        .from('cost_centres')
        .select('id')
        .eq('id', value as string)
        .eq('client_id', clientId)
        .maybeSingle()

      if (!centre) {
        return { error: Response.json({ error: 'Cost centre not found for this client' }, { status: 422 }) }
      }
      update.cost_centre_id = value
    }
  }

  if (typeof body.is_primary === 'boolean') {
    update.is_primary = body.is_primary
  }

  return { update }
}

// Only one registration per client may be primary, enforced by a partial unique
// index. Clearing the others FIRST means the index never sees two at once —
// setting the new one first would collide before the old one is cleared.
async function clearOtherPrimaries(service: Service, clientId: string, keepId: string | null) {
  let query = service
    .from('client_gst_registrations')
    .update({ is_primary: false })
    .eq('client_id', clientId)
    .eq('is_primary', true)

  if (keepId) query = query.neq('id', keepId)
  await query
}

// 23P01 is an exclusion-constraint violation — two registrations for the same
// cost centre whose validity windows overlap. Worth its own message: the raw
// text names a constraint nobody outside this file has heard of.
function overlapResponse(centred: boolean) {
  return Response.json(
    {
      error:
        (centred
          ? 'Another registration for this cost centre already covers part of that date range. '
          : 'Another registration with no cost centre already covers part of that date range. ') +
        'Two overlapping registrations make it ambiguous which GSTIN invoices a booking.',
    },
    { status: 409 }
  )
}

// Half-open on both ends: a null valid_from reaches back forever, a null
// valid_to runs forever. Mirrors daterange(valid_from, valid_to, '[]') so the
// answer here and the answer the database gives cannot differ.
function windowsOverlap(
  aFrom: string | null, aTo: string | null,
  bFrom: string | null, bTo: string | null
): boolean {
  const aStartsBeforeBEnds = !aFrom || !bTo || aFrom <= bTo
  const bStartsBeforeAEnds = !bFrom || !aTo || bFrom <= aTo
  return aStartsBeforeBEnds && bStartsBeforeAEnds
}

// The same rule the exclusion constraint enforces, checked up front so the
// answer is a sentence rather than a constraint name — and so it still holds if
// btree_gist was unavailable when the migration ran and the constraint was
// skipped.
async function findOverlap(
  service: Service,
  clientId: string,
  update: Record<string, unknown>,
  excludeId: string | null
): Promise<{ id: string } | null> {
  const centreId = (update.cost_centre_id as string | null) ?? null

  let query = service
    .from('client_gst_registrations')
    .select('id, valid_from, valid_to, cost_centre_id')
    .eq('client_id', clientId)

  query = centreId ? query.eq('cost_centre_id', centreId) : query.is('cost_centre_id', null)
  if (excludeId) query = query.neq('id', excludeId)

  const { data: siblings } = await query

  const from = (update.valid_from as string | null) ?? null
  const to = (update.valid_to as string | null) ?? null

  for (const row of siblings ?? []) {
    if (windowsOverlap(from, to, row.valid_from, row.valid_to)) return { id: row.id }
  }
  return null
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const auth = await authorise(id)
  if (auth.error) return auth.error

  const { data, error } = await auth.service
    .from('client_gst_registrations')
    .select(COLUMNS)
    .eq('client_id', id)
    .order('is_primary', { ascending: false })
    .order('valid_from', { ascending: false, nullsFirst: false })

  if (error) return Response.json({ error: error.message }, { status: 500 })

  return Response.json({ ok: true, registrations: data ?? [] })
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const auth = await authorise(id)
  if (auth.error) return auth.error
  const { service } = auth

  let body: Body & Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const built = await buildUpdate(service, id, body)
  if ('error' in built) return built.error

  if (await findOverlap(service, id, built.update, null)) {
    return overlapResponse(Boolean(built.update.cost_centre_id))
  }

  if (body.is_primary === true) await clearOtherPrimaries(service, id, null)

  const { data, error } = await service
    .from('client_gst_registrations')
    .insert({ ...built.update, client_id: id })
    .select(COLUMNS)
    .single()

  if (error) {
    if (error.code === '23P01') return overlapResponse(Boolean(built.update.cost_centre_id))
    if (error.code === '23505') {
      return Response.json({ error: 'That GST number is already on file for this client' }, { status: 409 })
    }
    return Response.json({ error: error.message }, { status: 500 })
  }

  return Response.json({
    ok: true,
    registration: data,
    finding: gstinFinding(built.update.gstin as string | null, built.update.state as string | null),
  })
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const auth = await authorise(id)
  if (auth.error) return auth.error
  const { service } = auth

  let body: Body & Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  if (!body.entryId) {
    return Response.json({ error: 'entryId is required' }, { status: 400 })
  }

  const built = await buildUpdate(service, id, body)
  if ('error' in built) return built.error

  // A PATCH may name only some fields, so the overlap has to be tested against
  // what the row WILL be — merging the update over the row as it stands. Testing
  // the update alone would read an omitted valid_to as "open-ended" and reject
  // edits that change nothing about the dates.
  const { data: current } = await service
    .from('client_gst_registrations')
    .select('valid_from, valid_to, cost_centre_id')
    .eq('id', body.entryId)
    .eq('client_id', id)
    .maybeSingle()

  const merged = { ...(current ?? {}), ...built.update }
  if (await findOverlap(service, id, merged, body.entryId)) {
    return overlapResponse(Boolean(merged.cost_centre_id))
  }

  if (body.is_primary === true) await clearOtherPrimaries(service, id, body.entryId)

  const { data, error } = await service
    .from('client_gst_registrations')
    .update(built.update)
    .eq('id', body.entryId)
    // Scoped to the client as well as the row id: an entry id from another
    // client would otherwise be editable by anyone holding this one.
    .eq('client_id', id)
    .select(COLUMNS)
    .single()

  if (error) {
    if (error.code === '23P01') return overlapResponse(Boolean(merged.cost_centre_id))
    if (error.code === '23505') {
      return Response.json({ error: 'That GST number is already on file for this client' }, { status: 409 })
    }
    return Response.json({ error: error.message }, { status: 500 })
  }

  return Response.json({
    ok: true,
    registration: data,
    finding: gstinFinding(built.update.gstin as string | null, built.update.state as string | null),
  })
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const auth = await authorise(id)
  if (auth.error) return auth.error

  const entryId = new URL(req.url).searchParams.get('entryId')
  if (!entryId) {
    return Response.json({ error: 'entryId is required' }, { status: 400 })
  }

  const { error } = await auth.service
    .from('client_gst_registrations')
    .delete()
    .eq('id', entryId)
    .eq('client_id', id)

  if (error) return Response.json({ error: error.message }, { status: 500 })

  return Response.json({ ok: true })
}
