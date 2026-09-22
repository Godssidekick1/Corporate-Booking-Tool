import type { PoolClient } from 'pg'
import { QueryBuilder, type BuilderOptions } from './builder'

// ── The client ───────────────────────────────────────────────────────────────
// Exposes the one method the 537 call sites use: .from(table).
//
// Deliberately NOT a drop-in for all of supabase-js. There is no .auth here,
// no .storage, no .rpc, no .channel -- because the codebase uses none of them
// through the service client. Measured: 0 uses of .rpc, .storage or realtime
// anywhere. A narrower object is a smaller thing to be wrong about, and an
// accidental call to something unimplemented fails immediately and loudly
// rather than silently doing nothing.
// ─────────────────────────────────────────────────────────────────────────────

export interface DbClient {
  from<T = unknown[]>(table: string): QueryBuilder<T>
}

export function createDbClient(opts: BuilderOptions = {}): DbClient {
  return {
    from<T = unknown[]>(table: string): QueryBuilder<T> {
      return new QueryBuilder<T>(table, opts)
    },
  }
}

// Bound to a single connection, for use inside a transaction. Every query made
// through it runs on the same client, which is what makes BEGIN/COMMIT mean
// anything -- a builder that took a fresh client from the pool per query would
// execute each statement in its own implicit transaction and the rollback
// would cover nothing.
export function createTxClient(client: PoolClient): DbClient {
  return createDbClient({ client })
}
