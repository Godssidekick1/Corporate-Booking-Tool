import { createClient } from '@/utils/supabase/server'
import { db } from '@/app/lib/db'
import * as tmcs from '@/app/lib/repositories/tmcs'

// ── requirePlatformAdmin ─────────────────────────────────────────────────────
// The gate on every /platform surface.
//
// Deliberately NOT built on requireTmcPermission. That function resolves an
// `employees` row and reasons about tenant roles; a platform admin has no
// employees row at all, and routing the highest privilege in the system through
// the same code path as the lowest is exactly the confusion this separation
// exists to prevent.
//
// platform_admins has RLS on with no policies, so only a privileged connection
// can read it -- which is also why this cannot be checked from the proxy or a
// client component.
// ─────────────────────────────────────────────────────────────────────────────

export interface PlatformAdmin {
  userId: string
  email: string | null
}

export type PlatformCheck =
  | { ok: true; admin: PlatformAdmin }
  | { ok: false; status: number; error: string }

// For route handlers. Resolves the session, then membership.
//
// A signed-in user who is not a platform admin gets 404, not 403. 403 confirms
// the surface exists and that they simply lack access, which tells an attacker
// where to aim; 404 says nothing. The distinction costs nothing here because a
// legitimate platform admin never sees either.
export async function requirePlatformAdmin(): Promise<PlatformCheck> {
  const supabase = await createClient()
  const { data: { user }, error } = await supabase.auth.getUser()

  if (error || !user) {
    return { ok: false, status: 401, error: 'Not authenticated' }
  }

  const admin = await tmcs.platformAdmin(db, user.id)

  if (!admin) {
    return { ok: false, status: 404, error: 'Not found' }
  }

  return {
    ok: true,
    admin: { userId: admin.user_id, email: admin.email ?? user.email ?? null },
  }
}
