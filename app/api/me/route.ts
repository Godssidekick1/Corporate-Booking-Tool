import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'

export async function GET() {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const service = createServiceClient()

  const { data: employee, error: employeeError } = await service
    .from('employees')
    .select(`
      id,
      full_name,
      email,
      role,
      status,
      company_id,
      tmc_id,
      band_id,
      band_code,
      band_rank,
      manager_id,
      department,
      cost_centre
    `)
    .eq('id', user.id)
    .single()

  if (employeeError || !employee) {
    return Response.json({ error: 'Employee profile not found' }, { status: 404 })
  }

  const isTmcSide = employee.role === 'tmc_admin' || employee.role === 'tc'

  const { data: company } = isTmcSide
    ? { data: null }
    : await service
        .from('companies')
        .select('id, name, settings, setup_completed, status, timezone, currency, country, booking_mode')
        .eq('id', employee.company_id)
        .single()

  const { count: employeeCount } = isTmcSide
    ? { count: 0 }
    : await service
        .from('employees')
        .select('id', { count: 'exact', head: true })
        .eq('company_id', employee.company_id)

  // For TCs, load their granted permissions and company access so the
  // frontend can render a restricted view of the TMC dashboard/settings.
  // tmc_admin has full access implicitly and never needs these checked.
  let permissions: string[] = []
  let companyAccess: string[] = []

  if (employee.role === 'tc') {
    const [{ data: perms }, { data: access }] = await Promise.all([
      service.from('employee_permissions').select('permission_key').eq('employee_id', employee.id),
      service.from('employee_company_access').select('company_id').eq('employee_id', employee.id),
    ])
    permissions = (perms ?? []).map(p => p.permission_key)
    companyAccess = (access ?? []).map(a => a.company_id)
  }

  return Response.json({
    ok: true,
    employee,
    company: company ?? null,
    employeeCount: employeeCount ?? 0,
    permissions,
    companyAccess,
  })
}