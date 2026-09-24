import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { GET as dealsGet, POST as dealsPost } from '@/app/api/tmc/deal-codes/route'
import { GET as dealGet, PATCH as dealPatch, DELETE as dealDelete } from '@/app/api/tmc/deal-codes/[id]/route'
import { GET as effectiveGet } from '@/app/api/tmc/deal-codes/effective/route'
import { GET as csvGet, POST as csvPost } from '@/app/api/tmc/deal-codes/csv/route'
import { GET as assignmentsGet, POST as assignmentsPost, DELETE as assignmentsDelete } from '@/app/api/tmc/deal-code-assignments/route'
import { GET as categoriesGet } from '@/app/api/tmc/deal-code-categories/route'
import { call } from '../harness/call'
import { actors, type Actors } from '../harness/actors'
import { resetDatabase } from '../harness/db'
import { db } from '@/app/lib/db'
import { sql, many, one, exec } from '@/app/lib/db/sql'

// ── The deal code master ─────────────────────────────────────────────────────
// Negotiated codes, the categories that say which code types each kind of
// content can carry, who each deal reaches, the resolved coverage per client,
// and the spreadsheet round trip.
//
// Deal status is derived from today's date, so the clock is frozen. Rows this
// run creates get random ids; snapshots label them.
// ─────────────────────────────────────────────────────────────────────────────

const HAS_DB = Boolean(process.env.DATABASE_URL)
const d = HAS_DB ? describe : describe.skip

const NO_SUCH_ID = '00000000-0000-0000-0000-0000000c0ffe'

const created = new Map<string, string>()
function scrub<T>(value: T): T {
  // Children are revived before their parent, so by the time a row object is
  // seen its id is already a label -- and its database timestamps are masked.
  return JSON.parse(JSON.stringify(value), (_key, v) => {
    if (typeof v === 'string' && created.has(v)) return created.get(v)
    if (v && typeof v === 'object' && typeof v.id === 'string' && v.id.startsWith('<')) {
      for (const k of ['created_at', 'updated_at']) if (k in v) v[k] = '<db time>'
    }
    return v
  })
}

interface Paged<T> { items: T[]; total: number }
interface Deal { id: string; code: string; status: string; targetCount: number; category_id: string }

d('deal codes', () => {
  let a: Actors
  let bsp: string       // this TMC's DOMAIRBSP category
  let lcc: string       // this TMC's DOMAIRLCC category (no tour codes)
  let theirs: string    // a category at another TMC
  let clientId: string
  let theirClient: string | null

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-23T12:00:00Z'))
    await resetDatabase()
    a = await actors()
    const category = (tmcId: string | null, code: string) => one<{ id: string }>(db, sql`
      select id from deal_code_categories where tmc_id = ${tmcId} and code = ${code}`)
    bsp = (await category(a.tmcAdmin.tmc_id, 'DOMAIRBSP')).id
    lcc = (await category(a.tmcAdmin.tmc_id, 'DOMAIRLCC')).id
    theirs = (await category(a.otherTmcAdmin!.tmc_id, 'DOMAIRBSP')).id
    clientId = (await one<{ id: string }>(db, sql`
      select id from clients where tmc_id = ${a.tmcAdmin.tmc_id} order by name, id limit 1`)).id
    theirClient = (await many<{ id: string }>(db, sql`
      select id from clients where tmc_id <> ${a.tmcAdmin.tmc_id} order by id limit 1`))[0]?.id ?? null
  })
  afterAll(() => { vi.useRealTimers() })

  const list = (query = '', as = a.tmcAdmin) => call(dealsGet, { as, url: `/api/tmc/deal-codes${query}` })
  const create = (body: Record<string, unknown>) => call(dealsPost, {
    as: a.tmcAdmin, method: 'POST', url: '/api/tmc/deal-codes',
    body: { category_id: bsp, airline_code: 'AI', code: 'tc123', code_type: 'TC', ...body },
  })

  // ── The master list ────────────────────────────────────────────────────────

  it('list: the TMC\'s deals, enriched with category, status and reach', async () => {
    const res = await list()
    expect(res.status).toBe(200)
    expect(scrub(res.json)).toMatchSnapshot()
  })

  it('list: filters by category, type, status and search', async () => {
    const all = (await list()).json as Paged<Deal>
    const first = all.items[0]
    const byCategory = (await list(`?categoryId=${first.category_id}`)).json as Paged<Deal>
    expect(byCategory.items.every(dl => dl.category_id === first.category_id)).toBe(true)
    const byStatus = (await list(`?status=${first.status}`)).json as Paged<Deal>
    expect(byStatus.items.every(dl => dl.status === first.status)).toBe(true)
    const bySearch = (await list(`?search=${encodeURIComponent(first.code.slice(0, 3))}`)).json as Paged<Deal>
    expect(bySearch.items.map(dl => dl.id)).toContain(first.id)
    expect(((await list('?type=ZZ')).json as Paged<Deal>).items).toEqual([])
  })

  it('list: other tenants and people without the permission', async () => {
    const theirs_ = (await list('', a.otherTmcAdmin!)).json as Paged<Deal>
    const mine = (await list()).json as Paged<Deal>
    expect(theirs_.items.map(dl => dl.id).filter(id => mine.items.some(m => m.id === id))).toEqual([])
    expect((await list('', a.corpAdmin)).status).toBe(403)
    expect((await call(dealsGet, { as: null, url: '/api/tmc/deal-codes' })).status).toBe(401)
  })

  // ── Create ─────────────────────────────────────────────────────────────────

  let fresh: string

  it('create: validation', async () => {
    expect(await create({ category_id: undefined })).toEqual({ status: 400, json: { error: 'Airline category is required' } })
    expect((await create({ category_id: theirs })).status).toBe(404)
    expect((await create({ airline_code: ' ' })).json).toEqual({ error: 'A deal code has to name an airline' })
    expect((await create({ code: ' ' })).json).toEqual({ error: 'Code cannot be empty' })
    expect((await create({ code_type: 'XX' })).json).toEqual({ error: 'Unknown code type: XX' })
    expect((await create({ category_id: lcc })).json).toEqual({ error: 'Tour code is not available for DOMAIRLCC content' })
    expect((await create({ sales_from: '2026-10-02', sales_to: '2026-10-01' })).json)
      .toEqual({ error: 'Sales to is before sales from' })
    expect((await create({ travel_from: '2026-10-02', travel_to: '2026-10-01' })).json)
      .toEqual({ error: 'Travel to is before travel from' })
  })

  it('create: uppercased, active by default, reaching nobody yet', async () => {
    const res = await create({ airline_code: 'ai', notes: '  keep  ', travel_to: '2027-01-31' })
    expect(res.status).toBe(200)
    const deal = (res.json as { dealCode: Deal }).dealCode
    fresh = deal.id
    created.set(fresh, '<fresh deal>')
    expect(scrub(res.json)).toMatchSnapshot()
    expect(await one(db, sql`select tmc_id, created_by from deal_codes where id = ${fresh}`))
      .toEqual({ tmc_id: a.tmcAdmin.tmc_id, created_by: a.tmcAdmin.id })
  })

  // ── One deal ───────────────────────────────────────────────────────────────

  const one_ = (id: string, as = a.tmcAdmin) => call(dealGet, { as, url: `/api/tmc/deal-codes/${id}`, params: { id } })
  const patch = (id: string, body: unknown) =>
    call(dealPatch, { as: a.tmcAdmin, method: 'PATCH', url: `/api/tmc/deal-codes/${id}`, params: { id }, body })
  const remove = (id: string) =>
    call(dealDelete, { as: a.tmcAdmin, method: 'DELETE', url: `/api/tmc/deal-codes/${id}`, params: { id } })

  it('one: with its assignments named; another TMC cannot see it', async () => {
    const assigned = await one<{ id: string }>(db, sql`
      select deal_code_id as id from deal_code_assignments where tmc_id = ${a.tmcAdmin.tmc_id}
      order by created_at, id limit 1`)
    const res = await one_(assigned.id)
    expect(res.status).toBe(200)
    expect(scrub(res.json)).toMatchSnapshot()
    expect(await one_(assigned.id, a.otherTmcAdmin!)).toEqual({ status: 404, json: { error: 'Deal code not found' } })
    expect((await one_(NO_SUCH_ID)).status).toBe(404)
  })

  it('edit: validated against what will be stored', async () => {
    // Moving the tour code onto LCC content makes its existing type invalid.
    expect((await patch(fresh, { category_id: lcc })).json)
      .toEqual({ error: 'Tour code is not available for DOMAIRLCC content' })
    expect((await patch(fresh, { category_id: theirs })).status).toBe(404)
    const res = await patch(fresh, { code: ' new1 ', active: false, notes: null })
    expect(res.status).toBe(200)
    expect(res.json).toMatchObject({ ok: true, dealCode: { code: 'NEW1', active: false, notes: null, status: 'inactive' } })
    const moved = await patch(fresh, { category_id: lcc, code_type: 'DC' })
    expect(moved.json).toMatchObject({ dealCode: { category_id: lcc, code_type: 'DC' } })
  })

  // ── Assignments ────────────────────────────────────────────────────────────

  const assign = (body: unknown, as = a.tmcAdmin) =>
    call(assignmentsPost, { as, method: 'POST', url: '/api/tmc/deal-code-assignments', body })

  it('assign: validation and tenancy, then several targets at once, idempotently', async () => {
    expect((await assign({ dealCodeId: fresh, targets: [] })).status).toBe(400)
    expect((await assign({ dealCodeId: NO_SUCH_ID, targets: [{ kind: 'client', id: clientId }] })).status).toBe(404)
    expect((await assign({ dealCodeId: fresh, targets: [{ kind: 'planet', id: clientId }] })).json)
      .toEqual({ error: 'Unknown target kind: planet' })
    if (theirClient) {
      expect(await assign({ dealCodeId: fresh, targets: [{ kind: 'client', id: theirClient }] }))
        .toEqual({ status: 422, json: { error: 'That client does not belong to your TMC' } })
    }
    const group = (await many<{ id: string }>(db, sql`
      select id from client_groups where tmc_id = ${a.tmcAdmin.tmc_id} order by id limit 1`))[0]
    const targets = [{ kind: 'client', id: clientId }, ...(group ? [{ kind: 'client_group', id: group.id }] : [])]
    expect(await assign({ dealCodeId: fresh, targets })).toEqual({ status: 200, json: { ok: true, assigned: targets.length } })
    // Again: the duplicates are ignored, not an error.
    expect(await assign({ dealCodeId: fresh, targets })).toEqual({ status: 200, json: { ok: true, assigned: targets.length } })
    expect((await many(db, sql`select kind from deal_code_assignments where deal_code_id = ${fresh}`)).length)
      .toBe(targets.length)
  })

  it('assignments: listed per deal, TMC-scoped', async () => {
    const res = await call(assignmentsGet, { as: a.tmcAdmin, url: `/api/tmc/deal-code-assignments?dealCodeId=${fresh}` })
    const rows = (res.json as { assignments: { kind: string; deal_code_id: string }[] }).assignments
    expect(rows.map(r => r.kind).sort()).toEqual(rows.length === 2 ? ['client', 'client_group'] : ['client'])
    expect(rows.every(r => r.deal_code_id === fresh)).toBe(true)
    const all = (await call(assignmentsGet, { as: a.otherTmcAdmin!, url: '/api/tmc/deal-code-assignments' })).json as
      { assignments: { deal_code_id: string }[] }
    expect(all.assignments.some(r => r.deal_code_id === fresh)).toBe(false)
  })

  it('coverage: which code wins for each client, and why', async () => {
    const res = await call(effectiveGet, { as: a.tmcAdmin, url: '/api/tmc/deal-codes/effective?pageSize=100' })
    expect(res.status).toBe(200)
    expect(scrub(res.json)).toMatchSnapshot()
    const narrowed = await call(effectiveGet, { as: a.tmcAdmin, url: `/api/tmc/deal-codes/effective?clientId=${clientId}` })
    const items = (narrowed.json as Paged<{ clientId: string }>).items
    expect(items.length).toBeGreaterThan(0)
    expect(items.every(i => i.clientId === clientId)).toBe(true)
    const searched = await call(effectiveGet, { as: a.tmcAdmin, url: '/api/tmc/deal-codes/effective?search=new1' })
    expect((searched.json as Paged<{ code: string }>).items.every(i => i.code === 'NEW1')).toBe(true)
  })

  it('delete: refused while assigned; unassign, then delete', async () => {
    const res = await remove(fresh)
    expect(res.status).toBe(409)
    expect((res.json as { error: string }).error).toMatch(/^"NEW1" is assigned to \d targets?\./)
    const ids = await many<{ id: string }>(db, sql`select id from deal_code_assignments where deal_code_id = ${fresh}`)
    // Another TMC cannot remove them: scoped by tenant in the delete itself.
    await call(assignmentsDelete, {
      as: a.otherTmcAdmin!, method: 'DELETE', url: `/api/tmc/deal-code-assignments?id=${ids[0].id}` })
    expect((await many(db, sql`select id from deal_code_assignments where deal_code_id = ${fresh}`)).length).toBe(ids.length)
    for (const { id } of ids) {
      expect((await call(assignmentsDelete, {
        as: a.tmcAdmin, method: 'DELETE', url: `/api/tmc/deal-code-assignments?id=${id}` })).json).toEqual({ ok: true })
    }
    expect(await remove(fresh)).toEqual({ status: 200, json: { ok: true } })
    expect(await many(db, sql`select id from deal_codes where id = ${fresh}`)).toEqual([])
  })

  // ── The spreadsheet ────────────────────────────────────────────────────────

  it('csv: the download is the template', async () => {
    const res = await call(csvGet, { as: a.tmcAdmin, url: '/api/tmc/deal-codes/csv' })
    expect(res.status).toBe(200)
    expect(res.json).toMatchSnapshot()
  })

  it('csv: a dry run reports every row and writes nothing; the real run writes the good ones', async () => {
    const rows = [
      { code: 'imp1', code_type: 'dc', airline_code: '6e', category: 'domairlcc', travel_from: '2026-10-01', active: '' },
      { code: '', code_type: 'DC', airline_code: '6E', category: 'DOMAIRLCC' },
      { code: 'X2', code_type: 'DC', airline_code: '', category: 'DOMAIRLCC' },
      { code: 'X3', code_type: 'ZZ', airline_code: '6E', category: 'DOMAIRLCC' },
      { code: 'X4', code_type: 'DC', airline_code: '6E', category: 'NOPE' },
      { code: 'X5', code_type: 'TC', airline_code: '6E', category: 'DOMAIRLCC' },
      { code: 'X6', code_type: 'DC', airline_code: '6E', category: 'DOMAIRLCC', sales_from: '01/10/2026' },
      { code: 'X7', code_type: 'DC', airline_code: '6E', category: 'DOMAIRLCC', travel_from: '2026-10-02', travel_to: '2026-10-01' },
      { code: 'imp2', code_type: 'PF', airline_code: 'AI', category: 'DOMAIRBSP', active: 'no', notes: ' n ' },
    ]
    const before = (await many(db, sql`select id from deal_codes where tmc_id = ${a.tmcAdmin.tmc_id}`)).length
    const dry = await call(csvPost, { as: a.tmcAdmin, method: 'POST', url: '/api/tmc/deal-codes/csv', body: { rows, dryRun: true } })
    expect(dry.json).toMatchSnapshot()
    expect((await many(db, sql`select id from deal_codes where tmc_id = ${a.tmcAdmin.tmc_id}`)).length).toBe(before)

    const real = await call(csvPost, { as: a.tmcAdmin, method: 'POST', url: '/api/tmc/deal-codes/csv', body: { rows } })
    expect(real.json).toMatchObject({ ok: true, imported: 2, rejected: 7 })
    expect(await many(db, sql`
      select code, code_type, airline_code, active, notes, travel_from from deal_codes
      where tmc_id = ${a.tmcAdmin.tmc_id} and code in ('IMP1', 'IMP2') order by code`)).toEqual([
      { code: 'IMP1', code_type: 'DC', airline_code: '6E', active: true, notes: null, travel_from: '2026-10-01' },
      { code: 'IMP2', code_type: 'PF', airline_code: 'AI', active: false, notes: 'n', travel_from: null },
    ])
    expect((await call(csvPost, { as: a.tmcAdmin, method: 'POST', url: '/api/tmc/deal-codes/csv', body: { rows: [] } })).json)
      .toEqual({ error: 'The file has no rows' })
  })

  // ── Categories ─────────────────────────────────────────────────────────────

  it('categories: each with the code types it permits', async () => {
    const res = await call(categoriesGet, { as: a.tmcAdmin, url: '/api/tmc/deal-code-categories' })
    expect(res.status).toBe(200)
    expect(scrub(res.json)).toMatchSnapshot()
  })

  it('categories: a TMC with none is seeded with the defaults on first read', async () => {
    const tmc = (await one<{ id: string }>(db, sql`insert into tmcs (name) values ('Seedless TMC') returning id`)).id
    const admin = (await one<{ id: string }>(db, sql`
      insert into employees (id, tmc_id, full_name, email, role, status)
      values (gen_random_uuid(), ${tmc}, 'Seed Admin', 'seed.admin@example.test', 'tmc_admin', 'active')
      returning id`)).id
    await exec(db, sql`delete from deal_code_categories where tmc_id = ${tmc}`)
    const res = await call(categoriesGet, { as: { id: admin }, url: '/api/tmc/deal-code-categories' })
    expect(res.status).toBe(200)
    const cats = (res.json as { categories: { code: string; allowedTypes: string[] }[] }).categories
    expect(cats.map(c => [c.code, [...c.allowedTypes].sort()])).toEqual([
      ['DOMAIRBSP', ['DC', 'PC', 'PF', 'TC', 'TR']],
      ['DOMAIRLCC', ['DC', 'PC', 'TR']],
      ['INTAIRBSP', ['DC', 'PC', 'PF', 'TC', 'TR']],
      ['INTAIRLCC', ['DC', 'PC', 'TR']],
    ])
    // A second read finds them rather than seeding again.
    await call(categoriesGet, { as: { id: admin }, url: '/api/tmc/deal-code-categories' })
    expect((await many(db, sql`select id from deal_code_categories where tmc_id = ${tmc}`)).length).toBe(4)
  })
})
