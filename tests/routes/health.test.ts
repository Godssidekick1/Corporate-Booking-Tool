import { describe, it, expect, afterAll } from 'vitest'
import { GET as health } from '@/app/api/health/route'
import { getPool, closePool } from '@/app/lib/db/pool'
import { DbConfigurationError } from '@/app/lib/db/errors'

// ── GET /api/health ──────────────────────────────────────────────────────────
// What a deployment reports about itself, and that it never reports (or logs)
// a secret while doing it.
// ─────────────────────────────────────────────────────────────────────────────

const HAS_DB = Boolean(process.env.DATABASE_URL)
const d = HAS_DB ? describe : describe.skip

d('/api/health', () => {
  afterAll(async () => { await closePool() })

  it('a migrated database: everything sign-in needs is in place', async () => {
    const res = await health()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({
      ok: true,
      database: { ok: true },
      schema: { ok: true },
      passwordHashing: { ok: true },
      email: { transport: 'log' },
    })
    expect(body.schema.appliedMigrations).toBeGreaterThan(0)
  })

  it('a malformed DATABASE_URL is reported by code, and the password appears nowhere', async () => {
    const real = process.env.DATABASE_URL
    await closePool()
    process.env.DATABASE_URL = 'postgresql://user:sec/#ret@example.invalid:5432/db'
    try {
      expect(() => getPool()).toThrow(DbConfigurationError)
      try { getPool() } catch (err) {
        expect((err as DbConfigurationError).code).toBe('DATABASE_URL_INVALID')
        expect(String((err as Error).message)).not.toContain('sec/#ret')
      }
      const res = await health()
      expect(res.status).toBe(503)
      const text = await res.text()
      expect(text).toContain('DATABASE_URL_INVALID')
      expect(text).not.toContain('sec/#ret')
    } finally {
      process.env.DATABASE_URL = real
      await closePool()
    }
  })
})
