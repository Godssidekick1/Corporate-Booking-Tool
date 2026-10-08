import { describe, it, expect, beforeAll, vi } from 'vitest'
import { readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { call } from '../harness/call'
import { actors, type Actor, type Actors } from '../harness/actors'
import { resetDatabase } from '../harness/db'
import { db } from '@/app/lib/db'

// ── Cross-tenant leak sweep ──────────────────────────────────────────────────
// Every API route, found on disk (so a new route is covered without anyone
// remembering to add it), called by someone who must not see the data:
//
//   1. another TMC's admin, against the first TMC: every GET, detail routes
//      given the first TMC's rows, and every DELETE of a first-TMC row;
//   2. a corporate admin, against another client of the same TMC.
//
// A response may be refused or may succeed, but it must never contain an id
// belonging to the other tenant; a detail route asked for another tenant's row
// must refuse outright; and DELETE must leave the row in place.
//
// Isolation is enforced in application code (every query filters by tenant);
// this is the test that fails when a query forgets to.
// ─────────────────────────────────────────────────────────────────────────────

// No provider call may happen from here.
vi.mock('@/app/lib/amadeus/client', async orig => {
  const real = await orig<Record<string, unknown>>()
  return new Proxy(real, {
    get: (t, k) => (typeof t[k as string] === 'function'
      ? () => { throw new Error('Amadeus called from the leak sweep') }
      : t[k as string]),
  })
})

const HAS_DB = Boolean(process.env.DATABASE_URL)
const d = HAS_DB ? describe : describe.skip

const API = join(process.cwd(), 'app', 'api')
// Sign-in flows, the internal provisioning hook, the platform console (its own
// role, own tests), and the token-guarded public ticket link.
const SKIP = [/^auth\//, /^internal\//, /^platform\//, /^public\//]

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return routeFiles(p)
    return name === 'route.ts' ? [p] : []
  })
}

interface Route { path: string; file: string; segments: string[] }
const ROUTES: Route[] = routeFiles(API)
  .map(file => {
    const path = relative(API, file).split(sep).slice(0, -1).join('/')
    return { path, file, segments: path.split('/') }
  })
  .filter(r => !SKIP.some(re => re.test(r.path + '/')))
  .sort((x, y) => x.path.localeCompare(y.path))

// Which table a dynamic segment names: by the segment, or by the folder above.
const BY_PARAM: Record<string, string> = { approvalId: 'approvals', bookingId: 'bookings', tripId: 'trips' }
const BY_FOLDER: Record<string, string> = {
  'approval-templates': 'approval_chain_templates', bands: 'bands', branches: 'branches', buckets: 'buckets',
  'client-groups': 'client_groups', clients: 'clients', 'commercial-rules': 'commercial_rules',
  'deal-codes': 'deal_codes', employees: 'employees', 'forms-of-payment': 'forms_of_payment',
  'policy-groups': 'policy_groups', tcs: 'employees', 'traveler-profiles': 'employees', users: 'employees',
}
// Narrower picks for folders that name a kind of employee.
const EXTRA: Record<string, string> = {
  tcs: `and t.role = 'tc'`, 'traveler-profiles': 'and t.client_id is not null', users: 'and t.client_id is not null',
}

function tableFor(segments: string[], i: number): string | null {
  return BY_PARAM[segments[i].slice(1, -1)] ?? BY_FOLDER[segments[i - 1]] ?? null
}

async function columnsOf(table: string): Promise<Set<string>> {
  const { rows } = await db.query(
    `select column_name from information_schema.columns where table_schema = 'public' and table_name = $1`, [table])
  return new Set(rows.map(r => r.column_name as string))
}

// "Belongs to the tenant": its tmc_id, or one of its clients' client_id.
function ownership(cols: Set<string>, tmcId: string | null, clientIds: string[], alias: string) {
  const params: unknown[] = []
  const where: string[] = []
  if (tmcId && cols.has('tmc_id')) where.push(`${alias}tmc_id = $${params.push(tmcId)}::uuid`)
  if (cols.has('client_id')) where.push(`${alias}client_id = any($${params.push(clientIds)}::uuid[])`)
  return { where, params }
}

// Every id of every row a tenant owns: rows with its tmc_id (for a TMC), and
// rows whose client_id is one of its clients.
async function ownedIds(clientIds: string[], tmcId: string | null): Promise<Set<string>> {
  const { rows: tables } = await db.query(`
    select table_name from information_schema.columns
     where table_schema = 'public' and column_name = 'id' order by 1`)
  const out = new Set<string>([...clientIds, ...(tmcId ? [tmcId] : [])])
  for (const { table_name: t } of tables as { table_name: string }[]) {
    const cols = await columnsOf(t)
    const { where, params } = ownership(cols, tmcId, clientIds, '')
    if (where.length === 0) continue
    const { rows } = await db.query(`select id from ${t} where ${where.join(' or ')}`, params)
    for (const r of rows) out.add(String(r.id))
  }
  return out
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g
function leakedIds(body: unknown, foreign: Set<string>): string[] {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  return [...new Set((text.match(UUID) ?? []).filter(id => foreign.has(id)))]
}

interface Finding { route: string; method: string; status: number; problem: string }

// One row of `table` belonging to the victim: a client of theirs, or a row
// with their tmc_id / one of their clients' client_id.
async function victimRow(table: string, folder: string, clientIds: string[], tmcId: string | null): Promise<string | null> {
  const { where, params } = table === 'clients'
    ? { where: ['t.id = any($1::uuid[])'], params: [clientIds] as unknown[] }
    : ownership(await columnsOf(table), tmcId, clientIds, 't.')
  if (where.length === 0) return null
  const { rows } = await db.query(
    `select t.id from ${table} t where (${where.join(' or ')}) ${EXTRA[folder] ?? ''} order by t.id limit 1`, params)
  return rows[0]?.id ?? null
}

async function sweep(
  as: Actor,
  label: string,
  victim: { clientIds: string[]; tmcId: string | null },
  foreign: Set<string>,
  only: (r: Route) => boolean = () => true
): Promise<{ findings: Finding[]; calls: number }> {
  const findings: Finding[] = []
  let calls = 0
  for (const r of ROUTES.filter(only)) {
    const params: Record<string, string> = {}
    let url = '/api/' + r.path
    let target: { table: string; id: string } | null = null
    let unresolved = false
    for (let i = 0; i < r.segments.length; i++) {
      const seg = r.segments[i]
      if (!seg.startsWith('[')) continue
      const table = tableFor(r.segments, i)
      const id = table ? await victimRow(table, r.segments[i - 1], victim.clientIds, victim.tmcId) : null
      if (!table || !id) { unresolved = true; break }
      params[seg.slice(1, -1)] = id
      url = url.replace(seg, id)
      target = { table, id }
    }
    if (unresolved) continue

    const mod = await import(/* @vite-ignore */ pathToFileURL(r.file).href) as Record<string, unknown>
    for (const method of ['GET', 'DELETE'] as const) {
      if (typeof mod[method] !== 'function' || (method === 'DELETE' && !target)) continue
      calls++
      const res = await call(mod[method], { as, url, method, params })
      const ok = res.status >= 200 && res.status < 300
      const leaked = ok ? leakedIds(res.json, foreign) : []
      const where = `${label} ${method} /api/${r.path}`
      if (leaked.length) {
        findings.push({ route: where, method, status: res.status, problem: `returned ${leaked.length} foreign id(s), e.g. ${leaked[0]}` })
      } else if (ok && target && method === 'GET') {
        findings.push({ route: where, method, status: res.status, problem: 'answered 2xx for another tenant\'s row' })
      }
      if (method === 'DELETE' && target) {
        const still = (await db.query(`select 1 from ${target.table} where id = $1`, [target.id])).rowCount
        if (!still) findings.push({ route: where, method, status: res.status, problem: 'DELETED another tenant\'s row' })
      }
    }
  }
  console.info(`[leak sweep] ${label}: ${calls} calls over ${ROUTES.filter(only).length} routes`)
  return { findings, calls }
}

d('cross-tenant leak sweep', () => {
  let a: Actors

  beforeAll(async () => {
    await resetDatabase()
    a = await actors()
    if (!a.otherTmcAdmin) throw new Error('the template needs a second TMC with an admin')
  }, 60_000)

  it('another TMC sees nothing of this TMC, and can delete nothing of it', async () => {
    const tmcId = a.tmcAdmin.tmc_id!
    const clientIds = (await db.query('select id from clients where tmc_id = $1 order by id', [tmcId])).rows.map(r => r.id as string)
    const foreign = await ownedIds(clientIds, tmcId)
    const { findings, calls } = await sweep(a.otherTmcAdmin!, 'other-TMC', { clientIds, tmcId }, foreign)
    expect(calls).toBeGreaterThan(60)
    expect(findings).toEqual([])
  }, 300_000)

  it('a corporate admin sees nothing of another client', async () => {
    const corp = a.corpAdmin
    const tmcId = corp.tmc_id ?? (await db.query('select tmc_id from clients where id = $1', [corp.client_id])).rows[0].tmc_id
    const other = (await db.query(`
      select c.id from clients c
       where c.tmc_id = $1 and c.id <> $2 and exists (select 1 from employees e where e.client_id = c.id)
       order by (select count(*) from bookings b where b.client_id = c.id) desc, c.id limit 1`,
      [tmcId, corp.client_id])).rows[0]?.id as string | undefined
    if (!other) throw new Error('the template needs a second client with employees in the same TMC')
    const foreign = await ownedIds([other], null)
    // Corporate routes, given the OTHER client's rows.
    const corporate = (r: Route) => !r.path.startsWith('tmc/')
    const { findings, calls } = await sweep(corp, 'other-client', { clientIds: [other], tmcId: null }, foreign, corporate)
    expect(calls).toBeGreaterThan(10)
    expect(findings).toEqual([])
  }, 300_000)
})
