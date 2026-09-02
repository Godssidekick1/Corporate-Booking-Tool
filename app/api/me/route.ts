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
      client_id,
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

  const { data: client } = isTmcSide
    ? { data: null }
    : await service
        .from('clients')
        .select('id, name, settings, setup_completed, status, timezone, currency, country, booking_mode')
        .eq('id', employee.client_id)
        .single()

  const { count: employeeCount } = isTmcSide
    ? { count: 0 }
    : await service
        .from('employees')
        .select('id', { count: 'exact', head: true })
        .eq('client_id', employee.client_id)

  // Client-wide, not just this employee's own bookings — the setup
  // checklist item is "has anyone at this client made a booking yet",
  // same scope as employeeCount above (client-level onboarding progress,
  // not a personal stat).
  const { count: bookingCount } = isTmcSide
    ? { count: 0 }
    : await service
        .from('bookings')
        .select('id', { count: 'exact', head: true })
        .eq('client_id', employee.client_id)

  // For TCs, load their granted permissions and client access so the
  // frontend can render a restricted view of the TMC dashboard/settings.
  // tmc_admin has full access implicitly and never needs these checked.
  let permissions: string[] = []
  let clientAccess: string[] = []

  if (employee.role === 'tc') {
    const [{ data: perms }, { data: access }] = await Promise.all([
      service.from('employee_permissions').select('permission_key').eq('employee_id', employee.id),
      service.from('employee_client_access').select('client_id').eq('employee_id', employee.id),
    ])
    permissions = (perms ?? []).map(p => p.permission_key)
    clientAccess = (access ?? []).map(a => a.client_id)
  }

  return Response.json({
    ok: true,
    employee,
    client: client ?? null,
    employeeCount: employeeCount ?? 0,
    hasBookings: (bookingCount ?? 0) > 0,
    permissions,
    clientAccess,
  })
}