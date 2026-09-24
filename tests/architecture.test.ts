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
  ...sourceFiles(join(ROOT, 'utils')),
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
      'app/lib/db/dualRun.ts', 'utils/supabase/service.ts',
    ]
    expect(deleted.filter(f => existsSync(join(ROOT, f)))).toEqual([])

    const everything = [...APP_SOURCE, ...sourceFiles(join(ROOT, 'scripts')), ...sourceFiles(join(ROOT, 'tests'))]
      .filter(p => rel(p) !== 'tests/architecture.test.ts')
    const SWITCHES = /createServiceClient|DB_DRIVER|DB_DUAL_RUN|DB_PARITY/
    expect(everything.filter(p => SWITCHES.test(read(p))).map(rel)).toEqual([])
  })

  it('Supabase is imported only by the auth wrappers', () => {
    const allowed = new Set([
      'utils/supabase/server.ts', 'utils/supabase/client.ts', 'utils/supabase/admin.ts',
      'proxy.ts', 'app/api/auth/verify/route.ts',
    ])
    const importers = APP_SOURCE.filter(p => /from ['"]@supabase\//.test(read(p))).map(rel)
    expect(importers.filter(p => !allowed.has(p))).toEqual([])
  })

  it('pg and the sql tag are imported only by the driver and the repositories', () => {
    const DRIVER = /from ['"](pg|@\/app\/lib\/db\/sql|@\/app\/lib\/db\/fragments)['"]/
    const importers = APP_SOURCE
      .filter(p => !rel(p).startsWith('app/lib/db/') && !rel(p).startsWith('app/lib/repositories/'))
      .filter(p => DRIVER.test(read(p)))
      .map(rel)
    expect(importers).toEqual([])
  })
})
