import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

// ── The architecture, as a test ──────────────────────────────────────────────
//   route  ->  app/lib (domain)  ->  app/lib/repositories  ->  PostgreSQL
//
// Stage 2 removed a compatibility shim that let 535 call sites build queries
// inline (`service.from('bookings').select(…)`), first against PostgREST and
// then against PostgreSQL. This keeps it removed. It replaces the migration's
// progress meter (scripts/shim-progress.mjs), whose job ended at zero -- the
// same rule, now failing the suite instead of printing a number.
//
// ESLint enforces the import boundaries too; this also catches what lint does
// not see: a `.from(` call through any client, and the deleted files coming
// back.
// ─────────────────────────────────────────────────────────────────────────────

const ROOT = process.cwd()
const rel = (path: string) => relative(ROOT, path).split(sep).join('/')

function* sourceFiles(dir: string, skip: readonly string[] = []): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    const r = rel(path)
    if (skip.some(s => r === s || r.startsWith(`${s}/`))) continue
    if (statSync(path).isDirectory()) yield* sourceFiles(path, skip)
    else if (/\.(ts|tsx|mjs)$/.test(name)) yield path
  }
}

const APP_SOURCE = [
  ...sourceFiles(join(ROOT, 'app')),
  join(ROOT, 'proxy.ts'),
].filter(p => !p.endsWith('.test.ts'))

const read = (path: string) => readFileSync(path, 'utf8')

describe('architecture', () => {
  it('no data call is built outside the repository layer', () => {
    // A `.from(` on anything but Array/Buffer/Object/Uint8Array is a query
    // builder: supabase-js, PostgREST, or the shim.
    const DATA_CALL = /(?<!Array|Buffer|Object|Uint8Array)\.from\(/
    const offenders = APP_SOURCE
      .filter(p => !rel(p).startsWith('app/lib/db/') && !rel(p).startsWith('app/lib/repositories/'))
      .flatMap(p => read(p).split('\n').map((line, i) => ({ p, i, line })))
      .filter(({ line }) => DATA_CALL.test(line) && !line.trim().startsWith('//'))
      .map(({ p, i }) => `${rel(p)}:${i + 1}`)
    expect(offenders).toEqual([])
  })

  it('the shim and its switches are gone', () => {
    const deleted = [
      'app/lib/db/builder.ts', 'app/lib/db/client.ts', 'app/lib/db/relationships.ts',
      'app/lib/db/schemaAllowList.ts', 'app/lib/db/schemaTables.generated.ts', 'app/lib/db/tx.ts',
      'app/lib/db/dualRun.ts',
    ]
    expect(deleted.filter(f => existsSync(join(ROOT, f)))).toEqual([])

    const everything = [...APP_SOURCE, ...sourceFiles(join(ROOT, 'scripts')), ...sourceFiles(join(ROOT, 'tests'))]
      .filter(p => rel(p) !== 'tests/architecture.test.ts')
    const SWITCHES = /createServiceClient|DB_DRIVER|DB_DUAL_RUN|DB_PARITY/
    expect(everything.filter(p => SWITCHES.test(read(p))).map(rel)).toEqual([])
  })

  it('Supabase is gone: no package, no client, no project URL (Stage 3)', () => {
    // Auth is app/lib/auth, data is app/lib/repositories, and the database is
    // reached through DATABASE_URL alone.
    const everything = [...APP_SOURCE, ...sourceFiles(join(ROOT, 'scripts')), ...sourceFiles(join(ROOT, 'tests'))]
      .filter(p => rel(p) !== 'tests/architecture.test.ts')
    const SUPABASE = /@supabase\/|supabase\.co\b|SUPABASE_|utils\/supabase/
    expect(everything.filter(p => SUPABASE.test(read(p))).map(rel)).toEqual([])
    expect(existsSync(join(ROOT, 'utils', 'supabase'))).toBe(false)
    const pkg = JSON.parse(read(join(ROOT, 'package.json')))
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })
    expect(deps.filter(d => d.startsWith('@supabase/'))).toEqual([])
  })

  it('pg and the sql tag are imported only by the driver and the repositories', () => {
    const DRIVER = /from ['"](pg|@\/app\/lib\/db\/sql|@\/app\/lib\/db\/fragments)['"]/
    const importers = APP_SOURCE
      .filter(p => !rel(p).startsWith('app/lib/db/') && !rel(p).startsWith('app/lib/repositories/'))
      .filter(p => DRIVER.test(read(p)))
      .map(rel)
    expect(importers).toEqual([])
  })

  // route() is where a request's database scope starts (no tenant until
  // sign-in decides one; app/lib/db/context.ts). A handler outside it runs
  // with whatever scope it inherits. These two read no tenant data.
  it('every API handler runs inside route()', () => {
    const OUTSIDE = ['app/api/health/route.ts', 'app/api/internal/test-amadeus/route.ts']
    const bare = APP_SOURCE
      .filter(p => /app\/api\/.*\/route\.ts$/.test(rel(p)) && !OUTSIDE.includes(rel(p)))
      .filter(p => /export (async )?function (GET|POST|PUT|PATCH|DELETE)\b|export const (GET|POST|PUT|PATCH|DELETE) = (?!route\()/.test(read(p)))
      .map(rel)
    expect(bare).toEqual([])
  })

  // Paging in the server means fetching every row first, so it is safe only
  // for a list whose size is bounded by design. These three are bounded by
  // what one TMC negotiates (hundreds; 5,000 deal codes measure 35 ms in npm
  // run scale), and status, which they filter on, is derived from dates. A
  // list that grows with clients, employees or bookings pages in SQL -- a new
  // entry here needs that argument made, not just a line added.
  it('only lists bounded by design are paged in server memory', () => {
    const ALLOWED = [
      'app/api/tmc/commercial-rules/route.ts',
      'app/api/tmc/deal-codes/route.ts',
      'app/api/tmc/forms-of-payment/route.ts',
    ]
    const callers = APP_SOURCE
      .filter(p => rel(p) !== 'app/lib/pagination.ts' && /\bpaginateInMemory\(/.test(read(p)))
      .map(rel)
      .sort()
    expect(callers).toEqual(ALLOWED)
  })

  // A paged endpoint fetched once, with no page and no ids, answers with its
  // first ten rows -- and a screen that builds a picker or a checklist from
  // that shows ten and silently hides the rest (Traveller profiles, Cost
  // centres, Policy, Approvals, Rule engine test and TC access all offered
  // only ten of 2,000 clients). Pickers use useLookup (server search plus
  // ?ids=), lists use usePagedList.
  it('no screen reads a paged list as if it were the whole list', () => {
    // Reads only `total` (how many people lack a manager), never the rows.
    const COUNT_ONLY = ['app/tmc/configurations/approvals/StepApprovers.tsx']
    const paged = APP_SOURCE
      .filter(p => /app\/api\/.*\/route\.ts$/.test(rel(p)) && /\bparsePageParams\(/.test(read(p)))
      .map(p => rel(p).replace(/^app/, '').replace(/\/route\.ts$/, ''))
    expect(paged).toContain('/api/tmc/clients')
    const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const offenders = APP_SOURCE
      .filter(p => p.endsWith('.tsx') && !COUNT_ONLY.includes(rel(p)))
      .flatMap(p => paged.flatMap(endpoint => {
        // A write (method: POST, PATCH...) is not a read of the list.
        const call = new RegExp(`fetch\\(\\s*[\`'"]${escape(endpoint)}(\\?[^\`'"]*)?[\`'"]([^)]{0,120})`, 'g')
        return [...read(p).matchAll(call)]
          // page / ids: paged or targeted. summary / all: the endpoint's own
          // documented opt-outs (counts only; the capped reporting tree).
          .filter(m => !/page=|ids=|summary=|all=/i.test(m[1] ?? '') && !/method:\s*['"](POST|PUT|PATCH|DELETE)/.test(m[2]))
          .map(() => `${rel(p)} -> ${endpoint}`)
      }))
    expect(offenders).toEqual([])
  })
})
