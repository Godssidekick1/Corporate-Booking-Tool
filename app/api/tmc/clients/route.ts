import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { getAccessibleClientIds } from '@/app/lib/permissions/requireTmcPermission'
import { parsePageParams, pagedResponse, ilikeAcross } from '@/app/lib/pagination'
import { NextRequest } from 'next/server'

// ── GET /api/tmc/clients ─────────────────────────────────────────────────────
// Paged. Serves both the clients table and every client picker in the app, so
// it takes `search` (server-side, spanning the whole set) and `ids` (resolve
// specific rows by id).
//
// `ids` exists for pickers: once a selection has been made and the search moves
// on, the selected client is no longer in the current page of results, and a
// picker that derives its label from the visible list would blank itself. The
// caller asks for that one row back instead.
// ─────────────────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const service = createServiceClient()

  // Any TMC-side caller (tmc_admin or tc) can view clients — access to
  // WHICH clients is filtered below, not gated by a specific permission key.
  const { data: caller } = await service
    .from('employees')
    .select('role, tmc_id')
    .eq('id', user.id)
    .single()

  if (!caller || !caller.tmc_id || (caller.role !== 'tmc_admin' && caller.role !== 'tc')) {
    return Response.json({ error: 'Forbidden' }, { status: 403 })
  }

  const accessibleIds = await getAccessibleClientIds(service, user.id, caller.role)
  const params = parsePageParams(req.nextUrl.searchParams)
  const ids = req.nextUrl.searchParams.get('ids')?.split(',').filter(Boolean) ?? []

  let query = service
    .from('clients')
    .select(
      'id, name, status, setup_completed, created_at, booking_mode, client_group_id, client_groups(id, name, city)',
      { count: 'exact' }
    )
    .eq('tmc_id', caller.tmc_id)
    .order('created_at', { ascending: false })

  if (accessibleIds !== null) {
    if (accessibleIds.length === 0) {
      return Response.json(pagedResponse([], 0, params))
    }
    query = query.in('id', accessibleIds)
  }

  if (ids.length > 0) {
    // Resolving specific rows for a picker's label — not a page of results, so
    // the range below is skipped and the caller gets exactly what it asked for.
    query = query.in('id', ids)
  } else {
    const filter = ilikeAcross(['name'], params.search)
    if (filter) query = query.or(filter)
    query = query.range(params.from, params.to)
  }

  const { data: clients, error, count } = await query

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  // Headcount per client, for the nav and the client list. Counted in one query
  // over the whole set rather than per client, since this runs on every page
  // load that renders the shell. Deactivated people are excluded — the number
  // is meant to read as "how big is this client", not how many rows exist.
  const clientIds = (clients ?? []).map(c => c.id)
  const employeeCounts = new Map<string, number>()

  if (clientIds.length > 0) {
    const { data: employees } = await service
      .from('employees')
      .select('client_id, status')
      .in('client_id', clientIds)

    for (const e of employees ?? []) {
      if (e.status === 'deactivated') continue
      employeeCounts.set(e.client_id, (employeeCounts.get(e.client_id) ?? 0) + 1)
    }
  }

  return Response.json(
    pagedResponse(
      (clients ?? []).map(c => ({ ...c, employeeCount: employeeCounts.get(c.id) ?? 0 })),
      count ?? null,
      params
    )
  )
}