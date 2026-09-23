// ── shim-progress.mjs ────────────────────────────────────────────────────────
// How much of the application still reaches the database through the shim
// (or PostgREST). The Stage 2 checkpoint metric.
//
//   node scripts/shim-progress.mjs
//
// Counts source LINES containing a `.from(` data call outside the repository
// layer -- including `.from(table)` with a variable table name, which a
// literal-only pattern would miss and so report 0 while calls remained.
// `Array.from(` and friends are excluded.
//
// Stage 2 is done when this prints 0. The same rule, run against commit
// 7474437 (the last commit before Stage 2), gives the baseline below.
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const BASELINE = 535
const DATA_CALL = /(?<!Array|Buffer|Object|Uint8Array)\.from\(/

const ROOT = process.cwd()
const rel = path => relative(ROOT, path).split(sep).join('/')

// Not call sites: the driver and shim themselves, the repository layer that
// replaces them, and tests.
const EXCLUDED = ['app/lib/db', 'app/lib/repositories', 'tests', 'node_modules', '.next']

function* sourceFiles(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (EXCLUDED.some(e => rel(path) === e || rel(path).startsWith(`${e}/`))) continue
    if (statSync(path).isDirectory()) yield* sourceFiles(path)
    else if (/\.(ts|tsx)$/.test(name) && !name.endsWith('.test.ts')) yield path
  }
}

function areaOf(path) {
  const parts = rel(path).split('/')
  if (parts[0] === 'app' && parts[1] === 'api') {
    // Group /api/tmc/<thing>, /api/book/<thing> etc.; others by first segment.
    const grouped = ['tmc', 'book', 'platform', 'auth'].includes(parts[2])
    return parts.slice(0, grouped ? 4 : 3).join('/').replace(/\/route\.ts$/, '')
  }
  return parts.slice(0, Math.min(3, parts.length)).join('/')
}

const byArea = new Map()
let total = 0
const count = path => readFileSync(path, 'utf8').split(/\r?\n/).filter(l => DATA_CALL.test(l)).length

for (const root of ['app', 'utils']) {
  for (const path of sourceFiles(join(ROOT, root))) {
    const n = count(path)
    if (n === 0) continue
    byArea.set(areaOf(path), (byArea.get(areaOf(path)) ?? 0) + n)
    total += n
  }
}
const proxy = count(join(ROOT, 'proxy.ts'))
if (proxy > 0) { byArea.set('proxy.ts', proxy); total += proxy }

for (const [area, n] of [...byArea.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`${String(n).padStart(4)}  ${area}`)
}
console.log('─'.repeat(52))
console.log(`${String(total).padStart(4)}  remaining of ${BASELINE}  ` +
  `(${(((BASELINE - total) / BASELINE) * 100).toFixed(1)}% migrated)`)
