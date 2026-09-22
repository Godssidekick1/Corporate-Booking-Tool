// ── generate-allowlist.mjs ───────────────────────────────────────────────────
// Reads schema/baseline.sql and writes app/lib/db/schemaTables.generated.ts:
// every table, and every column of it.
//
// The shim assembles SQL by string concatenation for identifiers, because
// PostgreSQL has no placeholder for a table or column name. This list is what
// makes that safe -- anything not on it is refused before it reaches a query.
//
// Generated rather than hand-written so it cannot drift from the schema. Re-run
// after any capture-schema.ps1:
//
//   node scripts/generate-allowlist.mjs
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const sql = readFileSync(join(ROOT, 'schema', 'baseline.sql'), 'utf8')

// CREATE TABLE public.foo ( ... );  -- captured up to the closing paren at the
// start of a line, which is how pg_dump formats every table.
const tableRe = /CREATE TABLE (?:IF NOT EXISTS )?(?:public\.)?(\w+)\s*\(([\s\S]*?)^\);/gm

const tables = {}
let match

while ((match = tableRe.exec(sql)) !== null) {
  const [, table, body] = match

  const columns = []
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue

    // Skip table-level constraints, which start with a keyword rather than a
    // column name.
    if (/^(CONSTRAINT|PRIMARY|FOREIGN|UNIQUE|CHECK|EXCLUDE|LIKE)\b/i.test(line)) continue

    // A column definition starts with its name, bare or quoted, then its type.
    const col = line.match(/^"?([a-zA-Z_][a-zA-Z0-9_]*)"?\s+(.+?)(?:\s+(?:DEFAULT|NOT NULL|NULL|GENERATED|COLLATE)\b.*)?,?$/i)
    if (col) columns.push([col[1], normaliseType(col[2])])
  }

  if (columns.length > 0) tables[table] = columns
}

// ── Why the TYPE matters, not just the name ──────────────────────────────────
// A PRODUCTION BUG CAME FROM NOT HAVING THIS.
//
// node-postgres encodes a top-level JavaScript array as a PostgreSQL ARRAY
// LITERAL -- [{a:1}] becomes {"{\"a\":1}"} -- which is correct for text[] and
// is not valid JSON. Sent to a jsonb column, PostgreSQL rejects it with
// 22P02 'Expected ":", but found "}"'.
//
// Objects were fine, because pg JSON.stringifies those. Only top-level arrays
// broke, so most of the application worked and a booking did not:
// bookings.resolved_deal_codes holds an array, the insert failed, and the
// passenger had already reached the airline.
//
// The shim could not know to encode that column differently, because this file
// recorded column NAMES ONLY. PostgREST knew, because it reads pg_catalog.
// Now the shim knows too.
//
// Collapsed to the handful of categories the shim actually branches on --
// there is no value in distinguishing varchar(40) from text here.
function normaliseType(raw) {
  const t = raw.trim().toLowerCase().replace(/\s+/g, ' ')

  // ARRAY COLUMNS MUST BE CHECKED FIRST and must NOT be JSON-encoded: text[]
  // genuinely wants pg's array literal. Only three exist (ticket_numbers,
  // fop_priority, exclude_tax_codes) and getting this backwards would break
  // all of them to fix jsonb.
  if (/\[\]/.test(t)) return 'array'

  if (/^(jsonb|json)\b/.test(t)) return 'json'
  if (/^(numeric|decimal|real|double precision|float)/.test(t)) return 'numeric'
  if (/^(integer|int|int4|int8|bigint|smallint|serial|bigserial)\b/.test(t)) return 'integer'
  if (/^(boolean|bool)\b/.test(t)) return 'boolean'
  if (/^timestamp/.test(t)) return 'timestamptz'
  if (/^date\b/.test(t)) return 'date'
  if (/^uuid\b/.test(t)) return 'uuid'
  return 'text'
}

const names = Object.keys(tables).sort()

const total = Object.values(tables).reduce((n, c) => n + c.length, 0)
const jsonColumns = Object.entries(tables)
  .flatMap(([t, cols]) => cols.filter(([, ty]) => ty === 'json').map(([c]) => `${t}.${c}`))
const arrayColumns = Object.entries(tables)
  .flatMap(([t, cols]) => cols.filter(([, ty]) => ty === 'array').map(([c]) => `${t}.${c}`))

const out = `// GENERATED FILE -- DO NOT EDIT BY HAND.
//
// Written by scripts/generate-allowlist.mjs from schema/baseline.sql.
// Re-run it after capture-schema.ps1 rather than editing this.
//
// ${names.length} tables, ${total} columns.
// ${jsonColumns.length} json/jsonb columns, ${arrayColumns.length} PostgreSQL array columns.

export const TABLE_COLUMNS: Record<string, string[]> = {
${names.map(t => `  ${t}: [${tables[t].map(([c]) => `'${c}'`).join(', ')}],`).join('\n')}
}

// The category the shim branches on when binding a value. See normaliseType in
// the generator, and coerceForColumn in builder.ts.
export type ColumnKind =
  | 'json' | 'array' | 'numeric' | 'integer' | 'boolean'
  | 'timestamptz' | 'date' | 'uuid' | 'text'

export const COLUMN_TYPES: Record<string, Record<string, ColumnKind>> = {
${names.map(t =>
  `  ${t}: { ${tables[t].map(([c, ty]) => `${c}: '${ty}'`).join(', ')} },`
).join('\n')}
}
`

writeFileSync(join(ROOT, 'app', 'lib', 'db', 'schemaTables.generated.ts'), out, 'utf8')

console.log(`\n${names.length} tables, ${total} columns`)
console.log(`\njson/jsonb (JSON-encoded on write): ${jsonColumns.length}`)
jsonColumns.forEach(c => console.log(`  ${c}`))
console.log(`\nPostgreSQL arrays (left to pg's own encoder): ${arrayColumns.length}`)
arrayColumns.forEach(c => console.log(`  ${c}`))
console.log('\n-> app/lib/db/schemaTables.generated.ts\n')

// A table the code queries but the schema does not define is a real problem --
// far better found here than as a runtime throw.
const csvPath = join(ROOT, 'schema', 'callsites.csv')
try {
  const csv = readFileSync(csvPath, 'utf8')
  const queried = new Set(
    csv.split(/\r?\n/).slice(1).filter(Boolean).map(l => l.split(',')[2])
  )
  const missing = [...queried].filter(t => t && !tables[t]).sort()
  if (missing.length > 0) {
    console.log('WARNING: queried by code but absent from the schema:')
    missing.forEach(t => console.log(`  ${t}`))
    console.log('')
  }
} catch {
  // callsites.csv is optional here.
}
