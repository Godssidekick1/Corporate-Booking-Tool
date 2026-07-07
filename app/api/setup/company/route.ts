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
    return Response.json({ error: 'Only admins can confirm company setup' }, { status: 403 })
  }

  const { data: company } = await service
    .from('companies')
    .select('settings')
    .eq('id', employee.company_id)
    .single()

  const { error: updateError } = await service
    .from('companies')
    .update({
      settings: {
        ...(company?.settings ?? {}),
        setup_confirmed: true,
        setup_confirmed_at: new Date().toISOString(),
      },
    })
    .eq('id', employee.company_id)

  if (updateError) {
    return Response.json({ error: updateError.message }, { status: 500 })
  }

  return Response.json({ ok: true })
}