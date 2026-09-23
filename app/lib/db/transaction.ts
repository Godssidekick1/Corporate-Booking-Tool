import { getPool } from './pool'
import type { Queryable } from './sql'

// ── transaction ──────────────────────────────────────────────────────────────
// Runs a callback on ONE connection inside BEGIN/COMMIT. Any throw -- from a
// repository, a constraint, or the callback's own logic -- rolls the whole
// thing back and is re-thrown to the caller.
//
//   await transaction(async (db) => {
//     const client = await clients.insert(db, { name })
//     await employees.insertAdmin(db, { clientId: client.id, … })
//   })
//
// Replaces app/lib/db/tx.ts (withTransaction/orAbort/TxAbort). Those existed
// because shim queries returned errors instead of throwing, so a callback that
// checked `error` and simply returned would COMMIT its partial work. Repository
// functions throw, so there is nothing to abort by hand: the throw IS the abort.
//
// Only routes and app/lib orchestration open transactions. Repositories never
// do (enforced by ESLint) -- a repository function that opened its own would
// run outside the caller's transaction and commit independently of it.
// ─────────────────────────────────────────────────────────────────────────────

export interface TransactionOptions {
  // Written to app.current_tenant_id / app.current_user_id for the life of the
  // transaction. Nothing reads them yet; they are set now so enabling RLS later
  // is a migration rather than a change to every write path.
  tenantId?: string | null
  userId?: string | null
}

export async function transaction<T>(
  fn: (db: Queryable) => Promise<T>,
  options: TransactionOptions = {}
): Promise<T> {
  const client = await getPool().connect()
  let broken = false

  try {
    await client.query('BEGIN')

    // set_config's third argument `true` makes the setting local to this
    // transaction: discarded on COMMIT or ROLLBACK, so it cannot leak onto the
    // next request that borrows this pooled connection.
    if (options.tenantId !== undefined) {
      await client.query('select set_config($1, $2, true)', ['app.current_tenant_id', options.tenantId ?? ''])
    }
    if (options.userId !== undefined) {
      await client.query('select set_config($1, $2, true)', ['app.current_user_id', options.userId ?? ''])
    }

    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    try {
      await client.query('ROLLBACK')
    } catch (rollbackErr) {
      // The connection is in an unknown state. It is destroyed below rather
      // than returned to the pool, where the next borrower would inherit it.
      broken = true
      console.error('[db] ROLLBACK failed; discarding the connection', rollbackErr)
    }
    throw err
  } finally {
    // release(true) destroys the client instead of recycling it.
    client.release(broken)
  }
}
