// ── Database errors ──────────────────────────────────────────────────────────
// THE RULE: repositories THROW. Absence is expressed in the return type --
// `T | null` for a lookup, `T[]` for a list -- never as an error. A failure can
// therefore never be read as "no rows", which is the bug behind both the
// bands:band_code outage and the /api/me 404. Measured before this layer
// existed: 214 call sites destructured `data` and discarded `error`.
//
// Three kinds of failure get their own class:
//   ConstraintViolation   the one a route is expected to catch (isConstraint)
//   RowNotFound / TooManyRows   a query that broke its own contract
//   DbConfigurationError  no database configured at all
// Everything else -- a lost connection, a syntax error -- propagates as the
// driver raised it, and route() turns it into a logged, generic 500.
// ─────────────────────────────────────────────────────────────────────────────

// The fields node-postgres puts on a DatabaseError that this file reads.
// Declared rather than imported: pg's own class carries far more than is used.
interface PgErrorLike {
  message?: string
  code?: string
  detail?: string
  hint?: string
  constraint?: string
  table?: string
  column?: string
}

// ── Configuration failures are not query failures ────────────────────────────
// A missing DATABASE_URL is not recoverable by the caller and affects every
// query equally. It once reached production looking like "no such employee"
// -- a 404 from /api/me that the login page rendered as "Could not determine
// your account role". So it has a name of its own, and a 500 naming the
// missing variable is what a log shows.
export class DbConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DbConfigurationError'
  }
}

export type ConstraintKind = 'unique' | 'foreign_key' | 'check' | 'exclusion' | 'not_null'

const CONSTRAINT_SQLSTATES: Record<string, ConstraintKind> = {
  '23505': 'unique',
  '23503': 'foreign_key',
  '23514': 'check',
  '23P01': 'exclusion',
  '23502': 'not_null',
}

// A constraint the database enforced. The ONE kind of failure a route is
// expected to catch, because it is usually the user's mistake ("that code is
// already in use") rather than a fault.
//
// `message` is PostgreSQL's own, unchanged, so a route that surfaced it before
// -- the policy-group rank-overlap trigger raises a sentence meant for a human
// -- still surfaces the same words. `constraint` is what a route should branch
// on: it names WHICH rule was broken, where the message only says that one was.
export class ConstraintViolation extends Error {
  readonly kind: ConstraintKind
  readonly code: string
  readonly constraint: string | null
  readonly table: string | null
  readonly column: string | null
  readonly detail: string | null

  constructor(kind: ConstraintKind, pg: PgErrorLike) {
    super(pg.message ?? `${kind} constraint violated`)
    this.name = 'ConstraintViolation'
    this.kind = kind
    this.code = pg.code ?? ''
    this.constraint = pg.constraint ?? null
    this.table = pg.table ?? null
    this.column = pg.column ?? null
    this.detail = pg.detail ?? null
  }
}

// one() found nothing. Distinct from maybeOne(), which returns null: a
// repository uses one() only where the row's absence means the code, not the
// user, is wrong -- e.g. reading back the row it just inserted.
export class RowNotFound extends Error {
  constructor(what = 'row') {
    super(`[db] expected exactly one ${what}, found none`)
    this.name = 'RowNotFound'
  }
}

// maybeOne() or one() found several. Always a bug in the query -- a lookup
// that is supposed to be unique is not -- so it is loud rather than returning
// an arbitrary first row.
export class TooManyRows extends Error {
  constructor(readonly count: number, what = 'row') {
    super(`[db] expected at most one ${what}, found ${count}`)
    this.name = 'TooManyRows'
  }
}

// Converts a node-postgres error into a ConstraintViolation where it is one, and
// otherwise returns it untouched -- a syntax error, a lost connection or a
// DbConfigurationError should propagate as exactly what it is.
export function translatePgError(err: unknown): unknown {
  const e = err as PgErrorLike | null
  const kind = e?.code ? CONSTRAINT_SQLSTATES[e.code] : undefined
  return kind ? new ConstraintViolation(kind, e!) : err
}

// The check routes use:
//
//   catch (err) {
//     if (isConstraint(err, 'unique', 'policy_groups_tmc_code_key')) return 409
//     throw err
//   }
//
// The constraint name is optional so a route can match on kind alone where a
// table has only one rule of that kind.
export function isConstraint(
  err: unknown,
  kind?: ConstraintKind,
  constraint?: string
): err is ConstraintViolation {
  if (!(err instanceof ConstraintViolation)) return false
  if (kind && err.kind !== kind) return false
  if (constraint && err.constraint !== constraint) return false
  return true
}
