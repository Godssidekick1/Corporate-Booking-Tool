import { describe, it, expect, beforeAll, vi } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { call } from '../harness/call'
import { actors, type Actor, type Actors } from '../harness/actors'
import { resetDatabase } from '../harness/db'
import { mirrorTenant } from '../harness/mirrorTenant'
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

// ── Writes ───────────────────────────────────────────────────────────────────
// Every POST / PATCH / PUT, as the attacker, against the victim: detail routes
// get the victim's rows in their URL, and every body names the victim's rows
// in every field a route here reads an id from. Whatever a route answers,
// afterwards:
//   * every row the victim owns is byte-for-byte unchanged, and
//   * no row anywhere references one of the victim's ids more than before
//     (an attacker's own assignment pointing at the victim's client, say),
//   * and the response names none of the victim's ids.
// Checked after each call, so a finding names the call that caused it.

// Body field -> the table whose victim row it names.
const POISON_FIELDS: Record<string, string> = {
  clientId: 'clients', client_id: 'clients', owner_client_id: 'clients', ownerClientId: 'clients', targetId: 'clients',
  bucketId: 'buckets', bucket_id: 'buckets',
  dealCodeId: 'deal_codes', deal_code_id: 'deal_codes',
  ruleId: 'commercial_rules', rule_id: 'commercial_rules',
  fopId: 'forms_of_payment', fop_id: 'forms_of_payment',
  employeeId: 'employees', employee_id: 'employees', managerId: 'employees', manager_id: 'employees',
  owner_employee_id: 'employees', userId: 'employees', approver_user_id: 'employees', approverUserId: 'employees',
  categoryId: 'deal_code_categories', category_id: 'deal_code_categories',
  branchId: 'branches', branch_id: 'branches', office_id: 'branches',
  cost_centre_id: 'cost_centres',
  policyGroupId: 'policy_groups', policy_group_id: 'policy_groups',
  groupId: 'client_groups', client_group_id: 'client_groups', clientGroupId: 'client_groups',
  templateId: 'approval_chain_templates', chainTemplateId: 'approval_chain_templates', sourceId: 'approval_chain_templates',
  tripId: 'trips', trip_id: 'trips', bookingId: 'bookings', approvalId: 'approvals',
  payment_type_id: 'fop_payment_types', gds_entry_id: 'fop_gds_entries',
}
const LIST_FIELDS: Record<string, string> = { clientIds: 'clients', bucketIds: 'buckets', ids: 'clients' }

// A body naming one tenant's rows in every id field.
async function idsBody(tenant: { clientIds: string[]; tmcId: string | null }): Promise<Record<string, unknown>> {
  const body: Record<string, unknown> = {
    // Plausible values for the fields routes require alongside the ids, so a
    // request gets past "name is required" to the check that matters.
    name: 'leak-sweep', label: 'leak-sweep', code: 'LEAKSWEEP', kind: 'client', status: 'inactive', active: false,
  }
  const cache = new Map<string, string | null>()
  const rowOf = async (table: string) => {
    if (!cache.has(table)) cache.set(table, await victimRow(table, '', tenant.clientIds, tenant.tmcId))
    return cache.get(table)!
  }
  for (const [field, table] of Object.entries(POISON_FIELDS)) {
    const id = await rowOf(table)
    if (id) body[field] = id
  }
  for (const [field, table] of Object.entries(LIST_FIELDS)) {
    const id = await rowOf(table)
    if (id) body[field] = [id]
  }
  return body
}

// One of the attacker's own rows of `table`, as a body: valid for the route
// that creates such rows by construction, so it gets past every check except
// the one under test. Identity, timestamps and the default flag are dropped;
// names and codes are changed so a unique index does not refuse it first.
async function ownRow(table: string, tenant: { clientIds: string[]; tmcId: string | null }): Promise<Record<string, unknown> | null> {
  const id = await victimRow(table, '', tenant.clientIds, tenant.tmcId)
  if (!id) return null
  const row = (await db.query(`select row_to_json(t) as r from ${table} t where id = $1`, [id])).rows[0]?.r as Record<string, unknown>
  for (const k of ['id', 'created_at', 'updated_at', 'created_by', 'updated_by', 'is_default']) delete row[k]
  for (const k of Object.keys(row)) {
    if (['code', 'fop_code', 'group_code', 'name', 'label'].includes(k) && typeof row[k] === 'string') row[k] = `${row[k]}LS`
  }
  return row
}

// One string that changes if any victim row changes, or if any row anywhere
// gains a reference to a victim id.
async function fingerprintQuery(victim: { clientIds: string[]; tmcId: string | null }, foreign: Set<string>) {
  const { rows } = await db.query(`
    select c.table_name, array_agg(c.column_name::text order by c.column_name) as cols
      from information_schema.columns c join information_schema.tables t using (table_schema, table_name)
     where c.table_schema = 'public' and t.table_type = 'BASE TABLE' and c.data_type = 'uuid'
       and c.table_name not in ('deal_code_coverage', 'commercial_coverage', 'coverage_state', 'sessions', 'rate_limits', 'auth_attempts')
     group by c.table_name order by 1`)
  const parts: string[] = []
  for (const { table_name: t, cols } of rows as { table_name: string; cols: string[] }[]) {
    const set = new Set(cols)
    const owned: string[] = []
    if (victim.tmcId && set.has('tmc_id')) owned.push(`tmc_id = $1::uuid`)
    if (set.has('client_id')) owned.push(`client_id = any($2::uuid[])`)
    if (t === 'clients') owned.push(`id = any($2::uuid[])`)
    if (owned.length) {
      parts.push(`select '${t} rows' as k, md5(coalesce(string_agg(x::text, '|' order by x::text), '')) as v from ${t} x where ${owned.join(' or ')}`)
    }
    const refs = cols.filter(col => col !== 'id' && col !== 'tmc_id')
    if (refs.length) {
      parts.push(`select '${t} refs', count(*)::text from ${t} where ${refs.map(col => `${col} = any($3::uuid[])`).join(' or ')}`)
    }
  }
  // Names every parameter, so each has a type even when no table above used it.
  // First, and so it names the columns for the whole union: k, v.
  parts.unshift(`select 'params' as k, coalesce($1::uuid::text, '') || cardinality($2::uuid[]) || '/' || cardinality($3::uuid[]) as v`)
  const text = parts.join('\nunion all\n')
  const params = [victim.tmcId, victim.clientIds, [...foreign]]
  return async (): Promise<Map<string, string>> => {
    const prints = new Map((await db.query(text, params)).rows.map(r => [r.k as string, r.v as string]))
    // A fingerprint that names nothing would compare equal forever.
    if (prints.size < 10 || [...prints.keys()].some(k => typeof k !== 'string')) {
      throw new Error(`[leak sweep] fingerprint is malformed (${prints.size} entries)`)
    }
    return prints
  }
}

async function writeSweep(
  as: Actor,
  label: string,
  attacker: { clientIds: string[]; tmcId: string | null },
  victim: { clientIds: string[]; tmcId: string | null },
  foreign: Set<string>,
  only: (r: Route) => boolean = () => true
): Promise<{ findings: Finding[]; calls: number }> {
  const findings: Finding[] = []
  const fingerprint = await fingerprintQuery(victim, foreign)
  // own: the attacker's own rows in every id field, so a request passes the
  // checks it should pass; then one field at a time swapped for the victim's.
  const own = await idsBody(attacker)
  const theirs = await idsBody(victim)
  const plain = Object.fromEntries(Object.entries(own).filter(([k]) => !(k in POISON_FIELDS) && !(k in LIST_FIELDS)))
  const idFields = [...Object.keys(POISON_FIELDS), ...Object.keys(LIST_FIELDS)]
  const serverErrors = new Set<string>()
  let calls = 0
  for (const r of ROUTES.filter(only)) {
    const params: Record<string, string> = {}
    let url = '/api/' + r.path
    let unresolved = false
    for (let i = 0; i < r.segments.length; i++) {
      const seg = r.segments[i]
      if (!seg.startsWith('[')) continue
      const table = tableFor(r.segments, i)
      const id = table ? await victimRow(table, r.segments[i - 1], victim.clientIds, victim.tmcId) : null
      if (!table || !id) { unresolved = true; break }
      params[seg.slice(1, -1)] = id
      url = url.replace(seg, id)
    }
    if (unresolved) continue

    const mod = await import(/* @vite-ignore */ pathToFileURL(r.file).href) as Record<string, unknown>
    for (const method of ['POST', 'PATCH', 'PUT'] as const) {
      if (typeof mod[method] !== 'function') continue
      // Twice: a PLAIN body (fields only) asks "can I change your row through
      // its URL?"; the POISONED one, "can I point rows at yours?". One body
      // cannot ask both -- a route rightly refusing a foreign id in the body
      // never reaches the write the URL would have allowed.
      // Only the id fields this route's own code reads.
      const source = readFileSync(r.file, 'utf8')
      const fields = idFields.filter(k => k in own && k in theirs && new RegExp(`\\b${k}\\b`).test(source))
      // A collection route creating rows of a known table also gets a copy of
      // the attacker's own row as its base.
      const table = r.segments[r.segments.length - 1].startsWith('[') ? null : BY_FOLDER[r.segments[r.segments.length - 1]] ?? null
      const row = table ? await ownRow(table, attacker) : null
      const bases: [string, Record<string, unknown>][] = [['own ids', own], ...(row ? [['own row', { ...own, ...row }]] as [string, Record<string, unknown>][] : [])]
      const bodies: [string, Record<string, unknown>][] = [
        ['plain', plain], ...bases,
        ...bases.flatMap(([b, base]) => fields.map(k => [`${b}, victim ${k}`, { ...base, [k]: theirs[k] }] as [string, Record<string, unknown>])),
      ]
      for (const [kind, template] of bodies) {
        calls++
        // Codes and names unique to this call: an earlier call's successful
        // create would otherwise make this one fail on a unique index, before
        // the check under test.
        const sent = Object.fromEntries(Object.entries(template).map(([k, v]) =>
          [k, ['code', 'fop_code', 'group_code', 'name', 'label'].includes(k) && typeof v === 'string' ? `${v}${calls}` : v]))
        await db.query('delete from rate_limits')
        const before = await fingerprint()
        const res = await call(mod[method], { as, url, method, params, body: sent })
        const after = await fingerprint()
        const where = `${label} ${method} /api/${r.path} (${kind})`
        for (const [k, v] of after) {
          if (before.get(k) !== v) findings.push({ route: where, method, status: res.status, problem: `changed ${k}` })
        }
        const ok = res.status >= 200 && res.status < 300
        const leaked = ok ? leakedIds(res.json, foreign) : []
        if (leaked.length) findings.push({ route: where, method, status: res.status, problem: `returned ${leaked.length} foreign id(s)` })
        // Not a leak, but a route answering bad input with a 500 is a bug too.
        if (res.status >= 500) serverErrors.add(`${method} /api/${r.path} -> ${res.status}`)
      }
    }
  }
  console.info(`[leak sweep] ${label} writes: ${calls} calls over ${ROUTES.filter(only).length} routes`)
  if (serverErrors.size) {
    console.info(`[leak sweep] ${label} writes answered 5xx (bad-input handling to fix):\n  ${[...serverErrors].join('\n  ')}`)
  }
  return { findings, calls }
}

d('cross-tenant leak sweep', () => {
  let a: Actors

  beforeAll(async () => {
    await resetDatabase()
    a = await actors()
    if (!a.otherTmcAdmin) throw new Error('the template needs a second TMC with an admin')
    // The second TMC is empty in the template; stocked with a copy of the
    // first, so each side has rows of its own for a request to be built from.
    const { copied } = await mirrorTenant(a.tmcAdmin.tmc_id!, a.otherTmcAdmin.tmc_id!)
    console.info('[leak sweep] mirrored into the second TMC:', JSON.stringify(copied))
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

  it('another TMC can change nothing of this TMC, nor point anything at it', async () => {
    const tmcId = a.tmcAdmin.tmc_id!
    const clientIds = (await db.query('select id from clients where tmc_id = $1 order by id', [tmcId])).rows.map(r => r.id as string)
    const foreign = await ownedIds(clientIds, tmcId)
    const theirTmc = a.otherTmcAdmin!.tmc_id!
    const theirClients = (await db.query('select id from clients where tmc_id = $1 order by id', [theirTmc])).rows.map(r => r.id as string)
    const { findings, calls } = await writeSweep(a.otherTmcAdmin!, 'other-TMC', { clientIds: theirClients, tmcId: theirTmc }, { clientIds, tmcId }, foreign)
    expect(calls).toBeGreaterThan(60)
    expect(findings).toEqual([])
  }, 600_000)

  it('a corporate admin can change nothing of another client', async () => {
    const corp = a.corpAdmin
    const tmcId = corp.tmc_id ?? (await db.query('select tmc_id from clients where id = $1', [corp.client_id])).rows[0].tmc_id
    const other = (await db.query(`
      select c.id from clients c
       where c.tmc_id = $1 and c.id <> $2 and exists (select 1 from employees e where e.client_id = c.id)
       order by (select count(*) from bookings b where b.client_id = c.id) desc, c.id limit 1`,
      [tmcId, corp.client_id])).rows[0]?.id as string | undefined
    if (!other) throw new Error('the template needs a second client with employees in the same TMC')
    const foreign = await ownedIds([other], null)
    const corporate = (r: Route) => !r.path.startsWith('tmc/')
    const { findings, calls } = await writeSweep(corp, 'other-client', { clientIds: [corp.client_id!], tmcId: null }, { clientIds: [other], tmcId: null }, foreign, corporate)
    expect(calls).toBeGreaterThan(10)
    expect(findings).toEqual([])
  }, 600_000)
})
