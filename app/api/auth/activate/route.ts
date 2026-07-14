import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'

// ── POST /api/auth/activate ──────────────────────────────────────────────────
// Called by the client right after a first-time password set. Flips the
// caller's own employee row from 'invited' to 'active'. No-op if already active.

export async function POST() {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const service = createServiceClient()

  const { data: employee } = await service
    .from('employees')
    .select('status')
    .eq('id', user.id)
    .single()

  if (employee?.status === 'invited') {
    await service
      .from('employees')
      .update({ status: 'active' })
      .eq('id', user.id)
  }

  return Response.json({ ok: true })
}