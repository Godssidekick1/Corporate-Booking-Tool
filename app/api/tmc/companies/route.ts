import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { requireTmcPermission, getAccessibleCompanyIds } from '@/app/lib/permissions/requireTmcPermission'

export async function GET() {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const service = createServiceClient()

  // Any TMC-side caller (tmc_admin or tc) can view companies — access to
  // WHICH companies is filtered below, not gated by a specific permission key.
  const { data: caller } = await service
    .from('employees')
    .select('role, tmc_id')
    .eq('id', user.id)
    .single()

  if (!caller || !caller.tmc_id || (caller.role !== 'tmc_admin' && caller.role !== 'tc')) {
    return Response.json({ error: 'Forbidden' }, { status: 403 })
  }

  const accessibleIds = await getAccessibleCompanyIds(service, user.id, caller.role)

  let query = service
    .from('companies')
    .select('id, name, status, setup_completed, created_at, booking_mode, client_group_id, client_groups(id, name, city)')
    .eq('tmc_id', caller.tmc_id)
    .order('created_at', { ascending: false })

  if (accessibleIds !== null) {
    if (accessibleIds.length === 0) {
      return Response.json({ ok: true, companies: [] })
    }
    query = query.in('id', accessibleIds)
  }

  const { data: companies, error } = await query

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  // Headcount per client, for the nav and the client list. Counted in one query
  // over the whole set rather than per company, since this runs on every page
  // load that renders the shell. Deactivated people are excluded — the number
  // is meant to read as "how big is this client", not how many rows exist.
  const companyIds = (companies ?? []).map(c => c.id)
  const employeeCounts = new Map<string, number>()

  if (companyIds.length > 0) {
    const { data: employees } = await service
      .from('employees')
      .select('company_id, status')
      .in('company_id', companyIds)

    for (const e of employees ?? []) {
      if (e.status === 'deactivated') continue
      employeeCounts.set(e.company_id, (employeeCounts.get(e.company_id) ?? 0) + 1)
    }
  }

  return Response.json({
    ok: true,
    companies: (companies ?? []).map(c => ({
      ...c,
      employeeCount: employeeCounts.get(c.id) ?? 0,
    })),
  })
}