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

// The GoTrue admin API, faked for EVERY file rather than per file. It creates
// real accounts and sends real emails, and .env.local holds real keys -- so a
// test file that forgot to mock it would do exactly that. Global, it cannot be
// forgotten. Tests inspect what was called through harness/authAdmin.
vi.mock('@/utils/supabase/admin', async () => {
  const { fakeAuthAdmin } = await import('../harness/authAdmin')
  return { authAdmin: () => fakeAuthAdmin }
})

// Signed out unless a test says otherwise, so no test inherits another's user.
beforeEach(() => resetAuth())
