import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'

export async function GET() {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const service = createServiceClient()

  const { data: caller, error: callerError } = await service
    .from('employees')
    .select('role, tmc_id')
    .eq('id', user.id)
    .single()

  if (callerError || !caller || caller.role !== 'tmc_admin') {
    return Response.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { data: companies, error } = await service
    .from('companies')
    .select('id, name, status, settings, created_at')
    .eq('tmc_id', caller.tmc_id)
    .order('created_at', { ascending: false })

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  return Response.json({ ok: true, companies: companies ?? [] })
}