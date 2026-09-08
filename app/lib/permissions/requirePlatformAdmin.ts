import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'

type ServiceClient = ReturnType<typeof createServiceClient>

// ── requirePlatformAdmin ─────────────────────────────────────────────────────
// The gate on every /platform surface.
//
// Deliberately NOT built on requireTmcPermission. That function resolves an
// `employees` row and reasons about tenant roles; a platform admin has no
// employees row at all, and routing the highest privilege in the system through
// the same code path as the lowest is exactly the confusion this separation
// exists to prevent.
//
// The lookup always runs against the service client. platform_admins has RLS on
// with no policies, so an anon-key read returns nothing — which is the point,
// and also why this cannot be checked from the proxy or a client component.
// ─────────────────────────────────────────────────────────────────────────────

export interface PlatformAdmin {
  userId: string
  email: string | null
}

export async function isPlatformAdmin(
  service: ServiceClient,
  userId: string
): Promise<boolean> {
  const { data } = await service
    .from('platform_admins')
    .select('user_id')
    .eq('user_id', userId)
    .maybeSingle()

  return !!data
}

export type PlatformCheck =
  | { ok: true; service: ServiceClient; admin: PlatformAdmin }
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

  const service = createServiceClient()

  const { data: admin } = await service
    .from('platform_admins')
    .select('user_id, email')
    .eq('user_id', user.id)
    .maybeSingle()

  if (!admin) {
    return { ok: false, status: 404, error: 'Not found' }
  }

  return {
    ok: true,
    service,
    admin: { userId: admin.user_id, email: admin.email ?? user.email ?? null },
  }
}
