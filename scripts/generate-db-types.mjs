// ── generate-db-types.mjs ────────────────────────────────────────────────────
// Introspects the database and writes app/lib/db/types.generated.ts: one row
// type per table and view, with nullability, arrays and jsonb.
//
// This is what repays the shim's `from<T = any[]>`. Repositories build their
// return types from these rows (Pick<Row<'bookings'>, 'id' | 'total_cost'>), so
// renaming or dropping a column breaks `tsc` at every query that reads it,
// instead of breaking a route at runtime.
//
// INTROSPECTION, NOT A REGEX OVER baseline.sql. The shim's allow-list generator
// parsed pg_dump output; information_schema is the database's own account of
// itself and gets nullability right without guessing at DEFAULT clauses.
//
// Run against the template database (or any restore of the real schema):
//
//   node scripts/generate-db-types.mjs            # uses DATABASE_URL
//   node scripts/generate-db-types.mjs <url>
//
// The mapping below MUST agree with app/lib/db/typeParsers.ts, which decides
// what JavaScript value each PostgreSQL type actually arrives as:
//   numeric/int8 -> number,  timestamptz/date -> ISO string.
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import pg from 'pg'

const ROOT = process.cwd()

function envUrl() {
  if (process.argv[2]) return process.argv[2]
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL
  const envPath = join(ROOT, '.env.local')
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*DATABASE_URL\s*=\s*(.*)\s*$/)
      if (m) return m[1].replace(/^["']|["']$/g, '')
    }
  }
  throw new Error('DATABASE_URL not set. Pass a connection string or add it to .env.local.')
}

const SCALARS = {
  uuid: 'string', text: 'string', varchar: 'string', bpchar: 'string', citext: 'string', name: 'string',
  int2: 'number', int4: 'number', int8: 'number', numeric: 'number', float4: 'number', float8: 'number',
  bool: 'boolean',
  timestamptz: 'string', timestamp: 'string', date: 'string', time: 'string', timetz: 'string', interval: 'string',
  json: 'Json', jsonb: 'Json',
}

function tsType(udt) {
  if (udt.startsWith('_')) {
    const element = SCALARS[udt.slice(1)]
    if (!element) throw new Error(`unmapped array element type: ${udt}`)
    return `${element}[]`
  }
  const scalar = SCALARS[udt]
  // Fail rather than emit `unknown`: a new column type is a decision, and it
  // must be made here AND in typeParsers.ts together.
  if (!scalar) throw new Error(`unmapped PostgreSQL type: ${udt}. Add it here and in typeParsers.ts.`)
  return scalar
}

const client = new pg.Client({ connectionString: envUrl() })
await client.connect()

const { rows } = await client.query(`
  select c.table_name, t.table_type, c.column_name, c.is_nullable, c.udt_name
  from information_schema.columns c
  join information_schema.tables t
    on t.table_schema = c.table_schema and t.table_name = c.table_name
  where c.table_schema = 'public'
  order by c.table_name, c.ordinal_position
`)
await client.end()

const tables = new Map()
const views = new Map()
for (const r of rows) {
  const target = r.table_type === 'VIEW' ? views : tables
  if (!target.has(r.table_name)) target.set(r.table_name, [])
  // Views report every column as nullable -- PostgreSQL cannot infer it -- so
  // view types are honest about that rather than guessing.
  const nullable = r.is_nullable === 'YES'
  target.get(r.table_name).push(`    ${r.column_name}: ${tsType(r.udt_name)}${nullable ? ' | null' : ''}`)
}

const block = (name, map) =>
  `export interface ${name} {\n` +
  [...map.entries()].map(([t, cols]) => `  ${t}: {\n${cols.join('\n')}\n  }`).join('\n') +
  `\n}`

const columnCount = rows.length
const out = `// GENERATED FILE -- DO NOT EDIT BY HAND.
//
// Written by scripts/generate-db-types.mjs from the live database schema.
// Re-run after any schema change:  node scripts/generate-db-types.mjs
//
// ${tables.size} tables, ${views.size} view(s), ${columnCount} columns.

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json }

${block('Tables', tables)}

${block('Views', views)}

export type TableName = keyof Tables
export type Row<T extends TableName> = Tables[T]
export type ViewRow<V extends keyof Views> = Views[V]
`

writeFileSync(join(ROOT, 'app', 'lib', 'db', 'types.generated.ts'), out, 'utf8')
console.log(`${tables.size} tables, ${views.size} view(s), ${columnCount} columns -> app/lib/db/types.generated.ts`)
