import { createHash } from 'node:crypto'

// ── A fake GoTrue admin API ──────────────────────────────────────────────────
// Routes that create people call service.auth.admin.inviteUserByEmail /
// createUser / deleteUser. Against the real Supabase project a test would
// create REAL accounts and send REAL invite emails -- so any test touching such
// a route mocks '@/utils/supabase/service' with this in place of `.auth`, and
// keeps the real data path:
//
//   vi.mock('@/utils/supabase/service', async (orig) => {
//     const actual = await orig<typeof import('@/utils/supabase/service')>()
//     const { fakeAuth } = await import('../harness/authAdmin')
//     return { ...actual, createServiceClient: () => ({ ...actual.createServiceClient(), auth: fakeAuth }) }
//   })
// ─────────────────────────────────────────────────────────────────────────────

export interface AuthCall {
  method: 'createUser' | 'inviteUserByEmail' | 'deleteUser' | 'resetPasswordForEmail'
  args: unknown[]
}

export const authCalls: AuthCall[] = []
let failNext: string | null = null

// Makes the next create/invite fail with GoTrue's message, e.g. an email that
// is already registered.
export function failNextAuthWith(message: string): void {
  failNext = message
}

// DETERMINISTIC ids, derived from the email. A random id here once made every
// list snapshot that included a newly created person differ on every run --
// the test passed the run that wrote the snapshot and failed every run after.
function idFor(email: string): string {
  const h = createHash('sha256').update(email.toLowerCase()).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`
}

function created(email: string) {
  if (failNext) {
    const message = failNext
    failNext = null
    return { data: { user: null }, error: { message, status: 422 } }
  }
  return { data: { user: { id: idFor(email), email } }, error: null }
}

export const fakeAuth = {
  admin: {
    createUser: async (opts: { email: string }) => {
      authCalls.push({ method: 'createUser', args: [opts] })
      return created(opts.email)
    },
    inviteUserByEmail: async (email: string, opts?: unknown) => {
      authCalls.push({ method: 'inviteUserByEmail', args: [email, opts] })
      return created(email)
    },
    deleteUser: async (id: string) => {
      authCalls.push({ method: 'deleteUser', args: [id] })
      return { data: {}, error: null }
    },
  },
  resetPasswordForEmail: async (email: string, opts?: unknown) => {
    authCalls.push({ method: 'resetPasswordForEmail', args: [email, opts] })
    return { data: {}, error: null }
  },
}
