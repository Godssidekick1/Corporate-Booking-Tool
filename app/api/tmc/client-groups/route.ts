import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { requireTmcPermission } from '@/app/lib/permissions/requireTmcPermission'
import { parsePageParams, pagedResponse, ilikeAcross } from '@/app/lib/pagination'
import { NextRequest } from 'next/server'

// ── GET /api/tmc/client-groups ────────────────────────────────────────────────
// List all client groups for this TMC. Any TMC-side caller can view.
//
// ── POST /api/tmc/client-groups ───────────────────────────────────────────────
// Create a new client group. Requires manage_client_groups permission (or tmc_admin).
// ─────────────────────────────────────────────────────────────────────────────

interface CreateClientGroupBody {
  name: string
  city?: string
  country?: string
}

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const service = createServiceClient()

  const { data: caller } = await service
    .from('employees')
    .select('role, tmc_id')
    .eq('id', user.id)
    .single()

  if (!caller || !caller.tmc_id || (caller.role !== 'tmc_admin' && caller.role !== 'tc')) {
    return Response.json({ error: 'Forbidden' }, { status: 403 })
  }

  const params = parsePageParams(req.nextUrl.searchParams)
  const ids = req.nextUrl.searchParams.get('ids')?.split(',').filter(Boolean) ?? []

  let query = service
    .from('client_groups')
    .select('id, name, city, country, created_at', { count: 'exact' })
    .eq('tmc_id', caller.tmc_id)
    .order('name')

  if (ids.length > 0) {
    query = query.in('id', ids)
  } else {
    const filter = ilikeAcross(['name', 'city'], params.search)
    if (filter) query = query.or(filter)
    query = query.range(params.from, params.to)
  }

  const { data: clientGroups, error, count } = await query

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  return Response.json(pagedResponse(clientGroups ?? [], count ?? null, params))
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const service = createServiceClient()

  const auth = await requireTmcPermission(service, user.id, 'manage_client_groups')
  if (!auth.authorized) {
    return Response.json({ error: auth.error }, { status: auth.status ?? 403 })
  }

  const body: CreateClientGroupBody = await req.json()
  const { name, city, country } = body

  if (!name?.trim()) {
    return Response.json({ error: 'Client group name is required' }, { status: 400 })
  }

  const { data: clientGroup, error } = await service
    .from('client_groups')
    .insert({
      tmc_id: auth.tmcId,
      name: name.trim(),
      city: city?.trim() || null,
      country: country?.trim() || null,
    })
    .select('id, name, city, country, created_at')
    .single()

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  return Response.json({ ok: true, clientGroup }, { status: 201 })
}