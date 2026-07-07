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

  const { data: company } = await service
    .from('companies')
    .select('id, name, settings')
    .eq('id', employee.company_id)
    .single()

  return Response.json({ ok: true, employee, company: company ?? null })
}