import { getPool } from './pool'
import type { Queryable } from './sql'

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

// The pool, as a Queryable. Lazy: nothing connects until the first query, so
// importing this at build time does not require a database.
export const db: Queryable = {
  query: (text, values) => getPool().query(text, values),
}

export type { Queryable } from './sql'
export { transaction, type TransactionOptions } from './transaction'
export {
  ConstraintViolation,
  RowNotFound,
  TooManyRows,
  DbConfigurationError,
  isConstraint,
  type ConstraintKind,
} from './errors'
