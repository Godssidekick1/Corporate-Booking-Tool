import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// ── authAdmin ────────────────────────────────────────────────────────────────
// The four Supabase Auth (GoTrue) admin operations this application uses, and
// nothing else. Service-role key, server side only.
//
// This replaced utils/supabase/service.ts, which ALSO handed out `.from()` for
// data -- first to PostgREST, then to a compatibility shim over PostgreSQL.
// Data now goes through app/lib/repositories on `pg`, so nothing here can
// reach a table: the narrow type below is the point. A route wanting data from
// this module would have to be written against something that does not exist.
//
// Auth stays on GoTrue. It is a handful of calls with no multi-step invariant
// to protect, so there was never a reason to move it with the data.
//
// Tests replace this module wholesale (tests/harness/authAdmin.ts): nothing a
// test does may create a real account or send a real email.
// ─────────────────────────────────────────────────────────────────────────────

type Auth = SupabaseClient['auth']

export type AuthAdmin =
  Pick<Auth['admin'], 'createUser' | 'inviteUserByEmail' | 'deleteUser'> &
  Pick<Auth, 'resetPasswordForEmail'>

export function authAdmin(): AuthAdmin {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    throw new Error('[auth] NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must both be set')
  }

  const { auth } = createClient(url, key, {
    // A server-side admin client: no session to keep, nothing to refresh.
    auth: { autoRefreshToken: false, persistSession: false },
  })

  return {
    createUser: auth.admin.createUser.bind(auth.admin),
    inviteUserByEmail: auth.admin.inviteUserByEmail.bind(auth.admin),
    deleteUser: auth.admin.deleteUser.bind(auth.admin),
    resetPasswordForEmail: auth.resetPasswordForEmail.bind(auth),
  }
}
