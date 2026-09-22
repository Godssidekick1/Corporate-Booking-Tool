import { describe, it, expect, afterEach } from 'vitest'
import { createServiceClient } from '@/utils/supabase/service'
import { QueryBuilder } from './builder'

// ── Driver selection ─────────────────────────────────────────────────────────
// A REGRESSION TEST FOR A PRODUCTION OUTAGE, written after the fact.
//
// DB_DRIVER used to default to 'pg'. That is fine on a laptop with a
// DATABASE_URL in .env.local, and wrong everywhere else: the moment Vercel
// built the branch, the preview deployment switched every data query to a
// PostgreSQL that does not exist there. Sign-in still worked, because auth goes
// to GoTrue and was never migrated. /api/me returned 404 and the login screen
// said "Could not determine your account role. Please contact support."
//
// Two properties are asserted here, and between them they make that outage
// impossible to repeat silently:
//
//   1. An environment with no DATABASE_URL gets PostgREST -- it keeps working
//      exactly as it did before the migration.
//   2. An explicit DB_DRIVER wins in BOTH directions, so a deliberate
//      misconfiguration fails loudly instead of quietly falling back and
//      hiding itself.
//
// Runs with no database: the whole point is what happens when there isn't one.
// ─────────────────────────────────────────────────────────────────────────────

const originalDriver = process.env.DB_DRIVER
const originalUrl = process.env.DATABASE_URL

function setEnv(driver: string | undefined, url: string | undefined): void {
  if (driver === undefined) delete process.env.DB_DRIVER
  else process.env.DB_DRIVER = driver
  if (url === undefined) delete process.env.DATABASE_URL
  else process.env.DATABASE_URL = url
}

afterEach(() => setEnv(originalDriver, originalUrl))

// The shim's builder; supabase-js's is a different class entirely, so this is
// the only reliable way to tell which driver a client is actually using --
// both resolve to { data, error }, which is exactly why the outage was quiet.
function isShim(client: ReturnType<typeof createServiceClient>): boolean {
  return client.from('airlines') instanceof QueryBuilder
}

describe('driver selection', () => {
  it('falls back to PostgREST when DATABASE_URL is absent', async () => {
    // THE OUTAGE. Before the fix this returned the shim, and every query in
    // the application failed against a database that was never configured.
    setEnv(undefined, undefined)
    expect(isShim(createServiceClient())).toBe(false)
  })

  it('uses PostgreSQL when DATABASE_URL is present', async () => {
    setEnv(undefined, 'postgresql://postgres:x@localhost:5432/cbt_local')
    expect(isShim(createServiceClient())).toBe(true)
  })

  it('an explicit postgrest wins even with a DATABASE_URL set', async () => {
    // The rollback lever. It has to work while the local machine is fully
    // configured for pg, or it is not a rollback.
    setEnv('postgrest', 'postgresql://postgres:x@localhost:5432/cbt_local')
    expect(isShim(createServiceClient())).toBe(false)
  })

  it('an explicit pg with NO DATABASE_URL fails loudly rather than falling back', async () => {
    // The other direction, and the one that matters for diagnosis. Someone who
    // asked for PostgreSQL and did not get it must be told, not quietly served
    // Supabase -- otherwise the misconfiguration hides until something else
    // breaks and nobody knows which driver was live.
    setEnv('pg', undefined)
    const service = createServiceClient()

    expect(isShim(service)).toBe(true)
    await expect(service.from('airlines').select('code'))
      .rejects.toThrow(/DATABASE_URL is not set/)
  })

  it('a configuration failure THROWS rather than resolving to a null row', async () => {
    // The second half of the outage, and the more dangerous half. The builder
    // never throws for a query failure, by design -- 537 call sites read
    // { data, error }. But a database that is not configured is not a query
    // result, and folding it into one let /api/me read a total outage as
    // "employee not found" and answer 404.
    setEnv('pg', undefined)
    const service = createServiceClient()

    let threw = false
    try {
      // The exact shape /api/me uses.
      await service.from('employees').select('id, role').eq('id', 'anyone').single()
    } catch (err) {
      threw = true
      expect((err as Error).name).toBe('DbConfigurationError')
    }

    expect(threw, 'a missing DATABASE_URL must not look like a missing row').toBe(true)
  })
})
