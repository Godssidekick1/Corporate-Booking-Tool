import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'

export async function POST() {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const service = createServiceClient()

  const { data: employee, error: empError } = await service
    .from('employees')
    .select('company_id, role')
    .eq('id', user.id)
    .single()

  if (empError || !employee) {
    return Response.json({ error: 'Employee record not found' }, { status: 404 })
  }

  if (employee.role !== 'admin') {
    return Response.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { error } = await service
    .from('companies')
    .update({
      setup_completed: true,
      setup_completed_at: new Date().toISOString(),
      status: 'active',
    })
    .eq('id', employee.company_id)

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  return Response.json({ ok: true })
}