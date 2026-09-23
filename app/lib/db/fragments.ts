import { sql, empty, join, type Sql } from './sql'
import type { PageParams } from '@/app/lib/pagination'

// ── Reusable SQL fragments ───────────────────────────────────────────────────
// For repositories only (this file imports the sql tag).
// ─────────────────────────────────────────────────────────────────────────────

// Escapes the LIKE metacharacters so a search box matches what was typed.
// PostgreSQL's default LIKE escape character is the backslash, so no ESCAPE
// clause is needed.
function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, ch => `\\${ch}`)
}

// Replaces ilikeAcross() from app/lib/pagination, which emitted PostgREST's
// `.or()` mini-language. Same behaviour for real input:
//   - the same characters are stripped (, ( ) \ *), so "Smith, John" behaves
//     as it always did;
//   - the term matches anywhere in any column, case-insensitively.
// One deliberate difference: `%` and `_` are now matched literally. Through
// PostgREST a search for "50%" was a wildcard and matched everything.
//
// Returns `and (…)` ready to append to a WHERE clause, or nothing at all when
// there is no usable term -- mirroring ilikeAcross returning null.
export function searchAcross(columns: readonly Sql[], term: string | null | undefined): Sql {
  const cleaned = (term ?? '').replace(/[,()\\*]/g, '').trim()
  if (!cleaned) return empty
  const pattern = `%${escapeLike(cleaned)}%`
  return sql`and (${join(columns.map(column => sql`${column} ilike ${pattern}`), sql` or `)})`
}

// LIMIT/OFFSET from the page params every paged endpoint already parses.
// PageParams.from/to are inclusive bounds (a PostgREST .range() convention),
// so the page size is to - from + 1.
export function page(params: Pick<PageParams, 'from' | 'to'>): Sql {
  return sql`limit ${params.to - params.from + 1} offset ${params.from}`
}

// ── nest ─────────────────────────────────────────────────────────────────────
// Folds prefixed columns from a JOIN back into an object:
//
//   select c.id, g.id as group__id, g.name as group__name …
//   nest(row, 'group__')  ->  { id, name }   or null when the join matched nothing
//
// WHY IN TYPESCRIPT AND NOT json_build_object: PostgreSQL's own JSON output
// formats a timestamptz as "2026-07-07T08:24:31.53791+00:00", while a
// top-level column goes through our type parser and arrives as
// "2026-07-07T08:24:31.537Z". Building nested objects in SQL would give the
// same kind of value two formats depending on where it sits in the response.
export function nest<T>(row: Record<string, unknown>, prefix: string): T | null {
  const out: Record<string, unknown> = {}
  let matched = false
  for (const [key, value] of Object.entries(row)) {
    if (!key.startsWith(prefix)) continue
    out[key.slice(prefix.length)] = value
    if (value !== null) matched = true
  }
  // All-null means a LEFT JOIN found no row, which is null -- not an object of
  // nulls, which every `?.name` downstream would misread as present.
  return matched ? (out as T) : null
}

// The row with every prefixed column removed, for use alongside nest().
export function without(row: Record<string, unknown>, ...prefixes: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(row)) {
    if (!prefixes.some(p => key.startsWith(p))) out[key] = value
  }
  return out
}

// ── assignments ──────────────────────────────────────────────────────────────
// A SET clause built from a partial patch, for routes that update whichever
// fields the caller sent.
//
//   const COLUMNS = { role: sql`role`, status: sql`status` } as const
//   sql`update employees set ${assignments(COLUMNS, patch)} where id = ${id}`
//
// Column names never come from the patch: each key maps to a LITERAL sql
// fragment written in the repository, so a key that is not in the map cannot
// reach the query -- TypeScript rejects it, and so does this at runtime.
// Undefined values are skipped (absent means "leave alone"); null is written
// (null means "clear it").
export function assignments<K extends string>(
  columns: Readonly<Record<K, Sql>>,
  patch: Partial<Record<K, unknown>>
): Sql {
  const parts: Sql[] = []
  for (const key of Object.keys(patch) as K[]) {
    if (!(key in columns)) throw new Error(`[db] "${key}" is not an updatable column here`)
    if (patch[key] === undefined) continue
    parts.push(sql`${columns[key]} = ${patch[key]}`)
  }
  if (parts.length === 0) throw new Error('[db] update with nothing to set')
  return join(parts)
}
