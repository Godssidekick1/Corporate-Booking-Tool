import { Pool, type PoolClient } from 'pg'
import { applyTypeParsers } from './typeParsers'

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
    throw new Error(
      '[db] DATABASE_URL is not set. Add it to .env.local:\n' +
      '  DATABASE_URL=postgresql://postgres:<password>@localhost:5432/cbt_local'
    )
  }

  pool = new Pool({
    connectionString,
    // Modest: this is one application server against one database. Too many
    // idle connections is a cost paid on the PostgreSQL side, where each one is
    // a backend process.
    max: 10,
    idleTimeoutMillis: 30_000,
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
