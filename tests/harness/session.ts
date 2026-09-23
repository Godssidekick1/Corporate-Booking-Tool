// ── Who the test is signed in as ─────────────────────────────────────────────
// Read by the mocked utils/supabase/server (tests/setup/auth.ts). Route
// handlers call `(await createClient()).auth.getUser()`; this decides what that
// returns, so a test can run a handler as any user -- or as nobody.
//
// Also drives the two other auth calls routes make through that client:
// signInWithPassword (the sign-in route) and signOut (which that route calls to
// refuse an account after credentials were accepted).
// ─────────────────────────────────────────────────────────────────────────────

export interface TestUser {
  id: string
  email?: string | null
  user_metadata?: Record<string, unknown>
  app_metadata?: Record<string, unknown>
}

let current: TestUser | null = null
let signInAs: TestUser | null = null
let signOuts = 0

export function actAs(user: TestUser | null): void {
  current = user
}

// Whom the next signInWithPassword succeeds as; null makes it fail with the
// message GoTrue returns for bad credentials.
export function acceptSignInAs(user: TestUser | null): void {
  signInAs = user
}

export function signOutCount(): number {
  return signOuts
}

export function resetAuth(): void {
  current = null
  signInAs = null
  signOuts = 0
}

function asSupabaseUser(u: TestUser) {
  return {
    id: u.id,
    email: u.email ?? undefined,
    aud: 'authenticated',
    role: 'authenticated',
    user_metadata: u.user_metadata ?? {},
    app_metadata: u.app_metadata ?? {},
  }
}

// The same shape supabase-js returns, including the no-session error, so a
// route's `if (authError || !user)` branch runs exactly as it does for real.
export function currentSession() {
  if (!current) {
    return {
      data: { user: null },
      error: { name: 'AuthSessionMissingError', message: 'Auth session missing!', status: 400 },
    }
  }
  return { data: { user: asSupabaseUser(current) }, error: null }
}

export function signInResult() {
  if (!signInAs) {
    return { data: { user: null, session: null }, error: { name: 'AuthApiError', message: 'Invalid login credentials', status: 400 } }
  }
  current = signInAs
  return { data: { user: asSupabaseUser(signInAs), session: {} }, error: null }
}

export function recordSignOut() {
  signOuts++
  current = null
  return { error: null }
}
