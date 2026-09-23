import type { QueryResult, QueryResultRow } from 'pg'
import { RowNotFound, TooManyRows, translatePgError } from './errors'

// ── The sql tagged template ──────────────────────────────────────────────────
// How the repository layer talks to PostgreSQL. Every query in the application
// is written with it, and it is importable ONLY from app/lib/repositories and
// app/lib/db (enforced by ESLint), so SQL has exactly one home.
//
//   const rows = await many<Row>(db, sql`
//     select id, name from clients
//     where tmc_id = ${tmcId} and status = ${status}
//   `)
//
// WHY THIS IS SAFE BY CONSTRUCTION: a tagged template receives the literal
// text and the interpolated values SEPARATELY. The text is what a developer
// wrote in the source file; every ${…} becomes a $n placeholder and its value
// travels to PostgreSQL out of band. There is no code path by which a value
// becomes SQL text, so there is nothing to escape and nothing to allow-list --
// which is why the shim's schemaAllowList, quoteIdent and .or() parser have no
// equivalent here. Identifiers are literal text written by a developer.
//
// There is deliberately NO raw()/identifier escape hatch. Measured need across
// the codebase: zero dynamic column or table names.
// ─────────────────────────────────────────────────────────────────────────────

// Anything that can run a query: the pool, or a client inside a transaction.
// Repository functions take this as their first parameter, so the connection a
// query runs on is visible at every call site.
export interface Queryable {
  query(text: string, values?: unknown[]): Promise<QueryResult<QueryResultRow>>
}

export class Sql {
  constructor(
    readonly strings: readonly string[],
    readonly values: readonly unknown[]
  ) {}
}

// A value to send to a json/jsonb column.
//
// node-postgres encodes a top-level JavaScript ARRAY as a PostgreSQL array
// literal -- [{a:1}] becomes {"{\"a\":1}"} -- which is right for text[] and is
// not JSON. That exact encoding failed a real booking insert with 22P02 after
// the passenger had reached the airline. json() stringifies the value itself
// and casts the placeholder, so the column receives JSON whatever its shape.
class JsonParam {
  constructor(readonly value: unknown) {}
}

export function sql(strings: TemplateStringsArray, ...values: unknown[]): Sql {
  return new Sql(strings, values)
}

// Composes into any position and contributes nothing -- the building block for
// optional filters: ${includeInactive ? empty : sql`and status <> 'inactive'`}
export const empty = new Sql([''], [])

export function join(parts: readonly Sql[], separator: Sql = sql`, `): Sql {
  if (parts.length === 0) return empty
  const strings: string[] = ['']
  const values: unknown[] = []
  parts.forEach((part, i) => {
    if (i > 0) {
      values.push(separator)
      strings.push('')
    }
    values.push(part)
    strings.push('')
  })
  return new Sql(strings, values)
}

// json(null) is SQL NULL, not the JSON literal `null`. A column that has no
// value should read back as null, and `commercials IS NULL` should find it.
export function json(value: unknown): JsonParam {
  return new JsonParam(value)
}

// ── Compilation ──────────────────────────────────────────────────────────────
// Walks nested fragments, numbering placeholders in the order they appear in
// the final text. Fragments compose freely -- a WHERE clause built once can be
// used in both the page query and the count query -- because numbering happens
// here, at the end, not when a fragment is written.
export function compile(query: Sql): { text: string; values: unknown[] } {
  const values: unknown[] = []

  const walk = (fragment: Sql): string => {
    let text = fragment.strings[0]
    for (let i = 0; i < fragment.values.length; i++) {
      const value = fragment.values[i]

      if (value instanceof Sql) {
        text += walk(value)
      } else if (value instanceof JsonParam) {
        values.push(value.value === null || value.value === undefined ? null : JSON.stringify(value.value))
        text += `$${values.length}::jsonb`
      } else {
        // undefined becomes NULL, which is what pg itself does. Repository
        // functions normalise optional inputs explicitly (`x ?? null`) so this
        // is a backstop, not a convention to rely on.
        values.push(value === undefined ? null : value)
        text += `$${values.length}`
      }

      text += fragment.strings[i + 1]
    }
    return text
  }

  return { text: walk(query), values }
}

// ── Execution ────────────────────────────────────────────────────────────────
// Four shapes, chosen by what the caller expects, so the expectation is part
// of the code rather than an `if (!data)` afterwards:
//
//   many       -> T[]        a list; empty is a normal answer
//   maybeOne   -> T | null   a lookup; absent is a normal answer; >1 is a bug
//   one        -> T          must exist; absent or >1 is a bug
//   exec       -> number     a write with no RETURNING; returns rows affected
//
// All four THROW on failure. None of them can turn an error into an empty
// result -- the property the shim, faithfully copying supabase-js, could not
// offer.

async function run(db: Queryable, query: Sql): Promise<QueryResult<QueryResultRow>> {
  const { text, values } = compile(query)
  try {
    return await db.query(text, values)
  } catch (err) {
    throw translatePgError(err)
  }
}

export async function many<T>(db: Queryable, query: Sql): Promise<T[]> {
  return (await run(db, query)).rows as T[]
}

export async function maybeOne<T>(db: Queryable, query: Sql): Promise<T | null> {
  const rows = (await run(db, query)).rows
  if (rows.length > 1) throw new TooManyRows(rows.length)
  return (rows[0] as T | undefined) ?? null
}

export async function one<T>(db: Queryable, query: Sql): Promise<T> {
  const rows = (await run(db, query)).rows
  if (rows.length === 0) throw new RowNotFound()
  if (rows.length > 1) throw new TooManyRows(rows.length)
  return rows[0] as T
}

export async function exec(db: Queryable, query: Sql): Promise<number> {
  return (await run(db, query)).rowCount ?? 0
}
