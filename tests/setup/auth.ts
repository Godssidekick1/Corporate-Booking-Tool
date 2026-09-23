import { vi, beforeEach } from 'vitest'
import { resetAuth } from '../harness/session'

// Every test file gets a fake Supabase SSR client with the auth calls routes
// make through it: getUser (every route), signInWithPassword and signOut (the
// sign-in route). Data never went through this client -- it authenticates --
// so nothing else needs faking.
vi.mock('@/utils/supabase/server', async () => {
  const s = await import('../harness/session')
  return {
    createClient: async () => ({
      auth: {
        getUser: async () => s.currentSession(),
        signInWithPassword: async () => s.signInResult(),
        signOut: async () => s.recordSignOut(),
      },
    }),
  }
})

// Signed out unless a test says otherwise, so no test inherits another's user.
beforeEach(() => resetAuth())
