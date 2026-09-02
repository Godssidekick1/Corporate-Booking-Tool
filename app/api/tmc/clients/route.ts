import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { getAccessibleClientIds } from '@/app/lib/permissions/requireTmcPermission'

export async function GET() {
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

  let query = service
    .from('clients')
    .select('id, name, status, setup_completed, created_at, booking_mode, client_group_id, client_groups(id, name, city)')
    .eq('tmc_id', caller.tmc_id)
    .order('created_at', { ascending: false })

  if (accessibleIds !== null) {
    if (accessibleIds.length === 0) {
      return Response.json({ ok: true, clients: [] })
    }
    query = query.in('id', accessibleIds)
  }

  const { data: clients, error } = await query

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

  return Response.json({
    ok: true,
    clients: (clients ?? []).map(c => ({
      ...c,
      employeeCount: employeeCounts.get(c.id) ?? 0,
    })),
  })
}