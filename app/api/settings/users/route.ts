import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'

// ── GET /api/settings/users ──────────────────────────────────────────────────
// List all employees in the admin's client, for the settings/users table.

export async function GET() {
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

  const { data: employees, error } = await service
    .from('employees')
    .select('id, full_name, email, role, status, band_code, department, cost_centre, onboarding_method, manager_id, top_of_hierarchy')
    .eq('client_id', caller.client_id)
    .order('full_name')

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  return Response.json({ ok: true, employees: employees ?? [] })
}