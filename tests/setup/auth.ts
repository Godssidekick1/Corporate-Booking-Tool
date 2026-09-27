import { vi, beforeEach } from 'vitest'
import { resetAuth } from '../harness/session'

// Route handlers find their caller with currentUser() (app/lib/auth/session),
// which reads the session cookie through next/headers' cookies(). Outside a
// real request there is no cookie store, so this supplies one per call: for
// whoever the test is acting as (harness/session actAs), a real session row in
// cbt_test and its token as the cookie. Setting cookies is a no-op here; the
// routes that set them do so on the Response, which tests can read.
vi.mock('next/headers', async importOriginal => {
  const actual = await importOriginal<typeof import('next/headers')>()
  return {
    ...actual,
    cookies: async () => {
      const { sessionTokenForCurrentUser } = await import('../harness/session')
      const { SESSION_COOKIE } = await import('@/app/lib/auth/session')
      const token = await sessionTokenForCurrentUser()
      const all = token ? [{ name: SESSION_COOKIE, value: token }] : []
      return {
        get: (name: string) => all.find(c => c.name === name),
        getAll: () => all,
        has: (name: string) => all.some(c => c.name === name),
        set: () => {},
        delete: () => {},
      }
    },
  }
})

// New account ids, derived from the email instead of random: snapshots include
// the ids of people a test creates. (The same derivation the GoTrue fake used,
// so snapshots recorded against it still hold.)
vi.mock('@/app/lib/auth/ids', async () => {
  const { createHash } = await import('node:crypto')
  return {
    newAccountId: (email: string) => {
      const h = createHash('sha256').update(email.toLowerCase()).digest('hex')
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`
    },
  }
})

// Signed out unless a test says otherwise, so no test inherits another's user.
beforeEach(() => resetAuth())
