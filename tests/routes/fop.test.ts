import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { GET as fopsGet, POST as fopsPost } from '@/app/api/tmc/forms-of-payment/route'
import { GET as fopGet, PATCH as fopPatch, DELETE as fopDelete } from '@/app/api/tmc/forms-of-payment/[id]/route'
import {
  GET as mappingsGet, POST as mappingsPost, PATCH as mappingPatch, DELETE as mappingDelete,
} from '@/app/api/tmc/fop-assignments/route'
import { GET as codesGet } from '@/app/api/tmc/fop-codes/route'
import { call } from '../harness/call'
import { actors, type Actors } from '../harness/actors'
import { resetDatabase } from '../harness/db'
import { db } from '@/app/lib/db'
import { sql, many, one, exec } from '@/app/lib/db/sql'

// ── Forms of payment ─────────────────────────────────────────────────────────
// Payment methods, the two code lists they are built from, and who each one
// applies to. These are payment instruments, so WHO CAN SEE ONE is tested as
// carefully as what it contains: the TMC sees all, a corporate admin their
// company's and their own, a traveller only their own.
//
// Status depends on card expiry against today, so the clock is frozen.
// ─────────────────────────────────────────────────────────────────────────────

const HAS_DB = Boolean(process.env.DATABASE_URL)
const d = HAS_DB ? describe : describe.skip

const NO_SUCH_ID = '00000000-0000-0000-0000-0000000c0ffe'

const created = new Map<string, string>()
function scrub<T>(value: T): T {
  return JSON.parse(JSON.stringify(value), (_key, v) => {
    if (typeof v === 'string' && created.has(v)) return created.get(v)
    if (v && typeof v === 'object' && typeof v.id === 'string' && v.id.startsWith('<')) {
      for (const k of ['created_at', 'updated_at']) if (k in v) v[k] = '<db time>'
    }
    return v
  })
}

interface Paged<T> { items: T[]; total: number }
interface Fop { id: string; label: string; payer: string; is_default: boolean; status: string; owner_client_id: string | null }

d('forms of payment', () => {
  let a: Actors
  let bcg: string
  let branch: string
  let cardType: string   // payment type that requires a card
  let cashType: string   // payment type that does not
  let gds: string
  let traveller: { id: string }
  let theirClient: string | null
  let theirBranch: string | null

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-23T12:00:00Z'))
    await resetDatabase()
    a = await actors()
    bcg = a.corpAdmin.client_id!
    const tmc = a.tmcAdmin.tmc_id!
    branch = (await one<{ id: string }>(db, sql`select id from branches where tmc_id = ${tmc} order by id limit 1`)).id
    cardType = (await one<{ id: string }>(db, sql`
      select id from fop_payment_types where tmc_id = ${tmc} and requires_card order by code limit 1`)).id
    cashType = (await one<{ id: string }>(db, sql`
      select id from fop_payment_types where tmc_id = ${tmc} and not requires_card order by code limit 1`)).id
    gds = (await one<{ id: string }>(db, sql`select id from fop_gds_entries where tmc_id = ${tmc} order by code limit 1`)).id
    traveller = await one<{ id: string }>(db, sql`
      select id from employees where client_id = ${bcg} and role = 'employee' and status = 'active' order by id limit 1`)
    theirClient = (await many<{ id: string }>(db, sql`select id from clients where tmc_id <> ${tmc} order by id limit 1`))[0]?.id ?? null
    theirBranch = (await many<{ id: string }>(db, sql`select id from branches where tmc_id <> ${tmc} order by id limit 1`))[0]?.id ?? null
  })
  afterAll(() => { vi.useRealTimers() })

  const list = (query = '', as: { id: string } = a.tmcAdmin) => call(fopsGet, { as, url: `/api/tmc/forms-of-payment${query}` })
  const create = (body: Record<string, unknown>) => call(fopsPost, {
    as: a.tmcAdmin, method: 'POST', url: '/api/tmc/forms-of-payment',
    body: { label: 'Test card', payer: 'agency', payment_type_id: cardType, card_type: 'VI', last4: '4242',
      expiry_month: 12, expiry_year: 2030, ...body },
  })

  // ── Who sees what ──────────────────────────────────────────────────────────

  it('list: the TMC sees every form of payment, described and with status', async () => {
    const res = await list('?pageSize=50')
    expect(res.status).toBe(200)
    expect(scrub(res.json)).toMatchSnapshot()
  })

  it('list: a corporate admin sees their company\'s cards and their own, nothing else', async () => {
    const res = await list('', a.corpAdmin)
    expect(res.status).toBe(200)
    const items = (res.json as Paged<Fop>).items
    expect(items.length).toBeGreaterThan(0)
    expect(items.every(f => f.owner_client_id === bcg)).toBe(true)
  })

  it('list: a traveller sees only their own cards', async () => {
    expect(((await list('', traveller)).json as Paged<Fop>).items).toEqual([])
  })

  it('list: filters and search', async () => {
    const byPayer = (await list('?payer=corporate')).json as Paged<Fop>
    expect(byPayer.items.map(f => f.payer)).toEqual(byPayer.items.map(() => 'corporate'))
    const byType = (await list('?type=cash')).json as Paged<Fop & { fop_type: string }>
    expect(byType.items.every(f => f.fop_type === 'cash')).toBe(true)
    const byOwner = (await list(`?ownerClientId=${bcg}`)).json as Paged<Fop>
    expect(byOwner.items.every(f => f.owner_client_id === bcg)).toBe(true)
    const bySearch = (await list('?search=amex')).json as Paged<Fop>
    expect(bySearch.items.map(f => f.label).sort()).toEqual(['AMEX_BCG_FOP_LIQUID', 'Credit AMEX'])
    const all = (await list()).json as Paged<Fop>
    const byIds = (await list(`?ids=${all.items[0].id}`)).json as Paged<Fop>
    expect(byIds.items.map(f => f.id)).toEqual([all.items[0].id])
  })

  it('list: another TMC sees none of these', async () => {
    const mine = ((await list()).json as Paged<Fop>).items.map(f => f.id)
    const theirs = ((await list('', a.otherTmcAdmin!)).json as Paged<Fop>).items.map(f => f.id)
    expect(theirs.filter(id => mine.includes(id))).toEqual([])
  })

  // ── Create ─────────────────────────────────────────────────────────────────

  let fresh: string

  it('create: validation', async () => {
    expect((await create({ label: ' ' })).json).toEqual({ error: 'Give this a label — it is what a counsellor picks it by.' })
    expect((await create({ payer: 'friend' })).json).toEqual({ error: 'Unknown payer: friend' })
    expect((await create({ card_type: null })).json).toEqual({ error: 'Pick a card type.' })
    expect((await create({ last4: '4242424242424242' })).json)
      .toEqual({ error: 'Enter only the last four digits — full card numbers are never stored.' })
    expect((await create({ expiry_month: 13 })).json).toEqual({ error: 'Expiry month must be between 1 and 12.' })
    expect((await create({ payer: 'corporate' })).json).toEqual({ error: 'A corporate card belongs to a client — pick which one.' })
    expect((await create({ payer: 'traveller' })).json).toEqual({ error: 'A traveller card belongs to a person — pick who.' })
    expect((await create({ payment_type_id: NO_SUCH_ID })).json).toEqual({ error: 'That payment type does not belong to your TMC' })
    expect((await create({ gds_entry_id: NO_SUCH_ID })).json).toEqual({ error: 'That GDS entry does not belong to your TMC' })
    if (theirBranch) expect((await create({ branch_id: theirBranch })).status).toBe(422)
    if (theirClient) {
      expect(await create({ payer: 'corporate', owner_client_id: theirClient }))
        .toEqual({ status: 422, json: { error: 'That client does not belong to your TMC' } })
    }
    expect((await call(fopsPost, { as: a.corpAdmin, method: 'POST', url: '/api/tmc/forms-of-payment', body: {} })).status).toBe(403)
  })

  it('create: a cash payment type clears the card fields rather than refusing them', async () => {
    const res = await create({ label: ' Cash desk ', payment_type_id: cashType, gds_entry_id: gds, fop_code: ' cd9 ' })
    expect(res.status).toBe(200)
    expect(res.json).toMatchObject({ ok: true, fop: {
      label: 'Cash desk', fop_code: 'CD9', fop_type: 'cash', card_type: null, last4: null, expiry_month: null } })
    created.set((res.json as { fop: Fop }).fop.id, '<cash desk>')
  })

  it('create: a traveller card for this TMC\'s traveller, set as the default', async () => {
    const res = await create({ label: 'Road warrior', payer: 'traveller', owner_employee_id: traveller.id,
      owner_client_id: bcg, branch_id: branch, is_default: true, rbd_spec: 'y,b', airline_code: 'ai' })
    expect(res.status).toBe(200)
    const fop = (res.json as { fop: Fop }).fop
    fresh = fop.id
    created.set(fresh, '<road warrior>')
    expect(scrub(res.json)).toMatchSnapshot()
    // Owner client is cleared: a traveller card belongs to a person.
    expect(fop.owner_client_id).toBeNull()
    // And now the traveller can see it.
    expect(((await list('', traveller)).json as Paged<Fop>).items.map(f => f.id)).toEqual([fresh])
  })

  it('create: ticking default on a second one swaps it', async () => {
    const res = await create({ label: 'New default', is_default: true })
    created.set((res.json as { fop: Fop }).fop.id, '<new default>')
    expect(await many(db, sql`
      select label from forms_of_payment where tmc_id = ${a.tmcAdmin.tmc_id} and is_default order by label`))
      .toEqual([{ label: 'New default' }])
  })

  // ── One ────────────────────────────────────────────────────────────────────

  const one_ = (id: string, as = a.tmcAdmin) => call(fopGet, { as, url: `/api/tmc/forms-of-payment/${id}`, params: { id } })
  const patch = (id: string, body: unknown) =>
    call(fopPatch, { as: a.tmcAdmin, method: 'PATCH', url: `/api/tmc/forms-of-payment/${id}`, params: { id }, body })
  const remove = (id: string) =>
    call(fopDelete, { as: a.tmcAdmin, method: 'DELETE', url: `/api/tmc/forms-of-payment/${id}`, params: { id } })

  it('one: with its mappings named; hidden from another TMC', async () => {
    const mapped = await one<{ id: string }>(db, sql`
      select fop_id as id from fop_assignments where tmc_id = ${a.tmcAdmin.tmc_id} order by created_at, id limit 1`)
    const res = await one_(mapped.id)
    expect(res.status).toBe(200)
    expect(scrub(res.json)).toMatchSnapshot()
    expect(await one_(mapped.id, a.otherTmcAdmin!)).toEqual({ status: 404, json: { error: 'Form of payment not found' } })
  })

  it('edit: normalised against what will be stored', async () => {
    // Switching to a cash payment type drops the card details.
    const cash = await patch(fresh, { payment_type_id: cashType })
    expect(cash.json).toMatchObject({ ok: true, fop: { fop_type: 'cash', card_type: null, last4: null } })
    // Switching payer to agency drops the owner.
    const agency = await patch(fresh, { payer: 'agency' })
    expect(agency.json).toMatchObject({ fop: { payer: 'agency', owner_employee_id: null } })
    expect((await patch(fresh, { label: '' })).status).toBe(400)
    if (theirBranch) expect((await patch(fresh, { branch_id: theirBranch })).status).toBe(422)
    // Ticking default again on the old holder swaps it back.
    expect((await patch(fresh, { is_default: true })).json).toMatchObject({ fop: { is_default: true } })
    expect(await many(db, sql`
      select label from forms_of_payment where tmc_id = ${a.tmcAdmin.tmc_id} and is_default`)).toEqual([{ label: 'Road warrior' }])
    expect((await patch(NO_SUCH_ID, { label: 'x' })).status).toBe(404)
  })

  // ── Mappings ───────────────────────────────────────────────────────────────

  const map = (body: unknown) => call(mappingsPost, { as: a.tmcAdmin, method: 'POST', url: '/api/tmc/fop-assignments', body })

  it('map: tenancy, then several targets at once, idempotently', async () => {
    expect((await map({ fopId: fresh, targets: [] })).status).toBe(400)
    expect((await map({ fopId: NO_SUCH_ID, targets: [{ kind: 'client', id: bcg }] })).status).toBe(404)
    expect((await map({ fopId: fresh, targets: [{ kind: 'moon', id: bcg }] })).json).toEqual({ error: 'Unknown target kind: moon' })
    if (theirClient) {
      expect(await map({ fopId: fresh, targets: [{ kind: 'client', id: theirClient }] }))
        .toEqual({ status: 422, json: { error: 'That client does not belong to your TMC' } })
    }
    const bucket = (await many<{ id: string }>(db, sql`
      select id from buckets where tmc_id = ${a.tmcAdmin.tmc_id} order by id limit 1`))[0]
    const targets = [{ kind: 'client', id: bcg }, ...(bucket ? [{ kind: 'bucket', id: bucket.id }] : [])]
    expect(await map({ fopId: fresh, targets })).toEqual({ status: 200, json: { ok: true, assigned: targets.length } })
    expect(await map({ fopId: fresh, targets })).toEqual({ status: 200, json: { ok: true, assigned: targets.length } })
    expect((await many(db, sql`select id from fop_assignments where fop_id = ${fresh}`)).length).toBe(targets.length)
  })

  it('mappings: the flat list, searchable from either side', async () => {
    const res = await call(mappingsGet, { as: a.tmcAdmin, url: '/api/tmc/fop-assignments?pageSize=50' })
    expect(res.status).toBe(200)
    for (const row of await many<{ id: string }>(db, sql`select id from fop_assignments where fop_id = ${fresh}`)) {
      created.set(row.id, '<new mapping>')
    }
    expect(scrub(res.json)).toMatchSnapshot()

    const one_fop = await call(mappingsGet, { as: a.tmcAdmin, url: `/api/tmc/fop-assignments?fopId=${fresh}` })
    expect((one_fop.json as Paged<{ fop_id: string }>).items.every(i => i.fop_id === fresh)).toBe(true)
  })

  it('mappings: one switched off, then removed; tenancy holds', async () => {
    const [first] = await many<{ id: string }>(db, sql`select id from fop_assignments where fop_id = ${fresh} order by id`)
    const toggle = (as: { id: string }, body: unknown) =>
      call(mappingPatch, { as, method: 'PATCH', url: '/api/tmc/fop-assignments', body })
    expect((await toggle(a.tmcAdmin, { id: first.id })).status).toBe(400)
    await toggle(a.otherTmcAdmin!, { id: first.id, is_active: false })
    expect(await one(db, sql`select is_active from fop_assignments where id = ${first.id}`)).toEqual({ is_active: true })
    expect(await toggle(a.tmcAdmin, { id: first.id, is_active: false })).toEqual({ status: 200, json: { ok: true } })
    expect(await one(db, sql`select is_active from fop_assignments where id = ${first.id}`)).toEqual({ is_active: false })

    expect((await remove(fresh)).status).toBe(409)
    for (const row of await many<{ id: string }>(db, sql`select id from fop_assignments where fop_id = ${fresh}`)) {
      expect((await call(mappingDelete, { as: a.tmcAdmin, method: 'DELETE', url: `/api/tmc/fop-assignments?id=${row.id}` })).json)
        .toEqual({ ok: true })
    }
    expect(await remove(fresh)).toEqual({ status: 200, json: { ok: true } })
  })

  // ── The code lists ─────────────────────────────────────────────────────────

  it('codes: the TMC\'s GDS entries and payment types', async () => {
    const res = await call(codesGet, { as: a.tmcAdmin, url: '/api/tmc/fop-codes' })
    expect(res.status).toBe(200)
    expect(res.json).toMatchSnapshot()
  })

  it('codes: a TMC with none is seeded on first read, once', async () => {
    const tmc = (await one<{ id: string }>(db, sql`insert into tmcs (name) values ('Codeless TMC') returning id`)).id
    const admin = (await one<{ id: string }>(db, sql`
      insert into employees (id, tmc_id, full_name, email, role, status)
      values (gen_random_uuid(), ${tmc}, 'Code Admin', 'code.admin@example.test', 'tmc_admin', 'active')
      returning id`)).id
    await exec(db, sql`delete from fop_gds_entries where tmc_id = ${tmc}`)
    await exec(db, sql`delete from fop_payment_types where tmc_id = ${tmc}`)
    const res = await call(codesGet, { as: { id: admin }, url: '/api/tmc/fop-codes' })
    const body = res.json as { gdsEntries: { code: string }[]; paymentTypes: { code: string; requires_card: boolean }[] }
    expect(body.gdsEntries.map(e => e.code)).toEqual(['CC', 'INVAGT'])
    expect(body.paymentTypes.map(p => [p.code, p.requires_card])).toEqual([['CC', true], ['CL', false]])
    await call(codesGet, { as: { id: admin }, url: '/api/tmc/fop-codes' })
    expect((await many(db, sql`select id from fop_gds_entries where tmc_id = ${tmc}`)).length).toBe(2)
  })
})
