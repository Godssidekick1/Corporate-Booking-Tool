import { describe, it, expect, beforeAll, vi } from 'vitest'
import { db } from '@/app/lib/db'
import { sql, maybeOne } from '@/app/lib/db/sql'
import { resetDatabase } from '@/tests/harness/db'

// ── Amadeus session store ────────────────────────────────────────────────────
// A singleton row with an in-process memo in front of it. The memo is module
// state, so each case that needs to exercise the DATABASE read re-imports the
// module fresh.
// ─────────────────────────────────────────────────────────────────────────────

const HAS_DB = Boolean(process.env.DATABASE_URL)
const d = HAS_DB ? describe : describe.skip

const fresh = async () => {
  vi.resetModules()
  return await import('./sessionStore')
}

const row = () =>
  maybeOne<{ session_id: string; expires_at: string }>(db, sql`select session_id, expires_at from amadeus_session where id = 1`)

d('sessionStore', () => {
  beforeAll(resetDatabase)

  it('set -> get returns the session, and persists it', async () => {
    const store = await fresh()
    await store.setCachedSession('sess-abc')

    expect((await store.getCachedSession())?.sessionId).toBe('sess-abc')
    expect((await row())?.session_id).toBe('sess-abc')
  })

  it('a cold process reads the persisted row', async () => {
    const store = await fresh()
    const got = await store.getCachedSession()
    expect(got?.sessionId).toBe('sess-abc')
    expect(got!.expiresAt).toBeGreaterThan(Date.now())
  })

  it('clear removes the row and the memo', async () => {
    const store = await fresh()
    await store.setCachedSession('sess-xyz')
    await store.clearCachedSession()

    expect(await row()).toBeNull()
    expect(await store.getCachedSession()).toBeNull()
  })

  it('an expired row is not handed out', async () => {
    // A defect this test found: the DB read path used to return the row even
    // when it had expired. The module's own comment explains why that is wrong
    // -- a stale session id produces "Session Expired" and a costly retry --
    // but the check was applied only to the in-process memo, not to the row.
    await db.query("insert into amadeus_session (id, session_id, expires_at, updated_at) values (1, 'old', now() - interval '1 minute', now()) on conflict (id) do update set session_id = 'old', expires_at = now() - interval '1 minute'")
    const store = await fresh()
    expect(await store.getCachedSession()).toBeNull()
  })
})
