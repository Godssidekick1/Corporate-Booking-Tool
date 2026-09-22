import { getPool } from './pool'
import { createTxClient, type DbClient } from './client'
import { toDbError, type DbError } from './errors'

// ── withTransaction ──────────────────────────────────────────────────────────
// The reason this whole migration is worth doing.
//
// PostgREST gives one statement per HTTP call, so the 36 routes in this
// codebase that issue two or more writes cannot be atomic. A failure halfway
// through leaves rows in a state no invariant describes, and the existing
// mitigation is hand-written compensating deletes that can themselves fail.
//
// Now that the connection is ours, a real BEGIN/COMMIT is available:
//
//   const { error } = await withTransaction(async (db) => {
//     await db.from('approval_chain_templates').insert({...})
//     await db.from('approval_tier_approvers').insert([...])
//   })
//
// Everything inside runs on ONE connection. A throw, or any query returning an
// error, rolls the whole thing back.
// ─────────────────────────────────────────────────────────────────────────────

export interface TxOptions {
  // Written to app.current_tenant_id for the life of the transaction.
  //
  // No RLS policy reads this yet -- policies are deliberately out of scope for
  // this stage. It is set from the start anyway because auth.uid() in cbt_local
  // already reads a GUC (see schema/restore_notes.md), so enabling RLS later
  // becomes a migration rather than a refactor of every write path.
  tenantId?: string | null
  userId?: string | null

  // Defer foreign keys until COMMIT.
  //
  // NEEDED FOR A REAL CYCLE IN THIS SCHEMA: pg_dump reports
  // clients -> branches -> employees -> clients. Inside one transaction no
  // insert order can satisfy a cycle -- whichever goes first references a row
  // that does not exist yet. Deferring moves the check to COMMIT, by which
  // point all three exist.
  //
  // Only works on constraints declared DEFERRABLE. Most here are not, so this
  // is a no-op for them rather than an error; the alternative for a
  // non-deferrable cycle is inserting with the FK column null and filling it in
  // before COMMIT.
  deferConstraints?: boolean
}

export interface TxResult<T> {
  data: T | null
  error: DbError | null
}

export async function withTransaction<T>(
  fn: (db: DbClient) => Promise<T>,
  options: TxOptions = {}
): Promise<TxResult<T>> {
  const pool = getPool()
  const client = await pool.connect()

  try {
    await client.query('BEGIN')

    // set_config's third argument true = local to this transaction, so it is
    // discarded on COMMIT or ROLLBACK and cannot leak onto the next caller that
    // borrows this pooled connection. That leak is the classic bug with
    // connection-scoped settings.
    if (options.tenantId !== undefined) {
      await client.query('SELECT set_config($1, $2, true)', [
        'app.current_tenant_id', options.tenantId ?? '',
      ])
    }
    if (options.userId !== undefined) {
      await client.query('SELECT set_config($1, $2, true)', [
        'app.current_user_id', options.userId ?? '',
      ])
    }

    if (options.deferConstraints) {
      await client.query('SET CONSTRAINTS ALL DEFERRED')
    }

    const data = await fn(createTxClient(client))

    await client.query('COMMIT')
    return { data, error: null }
  } catch (err) {
    try {
      await client.query('ROLLBACK')
    } catch (rollbackErr) {
      // A failed rollback means the connection is in an unknown state. Logged
      // loudly because the pool will hand it to somebody else.
      console.error('[db] ROLLBACK failed', rollbackErr)
    }
    return { data: null, error: toDbError(err) }
  } finally {
    client.release()
  }
}

// ── TxAbort ──────────────────────────────────────────────────────────────────
// Thrown to roll back deliberately from inside the callback without it being
// mistaken for a bug.
//
// The callback's queries return { data, error } rather than throwing, exactly
// as they do outside a transaction -- so a caller that checks `error` and
// simply returns would COMMIT the partial work. Throwing this is how a route
// says "stop and undo" in a way that reads as intent.
export class TxAbort extends Error {
  constructor(public readonly dbError: DbError) {
    super(dbError.message)
    this.name = 'TxAbort'
  }
}

// Sugar for the commonest shape inside a transaction: run a query, and abort
// the whole thing if it failed.
//
//   const row = await orAbort(db.from('clients').insert({...}).select('id').single())
export async function orAbort<T>(
  query: PromiseLike<{ data: T; error: DbError | null }>
): Promise<T> {
  const { data, error } = await query
  if (error) throw new TxAbort(error)
  return data
}
