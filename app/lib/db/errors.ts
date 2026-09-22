// ── Error shape ──────────────────────────────────────────────────────────────
// supabase-js never throws for a query failure -- it returns { data: null,
// error }. All 537 call sites are written against that, so the shim must do the
// same or every one of them would need a try/catch.
//
// MEASURED USAGE of the error object across the codebase:
//   .message   104 sites
//   .code       11 sites
//   .hint        3 sites
//   .details     3 sites
//
// The .code sites are the interesting ones. They check real PostgreSQL
// SQLSTATEs -- 23505 unique violation, 23514 check violation, 23503 foreign
// key, 23P01 exclusion violation -- to turn a constraint failure into a useful
// message ("that code is already in use") instead of a 500. node-postgres
// surfaces those natively, so the shim is MORE faithful here than PostgREST,
// which passes them through a translation layer.
//
// ONE TRAP: pg calls the field `detail` (singular); PostgREST calls it
// `details` (plural). Mapping it is the whole reason this file exists rather
// than the error being passed through as-is.
// ─────────────────────────────────────────────────────────────────────────────

export interface DbError {
  message: string
  code: string
  details: string
  hint: string
}

// The shape pg gives us. Declared rather than imported because pg's own
// DatabaseError type is a class with far more on it than we read, and narrowing
// to what is actually consumed documents the contract.
interface PgErrorLike {
  message?: string
  code?: string
  detail?: string
  hint?: string
  constraint?: string
  table?: string
  column?: string
}

// ── Configuration failures are NOT query failures ────────────────────────────
// The "never throws" contract above exists so 537 call sites do not need a
// try/catch around every query. It applies to QUERY failures -- a constraint
// violation, a missing row -- which a caller can sensibly interpret.
//
// A missing DATABASE_URL is not that. It is not recoverable by the caller, it
// affects every query equally, and returning it as { data: null, error } means
// each route invents its own wrong interpretation of a total outage.
//
// THIS EXACT FAILURE REACHED PRODUCTION. With DB_DRIVER defaulting to pg and no
// DATABASE_URL on Vercel, getPool() threw, the builder caught it, and
// app/api/me/route.ts read `if (employeeError || !employee)` as "no employee
// row" -- answering 404 "Employee profile not found", which the login page
// renders as "Could not determine your account role. Please contact support."
// A database that was not configured looked like a user who did not exist.
//
// So this one throws, and the builder re-throws it. A 500 naming the missing
// variable is diagnosable in a log; a 404 is not.
export class DbConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DbConfigurationError'
  }
}

export function toDbError(err: unknown): DbError {
  const e = (err ?? {}) as PgErrorLike

  return {
    message: e.message ?? String(err),
    code: e.code ?? '',
    // detail -> details. See the header.
    details: e.detail ?? '',
    // Constraint names are genuinely useful when a 23505 fires and the message
    // alone does not say which unique index was hit. Appended rather than
    // replacing pg's own hint, which is sometimes populated too.
    hint: [e.hint, e.constraint ? `constraint: ${e.constraint}` : null]
      .filter(Boolean)
      .join(' '),
  }
}

// ── The two errors the shim raises itself ────────────────────────────────────
// Both mirror PostgREST's own codes so a call site checking for them keeps
// working. PGRST116 is what PostgREST returns when .single() or .maybeSingle()
// does not get the row count it required.

export function notASingleRow(rowCount: number): DbError {
  return {
    message:
      rowCount === 0
        ? 'JSON object requested, multiple (or no) rows returned'
        : `JSON object requested, multiple (or no) rows returned`,
    code: 'PGRST116',
    details: `Results contain ${rowCount} rows`,
    hint: '',
  }
}
