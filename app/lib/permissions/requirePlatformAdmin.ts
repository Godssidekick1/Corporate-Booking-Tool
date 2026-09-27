import { currentUser } from '@/app/lib/auth/session'

// ── requirePlatformAdmin ─────────────────────────────────────────────────────
// The gate on every /platform surface.
//
// Deliberately NOT built on requireTmcPermission. That function resolves an
// `employees` row and reasons about tenant roles; a platform admin has no
// employees row at all, and routing the highest privilege in the system through
// the same code path as the lowest is exactly the confusion this separation
// exists to prevent.
//
// Membership comes from the session lookup itself (currentUser() reads
// platform_admins in the same query that resolves the session), so this costs
// no query of its own. platform_admins has RLS on with no policies, so only
// the application's own connection can read it.
// ─────────────────────────────────────────────────────────────────────────────

export interface PlatformAdmin {
  userId: string
  email: string | null
}

export type PlatformCheck =
  | { ok: true; admin: PlatformAdmin }
  | { ok: false; status: number; error: string }

// For route handlers and the /platform layout.
//
// A signed-in user who is not a platform admin gets 404, not 403. 403 confirms
// the surface exists and that they simply lack access, which tells an attacker
// where to aim; 404 says nothing. The distinction costs nothing here because a
// legitimate platform admin never sees either.
export async function requirePlatformAdmin(): Promise<PlatformCheck> {
  const me = await currentUser()

  if (!me) {
    return { ok: false, status: 401, error: 'Not authenticated' }
  }

  if (!me.isPlatformAdmin) {
    return { ok: false, status: 404, error: 'Not found' }
  }

  return { ok: true, admin: { userId: me.id, email: me.email } }
}
