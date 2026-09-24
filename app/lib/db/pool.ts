import { Pool, type PoolClient } from 'pg'
import { applyTypeParsers } from './typeParsers'
import { DbConfigurationError } from './errors'

// ── Connection pool ──────────────────────────────────────────────────────────
// One pool per process, created lazily.
//
// WHY A POOL AND NOT A CONNECTION PER QUERY: opening a PostgreSQL connection
// costs a TCP handshake plus authentication, which is far more than the query
// itself for the short reads this application makes. The pool keeps a small set
// open and hands them out.
//
// WHY LAZY: this module is imported by code that Next.js also evaluates at
// build time, where DATABASE_URL may legitimately be absent. Creating the pool
// on first use rather than at import means a build does not need a database.
//
// Measured context for the size below: the Supabase round trip this replaces
// was ~200ms per query over HTTP, and a single ticketing request made four of
// them sequentially before the provider was contacted at all.
// ─────────────────────────────────────────────────────────────────────────────

let pool: Pool | null = null

export function getPool(): Pool {
  if (pool) return pool

  // Before any connection is opened: setTypeParser is global to the pg module
  // and only affects rows decoded after it is called.
  applyTypeParsers()

  const connectionString = process.env.DATABASE_URL
  if (!connectionString) {
    // There is no fallback: every data read and write goes through this pool.
    // A 500 naming the variable, not a per-route guess at what a null row
    // means. See errors.ts.
    throw new DbConfigurationError(
      '[db] DATABASE_URL is not set, and the application has no other data path.\n' +
      '  Local:    DATABASE_URL=postgresql://postgres:<password>@localhost:5432/cbt_local\n' +
      '  Deployed: the Supabase transaction pooler (port 6543).'
    )
  }

  const serverless = Boolean(process.env.VERCEL)

  // One line per process saying where data goes. A misconfigured deployment
  // once looked healthy until some route misreported the first failed query;
  // this names the target in the boot log instead. Host and database only --
  // never the user or password.
  const target = new URL(connectionString)
  console.info(`[db] data -> PostgreSQL ${target.hostname}:${target.port || 5432}${target.pathname}` +
    ` (pool max ${serverless ? 3 : 10}); auth -> Supabase GoTrue`)

  pool = new Pool({
    connectionString,
    // SIZED FOR WHERE IT RUNS. A long-lived local server is one process, so 10
    // connections is modest. On Vercel every concurrent function instance
    // evaluates this module and gets ITS OWN pool -- 20 warm instances at
    // max 10 is 200 connections against a database whose limit is far lower,
    // and the failure ("remaining connection slots are reserved") appears only
    // under load, never in dev. So serverless gets a pool of 3, and relies on
    // the Supabase transaction pooler (port 6543) to multiplex upstream.
    max: serverless ? 3 : 10,
    // Idle connections on a frozen serverless instance are held open against
    // the pooler for nothing; release them quickly.
    idleTimeoutMillis: serverless ? 5_000 : 30_000,
    // Fail fast rather than hanging a request forever on an unreachable
    // database -- a 500 with a clear message beats a spinner that never stops.
    connectionTimeoutMillis: 10_000,
    // Local development is plaintext over loopback; a deployed database is
    // reached over TLS. Driven by the URL rather than hardcoded so the same
    // code serves both.
    ssl: connectionString.includes('localhost') || connectionString.includes('127.0.0.1')
      ? undefined
      : { rejectUnauthorized: false },
  })

  // An idle client erroring (a network blip, a server restart) otherwise
  // becomes an unhandled 'error' event, which takes the whole process down.
  pool.on('error', err => {
    console.error('[db] idle client error', err)
  })

  return pool
}

// Used by tests and by any shutdown path that wants to stop cleanly rather than
// letting open handles keep the process alive.
export async function closePool(): Promise<void> {
  if (!pool) return
  const p = pool
  pool = null
  await p.end()
}

export type { PoolClient }
