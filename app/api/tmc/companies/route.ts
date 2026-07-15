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
    .select('id, name, status, setup_completed, created_at, booking_mode, branch_id, branches(id, name, city)')
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

  return Response.json({ ok: true, companies: companies ?? [] })
}