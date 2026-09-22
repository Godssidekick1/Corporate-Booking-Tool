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

    // A column definition starts with its name, bare or quoted.
    const col = line.match(/^"?([a-zA-Z_][a-zA-Z0-9_]*)"?\s+/)
    if (col) columns.push(col[1])
  }

  if (columns.length > 0) tables[table] = columns
}

const names = Object.keys(tables).sort()

const out = `// GENERATED FILE -- DO NOT EDIT BY HAND.
//
// Written by scripts/generate-allowlist.mjs from schema/baseline.sql.
// Re-run it after capture-schema.ps1 rather than editing this.
//
// ${names.length} tables, ${Object.values(tables).reduce((n, c) => n + c.length, 0)} columns.

export const TABLE_COLUMNS: Record<string, string[]> = {
${names.map(t => `  ${t}: [${tables[t].map(c => `'${c}'`).join(', ')}],`).join('\n')}
}
`

writeFileSync(join(ROOT, 'app', 'lib', 'db', 'schemaTables.generated.ts'), out, 'utf8')

console.log(`\n${names.length} tables, ${Object.values(tables).reduce((n, c) => n + c.length, 0)} columns`)
console.log('-> app/lib/db/schemaTables.generated.ts\n')

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
