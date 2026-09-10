import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { requireTmcPermission } from '@/app/lib/permissions/requireTmcPermission'
import { NextRequest } from 'next/server'

// ── /api/tmc/clients/[id]/mandatory-info ─────────────────────────────────────
// The entries a booking for this client must carry, and the GDS command each
// one goes into.
//
// RECORDED, NOT TRANSMITTED. Like deal codes and forms of payment, nothing here
// reaches the aggregator — searchFlights and addPassenger have no field for an
// OSI or SSR entry. This is what a counsellor keys manually and what
// reconciliation checks against, and no copy on the screen may suggest
// otherwise.
//
// GET returns everything for the client rather than a page: a client has a
// handful of these, and the editor needs them all at once to show which are
// mandatory.
// ─────────────────────────────────────────────────────────────────────────────

interface MandatoryInfoBody {
  id?: string
  code?: string
  description?: string | null
  type?: string | null
  gds_entry?: string | null
  value_prefix?: string | null
  is_mandatory?: boolean
}

const COLUMNS = 'id, code, description, type, gds_entry, value_prefix, is_mandatory, created_at'

async function authorise(userId: string, clientId: string) {
  const service = createServiceClient()
  const auth = await requireTmcPermission(service, userId, 'manage_clients', clientId)

  if (!auth.authorized || !auth.tmcId) {
    return { ok: false as const, error: auth.error ?? 'Forbidden', status: auth.status ?? 403 }
  }

  const { data: client } = await service
    .from('clients')
    .select('id, tmc_id')
    .eq('id', clientId)
    .maybeSingle()

  if (!client || client.tmc_id !== auth.tmcId) {
    return { ok: false as const, error: 'Client not found for this TMC', status: 404 }
  }

  return { ok: true as const, service }
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const check = await authorise(user.id, id)
  if (!check.ok) {
    return Response.json({ error: check.error }, { status: check.status })
  }

  const { data: entries, error } = await check.service
    .from('client_mandatory_info')
    .select(COLUMNS)
    .eq('client_id', id)
    .order('code')

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  return Response.json({ ok: true, entries: entries ?? [] })
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const check = await authorise(user.id, id)
  if (!check.ok) {
    return Response.json({ error: check.error }, { status: check.status })
  }

  const body: MandatoryInfoBody = await req.json()
  const code = body.code?.trim().toUpperCase()

  if (!code) {
    return Response.json({ error: 'A mandatory entry needs a code' }, { status: 400 })
  }

  const row = {
    client_id: id,
    code,
    description: body.description?.trim() || null,
    type: body.type?.trim() || null,
    // Uppercased: GDS entries are typed in caps, and a lowercase copy would not
    // match what a counsellor sees on their own screen.
    gds_entry: body.gds_entry?.trim().toUpperCase() || null,
    value_prefix: body.value_prefix?.trim() || null,
    is_mandatory: body.is_mandatory !== false,
  }

  // Upserted on (client_id, code) so re-saving an entry edits it rather than
  // failing on the unique constraint — the code IS the identity here, and
  // making someone delete-then-recreate to fix a typo is friction with no
  // safety in it.
  const { data: saved, error } = await check.service
    .from('client_mandatory_info')
    .upsert(row, { onConflict: 'client_id,code' })
    .select(COLUMNS)
    .single()

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  return Response.json({ ok: true, entry: saved })
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const check = await authorise(user.id, id)
  if (!check.ok) {
    return Response.json({ error: check.error }, { status: check.status })
  }

  const entryId = req.nextUrl.searchParams.get('entryId')
  if (!entryId) {
    return Response.json({ error: 'entryId is required' }, { status: 400 })
  }

  // Scoped by client_id in the delete itself rather than checked first, so there
  // is no window between the check and the write.
  const { error } = await check.service
    .from('client_mandatory_info')
    .delete()
    .eq('id', entryId)
    .eq('client_id', id)

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  return Response.json({ ok: true })
}
