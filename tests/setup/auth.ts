import { vi, beforeEach } from 'vitest'
import { actAs } from '../harness/session'

// Every test file gets a fake Supabase SSR client whose only capability is the
// one routes use: auth.getUser(). Data never went through this client -- it
// authenticates -- so nothing else needs faking.
vi.mock('@/utils/supabase/server', async () => {
  const { currentSession } = await import('../harness/session')
  return {
    createClient: async () => ({
      auth: { getUser: async () => currentSession() },
    }),
  }
})

// Signed out unless a test says otherwise, so no test inherits another's user.
beforeEach(() => actAs(null))
