import { describe, it, expect, afterAll } from 'vitest'
import { createServiceClient } from '@/utils/supabase/service'
import { QueryBuilder } from './builder'
import { closePool } from './pool'

// ── The swap point ───────────────────────────────────────────────────────────
// utils/supabase/service.ts is the single file that decides where the 537 call
// sites' data goes. Everything else in this directory can be correct and the
// application still talk to PostgREST if this one function is wired wrong --
// and nothing else would notice, because both drivers return { data, error }.
//
// So: assert the wiring directly, not just the pieces it wires.
// ─────────────────────────────────────────────────────────────────────────────

const HAS_DB = Boolean(process.env.DATABASE_URL)
const d = HAS_DB ? describe : describe.skip

d('createServiceClient', () => {
  afterAll(async () => { await closePool() })

  it('routes data to PostgreSQL, not PostgREST', async () => {
    const service = createServiceClient()

    // The identity check. A PostgREST builder would also be thenable and also
    // resolve to { data, error }, so only the type distinguishes them.
    expect(service.from('airlines')).toBeInstanceOf(QueryBuilder)
  })

  it('actually reads rows through that path', async () => {
    const service = createServiceClient()
    const { data, error } = await service.from('airlines').select('code, name').limit(1)

    expect(error).toBeNull()
    expect(Array.isArray(data)).toBe(true)
  })

  it('keeps auth on GoTrue', async () => {
    // Auth is deliberately NOT migrated this stage. Four admin methods are used
    // across the codebase; losing them would break user creation and invites
    // with no compile error, because `service.auth` would simply be undefined.
    const service = createServiceClient()

    expect(service.auth).toBeDefined()
    expect(typeof service.auth.admin.createUser).toBe('function')
    expect(typeof service.auth.admin.deleteUser).toBe('function')
    expect(typeof service.auth.admin.inviteUserByEmail).toBe('function')
    expect(typeof service.auth.resetPasswordForEmail).toBe('function')
  })

  it('falls back to PostgREST when DB_DRIVER says so', async () => {
    // The rollback path has to keep working, or the flag is decoration. One
    // env var is the difference between the two drivers for the whole app.
    const previous = process.env.DB_DRIVER
    process.env.DB_DRIVER = 'postgrest'
    try {
      const service = createServiceClient()
      expect(service.from('airlines')).not.toBeInstanceOf(QueryBuilder)
    } finally {
      if (previous === undefined) delete process.env.DB_DRIVER
      else process.env.DB_DRIVER = previous
    }
  })
})
