// ── inventory-callsites.mjs ──────────────────────────────────────────────────
// Every PostgREST query in the codebase, as a CSV.
//
// This is the specification for the compatibility shim and the checklist for
// its completion. The shim reimplements supabase-js's query-builder surface
// over node-postgres so that the 562 existing call sites keep working
// unchanged -- which is only a sane plan if that surface is genuinely small.
// This measures it rather than assuming it.
//
// Deliberately a regex pass over source text, not a TypeScript AST walk. The
// goal is an inventory to work from, not a refactoring tool: it needs to be
// readable, throwaway, and to run in a second. A few false positives in a CSV
// that a human scans are cheaper than a dependency on the compiler API.
//
//   node scripts/inventory-callsites.mjs
//   -> schema/callsites.csv
// ─────────────────────────────────────────────────────────────────────────────

import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = process.cwd()
const SEARCH_DIRS = ['app', 'utils']

// The chainable methods supabase-js exposes that this codebase might use. A
// method appearing here that never shows up in the output is one the shim does
// not have to implement.
const METHODS = [
  'select', 'insert', 'update', 'upsert', 'delete',
  'eq', 'neq', 'gt', 'gte', 'lt', 'lte',
  'like', 'ilike', 'in', 'is', 'or', 'not', 'filter', 'match',
  'contains', 'containedBy', 'overlaps', 'textSearch',
  'order', 'limit', 'range', 'single', 'maybeSingle', 'csv',
  'throwOnError', 'abortSignal', 'returns', 'explain', 'rpc',
]

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) yield* walk(full)
    else if (/\.tsx?$/.test(entry)) yield full
  }
}

const rows = []
const methodTotals = new Map()
const tableTotals = new Map()

for (const dir of SEARCH_DIRS) {
  for (const file of walk(join(ROOT, dir))) {
    const src = readFileSync(file, 'utf8')
    const lines = src.split(/\r?\n/)

    lines.forEach((line, i) => {
      // `.from('table')` starts a query. Chains frequently span lines, so the
      // chain is read forward from here rather than from this line alone.
      const fromMatch = line.match(/\.from\(\s*['"`](\w+)['"`]\s*\)/)
      if (!fromMatch) return

      const table = fromMatch[1]

      // Look ahead until the statement plausibly ends. Bounded, because an
      // unterminated chain must not swallow the rest of the file.
      const window = lines.slice(i, i + 14).join(' ')

      const used = []
      for (const m of METHODS) {
        const re = new RegExp(`\\.${m}\\s*\\(`)
        if (re.test(window)) used.push(m)
      }

      // How the result is unwrapped decides the shim's return contract, and
      // these three differ in ways that matter: maybeSingle errors on >1 row,
      // single errors unless exactly 1, neither returns an array.
      const terminal =
        /\.maybeSingle\s*\(/.test(window) ? 'maybeSingle'
        : /\.single\s*\(/.test(window) ? 'single'
        : 'many'

      const counted = /count\s*:\s*['"]exact['"]/.test(window)
      const headOnly = /head\s*:\s*true/.test(window)
      // A nested relation inside a select string -- `clients!inner(tmc_id)`.
      // These are PostgREST joins and are the only part of the surface that
      // cannot be mechanically reimplemented; each needs hand-writing.
      const embedded = /\.select\(\s*['"`][^'"`]*\w+\s*\(/.test(window)

      for (const m of used) methodTotals.set(m, (methodTotals.get(m) ?? 0) + 1)
      tableTotals.set(table, (tableTotals.get(table) ?? 0) + 1)

      rows.push({
        file: relative(ROOT, file).replace(/\\/g, '/'),
        line: i + 1,
        table,
        terminal,
        counted,
        headOnly,
        embedded,
        methods: used.join(' '),
      })
    })
  }
}

// ── CSV ──────────────────────────────────────────────────────────────────────
const header = 'file,line,table,terminal,counted,head_only,embedded,methods'
const csv = [
  header,
  ...rows.map(r =>
    [r.file, r.line, r.table, r.terminal, r.counted, r.headOnly, r.embedded, `"${r.methods}"`].join(',')
  ),
].join('\n')

writeFileSync(join(ROOT, 'schema', 'callsites.csv'), csv + '\n', 'utf8')

// ── Summary ──────────────────────────────────────────────────────────────────
const pad = (s, n) => String(s).padEnd(n)
const num = (n, w = 5) => String(n).padStart(w)

console.log(`\n${rows.length} query call sites across ${new Set(rows.map(r => r.file)).size} files\n`)

console.log('Methods the shim must implement:')
;[...methodTotals.entries()]
  .sort((a, b) => b[1] - a[1])
  .forEach(([m, n]) => console.log(`  ${num(n)}  .${m}()`))

console.log('\nResult shape:')
for (const t of ['many', 'maybeSingle', 'single']) {
  console.log(`  ${num(rows.filter(r => r.terminal === t).length)}  ${t}`)
}
console.log(`  ${num(rows.filter(r => r.counted).length)}  count: 'exact'`)
console.log(`  ${num(rows.filter(r => r.headOnly).length)}  head: true`)

const embeds = rows.filter(r => r.embedded)
console.log(`\nEmbedded selects -- hand-written, cannot be mechanical (${embeds.length}):`)
embeds.forEach(r => console.log(`  ${r.file}:${r.line}  ${r.table}`))

console.log(`\nTop tables:`)
;[...tableTotals.entries()]
  .sort((a, b) => b[1] - a[1])
  .slice(0, 12)
  .forEach(([t, n]) => console.log(`  ${num(n)}  ${pad(t, 30)}`))

console.log('\n-> schema/callsites.csv\n')
