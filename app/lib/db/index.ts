import type { PoolClient, QueryResult } from 'pg'
import { getPool } from './pool'
import type { Queryable } from './sql'
import { currentContext, contextKey, contextValues } from './context'

// ── The data layer's public surface ──────────────────────────────────────────
// What routes and app/lib may import. Deliberately NOT the sql tag: SQL is
// written only in app/lib/repositories, and ESLint rejects an import of
// '@/app/lib/db/sql' from anywhere else.
//
//   import { db, transaction, isConstraint } from '@/app/lib/db'
//   import * as clients from '@/app/lib/repositories/clients'
//
//   const list = await clients.listForTmc(db, { … })
// ─────────────────────────────────────────────────────────────────────────────

// ── Every query carries the request's tenant ─────────────────────────────────
// Row-level security decides what a query may see from three session settings
// (app/lib/db/context.ts). Two ways to deliver them, by how the database is
// reached:
//
//   DIRECT (or a session pooler): set on the connection, and remembered on
//   it, so the next query on that connection for the same tenant costs
//   nothing extra. Every query re-checks, so a connection never carries one
//   request's tenant into another's query.
//
//   TRANSACTION POOLER (serverless, DB_POOL_MODE=transaction): a session
//   setting may land on a different server connection from the next query,
//   so each query runs in its own transaction with the settings LOCAL to it.
//   Three extra round trips per query; the price of a shared pooler.
// ─────────────────────────────────────────────────────────────────────────────

const CARRIES = Symbol('cbt.dbContext')
type Tagged = PoolClient & { [CARRIES]?: string }

const SET_SESSION = `select set_config('app.scope', $1, false), set_config('app.tmc_id', $2, false), set_config('app.client_id', $3, false)`
const SET_LOCAL = `select set_config('app.scope', $1, true), set_config('app.tmc_id', $2, true), set_config('app.client_id', $3, true)`

function transactionPooled(): boolean {
  return process.env.DB_POOL_MODE === 'transaction' || Boolean(process.env.VERCEL)
}

async function query(text: string, values?: unknown[]): Promise<QueryResult> {
  const ctx = currentContext()
  const client = (await getPool().connect()) as Tagged
  let broken = false
  try {
    if (transactionPooled()) {
      await client.query('begin')
      try {
        await client.query(SET_LOCAL, contextValues(ctx))
        const result = await client.query(text, values)
        await client.query('commit')
        return result
      } catch (err) {
        try { await client.query('rollback') } catch { broken = true }
        throw err
      }
    }
    const key = contextKey(ctx)
    if (client[CARRIES] !== key) {
      await client.query(SET_SESSION, contextValues(ctx))
      client[CARRIES] = key
    }
    return await client.query(text, values)
  } finally {
    client.release(broken)
  }
}

// The pool, as a Queryable. Lazy: nothing connects until the first query, so
// importing this at build time does not require a database.
export const db: Queryable = { query }

export type { Queryable } from './sql'
export { transaction, type TransactionOptions } from './transaction'
export { asSystem, enterContext, runAsRequest, setOutsideContext, currentContext, type DbContext } from './context'
export {
  ConstraintViolation,
  RowNotFound,
  TooManyRows,
  DbConfigurationError,
  isConstraint,
  type ConstraintKind,
} from './errors'
