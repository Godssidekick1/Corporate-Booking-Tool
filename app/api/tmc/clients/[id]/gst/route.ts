import { createClient } from '@/utils/supabase/server'
import { requireTmcPermission } from '@/app/lib/permissions/requireTmcPermission'
import { gstinFinding } from '@/app/lib/data/gstin'
import { NextRequest } from 'next/server'
import { db, transaction, isConstraint } from '@/app/lib/db'
import * as clients from '@/app/lib/repositories/clients'
import { route } from '@/app/lib/http/handler'

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

type Ctx = { params: Promise<{ id: string }> }

async function authorise(clientId: string) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) {
    return { error: Response.json({ error: 'Not authenticated' }, { status: 401 }) }
  }

  const check = await requireTmcPermission(db, user.id, 'manage_clients', clientId)
  if (!check.authorized || !check.tmcId) {
    return { error: Response.json({ error: check.error ?? 'Forbidden' }, { status: check.status ?? 403 }) }
  }

  if (!(await clients.statusInTmc(db, clientId, check.tmcId))) {
    return { error: Response.json({ error: 'Client not found' }, { status: 404 }) }
  }

  return { tmcId: check.tmcId, userId: user.id }
}

// Shared by POST and PATCH. Returns either the column updates or a Response to
// send instead, so both verbs validate identically — a cost centre that may be
// set on create but not on edit is the kind of gap nobody notices.
async function buildUpdate(
  clientId: string,
  body: Record<string, unknown>
): Promise<{ update: clients.GstFields } | { error: Response }> {
  const update: clients.GstFields = {}
  const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '') || null

  if (body.gstin !== undefined) {
    update.gstin = (typeof body.gstin === 'string' ? body.gstin.trim().toUpperCase() : '') || null
  }

  for (const field of TEXT_FIELDS) {
    if (body[field] !== undefined) update[field] = text(body[field])
  }

  for (const field of DATE_FIELDS) {
    if (body[field] !== undefined) update[field] = text(body[field])
  }

  // The cost centre must belong to THIS client. cost_centres is a plain FK, so
  // another client's centre satisfies the constraint and would put this
  // corporate's invoices under someone else's accounting code.
  if (body.cost_centre_id !== undefined) {
    const value = body.cost_centre_id
    if (!value) {
      update.cost_centre_id = null
    } else {
      if (typeof value !== 'string' || !(await clients.costCentreBelongs(db, value, clientId))) {
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

const DUPLICATE_GSTIN = { error: 'That GST number is already on file for this client' }

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
  clientId: string,
  window: Pick<clients.GstFields, 'valid_from' | 'valid_to' | 'cost_centre_id'>,
  excludeId: string | null
): Promise<boolean> {
  const siblings = await clients.gstSiblings(db, clientId, window.cost_centre_id ?? null, excludeId)
  const from = window.valid_from ?? null
  const to = window.valid_to ?? null
  return siblings.some(row => windowsOverlap(from, to, row.valid_from, row.valid_to))
}

// Maps the two constraint violations a write here can hit to what they mean.
function constraintResponse(err: unknown, centred: boolean): Response | null {
  if (isConstraint(err, 'exclusion')) return overlapResponse(centred)
  if (isConstraint(err, 'unique')) return Response.json(DUPLICATE_GSTIN, { status: 409 })
  return null
}

export const GET = route(async (_req: NextRequest, { params }: Ctx) => {
  const { id } = await params
  const auth = await authorise(id)
  if (auth.error) return auth.error

  return Response.json({ ok: true, registrations: await clients.gstRegistrations(db, id) })
})

export const POST = route(async (req: NextRequest, { params }: Ctx) => {
  const { id } = await params
  const auth = await authorise(id)
  if (auth.error) return auth.error

  let body: Body & Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const built = await buildUpdate(id, body)
  if ('error' in built) return built.error
  const { update } = built

  if (await findOverlap(id, update, null)) {
    return overlapResponse(Boolean(update.cost_centre_id))
  }

  try {
    // Only one registration per client may be primary (partial unique index).
    // Clearing the others FIRST means the index never sees two at once; doing
    // both in one transaction means a rejected insert does not leave the client
    // with no primary at all.
    const registration = await transaction(async tx => {
      if (body.is_primary === true) await clients.clearOtherPrimaries(tx, id, null)
      return clients.insertGst(tx, id, update)
    }, { tenantId: auth.tmcId, userId: auth.userId })

    return Response.json({
      ok: true,
      registration,
      finding: gstinFinding(update.gstin ?? null, update.state ?? null),
    })
  } catch (err) {
    const answer = constraintResponse(err, Boolean(update.cost_centre_id))
    if (answer) return answer
    throw err
  }
})

export const PATCH = route(async (req: NextRequest, { params }: Ctx) => {
  const { id } = await params
  const auth = await authorise(id)
  if (auth.error) return auth.error

  let body: Body & Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const entryId = body.entryId
  if (!entryId) {
    return Response.json({ error: 'entryId is required' }, { status: 400 })
  }

  const built = await buildUpdate(id, body)
  if ('error' in built) return built.error
  const { update } = built

  if (Object.keys(update).length === 0) {
    return Response.json({ error: 'No fields to update' }, { status: 400 })
  }

  // A PATCH may name only some fields, so the overlap has to be tested against
  // what the row WILL be — merging the update over the row as it stands. Testing
  // the update alone would read an omitted valid_to as "open-ended" and reject
  // edits that change nothing about the dates.
  const current = await clients.gstWindow(db, entryId, id)
  const merged = {
    valid_from: current?.valid_from ?? null,
    valid_to: current?.valid_to ?? null,
    cost_centre_id: current?.cost_centre_id ?? null,
    ...update,
  }
  if (await findOverlap(id, merged, entryId)) {
    return overlapResponse(Boolean(merged.cost_centre_id))
  }

  let registration: clients.GstRegistration | null
  try {
    // Scoped to the client as well as the row id: an entry id from another
    // client would otherwise be editable by anyone holding this one.
    registration = await transaction(async tx => {
      if (body.is_primary === true) await clients.clearOtherPrimaries(tx, id, entryId)
      return clients.updateGst(tx, entryId, id, update)
    }, { tenantId: auth.tmcId, userId: auth.userId })
  } catch (err) {
    const answer = constraintResponse(err, Boolean(merged.cost_centre_id))
    if (answer) return answer
    throw err
  }

  if (!registration) {
    return Response.json({ error: 'Registration not found' }, { status: 404 })
  }

  return Response.json({
    ok: true,
    registration,
    finding: gstinFinding(update.gstin ?? null, update.state ?? null),
  })
})

export const DELETE = route(async (req: NextRequest, { params }: Ctx) => {
  const { id } = await params
  const auth = await authorise(id)
  if (auth.error) return auth.error

  const entryId = new URL(req.url).searchParams.get('entryId')
  if (!entryId) {
    return Response.json({ error: 'entryId is required' }, { status: 400 })
  }

  await clients.deleteGst(db, entryId, id)

  return Response.json({ ok: true })
})
