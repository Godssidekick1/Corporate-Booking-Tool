// ── Identifier allow-list ────────────────────────────────────────────────────
// Every table and column the application is permitted to name in SQL.
//
// WHY THIS EXISTS: the shim builds SQL by string assembly. Values go through
// $1/$2 placeholders and are never interpolated, but IDENTIFIERS cannot be
// parameterised -- PostgreSQL has no placeholder for a table or column name. So
// the only way a table or column reaches the query text is by string
// concatenation, and the only safe way to do that is to refuse anything not on
// a list fixed at build time.
//
// The list is derived from schema/baseline.sql, which is the dump of the real
// database. Regenerate with:
//
//   node scripts/generate-allowlist.mjs
//
// A query naming something absent here THROWS rather than returning an error
// result. That asymmetry is deliberate: a missing row is a normal outcome the
// caller handles, but an unknown identifier means the code and the schema
// disagree, and continuing past that quietly is how a typo becomes a silent
// empty list in production.
// ─────────────────────────────────────────────────────────────────────────────

// Populated by scripts/generate-allowlist.mjs. Kept as a plain object literal
// rather than read from disk at runtime so it is bundled, immutable, and
// available in every environment without a file read.
import { TABLE_COLUMNS, COLUMN_TYPES, type ColumnKind } from './schemaTables.generated'

export { TABLE_COLUMNS, COLUMN_TYPES }
export type { ColumnKind }

// ── Binding a value for a column ─────────────────────────────────────────────
// THE BUG THIS EXISTS FOR, because it cost a real booking:
//
// node-postgres encodes a top-level JavaScript array as a PostgreSQL ARRAY
// LITERAL. `[{a:1}]` becomes `{"{\"a\":1}"}`, which is correct for text[] and
// is not valid JSON. Sent to a jsonb column, PostgreSQL rejects it with
// 22P02: 'Expected ":", but found "}"'.
//
// Plain objects were fine -- pg JSON.stringifies those -- so only top-level
// ARRAYS broke, and only on the columns that hold one. bookings.resolved_deal_codes
// is such a column: the insert failed after the passenger had already reached
// the airline.
//
// PostgREST never had this problem. It receives a JSON body and hands the value
// to PostgreSQL as jsonb, so an array is just an array. Reproducing that means
// encoding the value ourselves rather than letting pg guess from the JavaScript
// type, which it cannot do correctly without knowing the column.
//
// ARRAY COLUMNS ARE DELIBERATELY LEFT ALONE. text[] genuinely wants pg's array
// literal; JSON-encoding those would break ticket_numbers, fop_priority and
// exclude_tax_codes to fix jsonb.
export function coerceForColumn(table: string, column: string, value: unknown): unknown {
  if (value === null || value === undefined) return value
  if (COLUMN_TYPES[table]?.[column] !== 'json') return value

  // Already a string: assume it is serialised JSON and pass it through. Nothing
  // in this codebase does that today (measured: 0 call sites), but
  // double-encoding a value someone deliberately stringified would be worse
  // than trusting them.
  if (typeof value === 'string') return value

  return JSON.stringify(value)
}

export function assertTable(table: string): void {
  if (!Object.prototype.hasOwnProperty.call(TABLE_COLUMNS, table)) {
    throw new Error(
      `[db] unknown table "${table}". It is not in schema/baseline.sql. ` +
      `If the schema changed, re-run scripts/capture-schema.ps1 and ` +
      `node scripts/generate-allowlist.mjs.`
    )
  }
}

// Column references arrive in several shapes and all of them have to be
// checked, not just the simple ones:
//   "name"                 a plain column
//   "clients(id, name)"    an embedded relation -- handled separately
//   "count"                an aggregate
// This validates ONE bare column name against one table.
export function assertColumn(table: string, column: string): void {
  assertTable(table)
  const allowed = TABLE_COLUMNS[table]
  if (!allowed.includes(column)) {
    throw new Error(
      `[db] "${column}" is not a column of "${table}". ` +
      `Known columns: ${allowed.slice(0, 12).join(', ')}${allowed.length > 12 ? ', …' : ''}`
    )
  }
}

// Quote an identifier for use in SQL. Only ever called on a name that has
// already passed assertTable/assertColumn, so this is defence in depth rather
// than the primary control -- but a column called "order" or "group" needs the
// quotes regardless of who validated it.
export function quoteIdent(name: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`[db] refusing to quote a suspicious identifier: ${JSON.stringify(name)}`)
  }
  return `"${name}"`
}
