import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { parsePageParams, pagedResponse, ilikeAcross } from '@/app/lib/pagination'
import { NextRequest } from 'next/server'

// ── GET /api/settings/users ──────────────────────────────────────────────────
// List all employees in the admin's client, for the settings/users table.

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const service = createServiceClient()

  const { data: caller, error: callerError } = await service
    .from('employees')
    .select('client_id, role')
    .eq('id', user.id)
    .single()

  if (callerError || !caller) {
    return Response.json({ error: 'Employee record not found' }, { status: 404 })
  }

  if (caller.role !== 'admin') {
    return Response.json({ error: 'Only admins can view the user list' }, { status: 403 })
  }

  const params = parsePageParams(req.nextUrl.searchParams)
  const ids = req.nextUrl.searchParams.get('ids')?.split(',').filter(Boolean) ?? []

  // The hierarchy screen renders a reporting TREE, which needs every node to
  // resolve manager_id to a name — a tree built from ten rows is not a tree,
  // it is ten disconnected fragments. So it opts out of paging.
  //
  // Capped rather than unbounded: this is an escape hatch for one view with a
  // genuine structural need, not a way for any caller to ask for everything.
  const wantsAll = req.nextUrl.searchParams.get('all') === 'true'
  const ALL_CAP = 1000

  let query = service
    .from('employees')
    .select(
      'id, full_name, email, role, status, band_code, department, cost_centre, onboarding_method, manager_id, top_of_hierarchy',
      { count: 'exact' }
    )
    .eq('client_id', caller.client_id)
    .order('full_name')

  if (ids.length > 0) {
    query = query.in('id', ids)
  } else if (wantsAll) {
    query = query.range(0, ALL_CAP - 1)
  } else {
    const filter = ilikeAcross(['full_name', 'email', 'department', 'cost_centre'], params.search)
    if (filter) query = query.or(filter)
    query = query.range(params.from, params.to)
  }

  const { data: employees, error, count } = await query

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  return Response.json(pagedResponse(employees ?? [], count ?? null, params))
}