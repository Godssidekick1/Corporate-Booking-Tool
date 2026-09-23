import { describe, it, expect, beforeAll } from 'vitest'
import { requirePlatformAdmin } from './requirePlatformAdmin'
import { actAs } from '@/tests/harness/session'
import { actors, type Actors } from '@/tests/harness/actors'

// ── requirePlatformAdmin ─────────────────────────────────────────────────────
// The highest privilege in the system. Signed out is 401; signed in but not a
// platform admin is 404 -- deliberately not 403, which would confirm the
// surface exists.
// ─────────────────────────────────────────────────────────────────────────────

const HAS_DB = Boolean(process.env.DATABASE_URL)
const d = HAS_DB ? describe : describe.skip

d('requirePlatformAdmin', () => {
  let a: Actors
  beforeAll(async () => { a = await actors() })

  it('401 when signed out', async () => {
    actAs(null)
    expect(await requirePlatformAdmin()).toEqual({ ok: false, status: 401, error: 'Not authenticated' })
  })

  it('404, not 403, for a signed-in user who is not a platform admin', async () => {
    actAs(a.tmcAdmin)
    expect(await requirePlatformAdmin()).toEqual({ ok: false, status: 404, error: 'Not found' })
  })

  it('passes a platform admin, with their email', async () => {
    actAs({ id: a.platformAdmin!.id })
    const r = await requirePlatformAdmin()
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.admin.userId).toBe(a.platformAdmin!.id)
      expect(r.admin.email).toMatch(/@example\.test$/)
    }
  })
})
