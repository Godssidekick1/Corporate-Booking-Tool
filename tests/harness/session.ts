// ── Who the test is signed in as ─────────────────────────────────────────────
// Read by the mocked utils/supabase/server (tests/setup/auth.ts). Route
// handlers call `(await createClient()).auth.getUser()`; this decides what that
// returns, so a test can run a handler as any user -- or as nobody.
// ─────────────────────────────────────────────────────────────────────────────

export interface TestUser {
  id: string
  email?: string | null
  user_metadata?: Record<string, unknown>
  app_metadata?: Record<string, unknown>
}

let current: TestUser | null = null

export function actAs(user: TestUser | null): void {
  current = user
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
  return {
    data: {
      user: {
        id: current.id,
        email: current.email ?? undefined,
        aud: 'authenticated',
        role: 'authenticated',
        user_metadata: current.user_metadata ?? {},
        app_metadata: current.app_metadata ?? {},
      },
    },
    error: null,
  }
}
