import { createClient } from '@/utils/supabase/server'
import { db } from '@/app/lib/db'
import * as employees from '@/app/lib/repositories/employees'
import { route } from '@/app/lib/http/handler'

// ── POST /api/auth/activate ──────────────────────────────────────────────────
// Called by the client right after a first-time password set. Flips the
// caller's own employee row from 'invited' to 'active'. No-op if already active.

export const POST = route(async () => {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  await employees.activateIfInvited(db, user.id)

  return Response.json({ ok: true })
})
