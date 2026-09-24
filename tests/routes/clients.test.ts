import { describe, it, expect, beforeAll, vi } from 'vitest'
import { GET as clientsGet } from '@/app/api/tmc/clients/route'
import { GET as clientGet, PATCH as clientPatch, DELETE as clientDelete } from '@/app/api/tmc/clients/[id]/route'
import { GET as adminsGet, POST as adminReset } from '@/app/api/tmc/clients/[id]/admin-access/route'
import { GET as allocationsGet } from '@/app/api/tmc/clients/[id]/allocations/route'
import { GET as clientBucketsGet, PUT as clientBucketsPut } from '@/app/api/tmc/clients/[id]/buckets/route'
import { GET as commercialsGet } from '@/app/api/tmc/clients/[id]/commercials/route'
import { GET as gstGet, POST as gstPost, PATCH as gstPatch, DELETE as gstDelete } from '@/app/api/tmc/clients/[id]/gst/route'
import { GET as mandatoryGet, POST as mandatoryPost, DELETE as mandatoryDelete } from '@/app/api/tmc/clients/[id]/mandatory-info/route'
import { GET as bucketsGet, POST as bucketsPost } from '@/app/api/tmc/buckets/route'
import { GET as bucketGet, PATCH as bucketPatch, DELETE as bucketDelete } from '@/app/api/tmc/buckets/[id]/route'
import { GET as groupsGet, POST as groupsPost } from '@/app/api/tmc/client-groups/route'
import { PATCH as groupPatch, DELETE as groupDelete } from '@/app/api/tmc/client-groups/[id]/route'
import { GET as centresGet, POST as centresPost, PATCH as centresPatch, DELETE as centresDelete } from '@/app/api/tmc/cost-centres/route'
import { call } from '../harness/call'
import { actors, type Actors } from '../harness/actors'
import { resetDatabase } from '../harness/db'
import { authCalls } from '../harness/authAdmin'
import { db } from '@/app/lib/db'
import { sql, many, maybeOne, one, exec } from '@/app/lib/db/sql'

// ── Clients and how they are configured ──────────────────────────────────────
// The client list and detail, Corporate Settings sub-screens (admins, what
// reaches the client, buckets, commercials, GST, mandatory info), and the
// masters that group clients: buckets, client groups, cost centres.
//
// admin-access sends password resets through GoTrue, faked here.
// ─────────────────────────────────────────────────────────────────────────────

vi.mock('@/utils/supabase/service', async orig => {
  const actual = await orig<typeof import('@/utils/supabase/service')>()
  const { fakeAuth } = await import('../harness/authAdmin')
  return { ...actual, createServiceClient: () => ({ ...actual.createServiceClient(), auth: fakeAuth }) }
})

const HAS_DB = Boolean(process.env.DATABASE_URL)
const d = HAS_DB ? describe : describe.skip

const NO_SUCH_ID = '00000000-0000-0000-0000-00000000c0de'

interface Paged<T> { items: T[]; total: number }

// Strips the fields a freshly created row gets from the clock or a sequence,
// so the rest of it can be snapshotted.
function fresh<T extends Record<string, unknown>>(row: T) {
  const { id, created_at, ...rest } = row
  expect(typeof id).toBe('string')
  if (created_at !== undefined) expect(typeof created_at).toBe('string')
  return rest
}

const at = (base: string, id: string, extra = '') => ({ url: `${base}/${id}${extra}`, params: { id } })

// ═══ Clients: list, detail, admin access, what reaches them ═════════════════

d('tmc/clients', () => {
  let a: Actors
  let bcg: string
  let other: string       // another active client of the same TMC
  let inactive: string

  beforeAll(async () => {
    await resetDatabase()
    a = await actors()
    bcg = a.corpAdmin.client_id!
    other = (await one<{ id: string }>(db, sql`
      select id from clients where tmc_id = ${a.tmcAdmin.tmc_id} and status = 'active' and id <> ${bcg}
      order by created_at, id limit 1`)).id
    inactive = (await one<{ id: string }>(db, sql`
      select id from clients where tmc_id = ${a.tmcAdmin.tmc_id} and status = 'inactive' limit 1`)).id
  })

  // ── GET /api/tmc/clients ───────────────────────────────────────────────────

  it('list: 401, and a corporate user is refused', async () => {
    expect((await call(clientsGet, { url: '/api/tmc/clients' })).status).toBe(401)
    expect(await call(clientsGet, { as: a.corpAdmin, url: '/api/tmc/clients' }))
      .toEqual({ status: 403, json: { error: 'Forbidden' } })
  })

  it('list: active clients with group, branch and headcount', async () => {
    const res = await call(clientsGet, { as: a.tmcAdmin, url: '/api/tmc/clients' })
    expect(res.status).toBe(200)
    expect(res.json).toMatchSnapshot()
  })

  it('list: includeInactive, search, and ids resolving an inactive client', async () => {
    const all = await call(clientsGet, { as: a.tmcAdmin, url: '/api/tmc/clients?includeInactive=1' })
    expect((all.json as Paged<unknown>).total).toBe(9)

    const found = await call(clientsGet, { as: a.tmcAdmin, url: '/api/tmc/clients?search=bcg' })
    expect((found.json as Paged<{ id: string }>).items.map(c => c.id)).toEqual([bcg])

    const byId = await call(clientsGet, { as: a.tmcAdmin, url: `/api/tmc/clients?ids=${inactive}` })
    expect((byId.json as Paged<{ id: string; status: string }>).items)
      .toMatchObject([{ id: inactive, status: 'inactive' }])
  })

  it('list: a tc sees only the clients granted to them', async () => {
    const granted = (await many<{ client_id: string }>(db, sql`
      select client_id from employee_client_access where employee_id = ${a.tc!.id}`)).map(r => r.client_id)
    const res = await call(clientsGet, { as: a.tc!, url: '/api/tmc/clients?includeInactive=1' })
    const ids = (res.json as Paged<{ id: string }>).items.map(c => c.id)
    expect(ids.sort()).toEqual(granted.sort())
  })

  // ── /api/tmc/clients/[id] ──────────────────────────────────────────────────

  it('detail: another TMC, and a tc without access', async () => {
    expect(await call(clientGet, { as: a.otherTmcAdmin!, ...at('/api/tmc/clients', bcg) }))
      .toEqual({ status: 404, json: { error: 'Client not found' } })
    await exec(db, sql`delete from employee_client_access where employee_id = ${a.tc!.id} and client_id = ${other}`)
    expect(await call(clientGet, { as: a.tc!, ...at('/api/tmc/clients', other) }))
      .toEqual({ status: 403, json: { error: 'No access to this client' } })
  })

  it('detail: the full Corporate Settings record', async () => {
    const res = await call(clientGet, { as: a.tmcAdmin, ...at('/api/tmc/clients', bcg) })
    expect(res.status).toBe(200)
    expect(res.json).toMatchSnapshot()
  })

  const patch = (id: string, body: unknown) =>
    call(clientPatch, { as: a.tmcAdmin, method: 'PATCH', ...at('/api/tmc/clients', id), body })

  it('PATCH: validation', async () => {
    const cases: [unknown, string][] = [
      [{ name: ' ' }, 'Client name cannot be empty'],
      [{ timezone: ' ' }, 'Timezone cannot be empty'],
      [{ currency: 'usd' }, 'Unsupported currency: usd'],
      [{ air_approval_mode: 'sometimes' }, 'Invalid air_approval_mode: sometimes'],
      [{ size: '5' }, 'Invalid size: 5. Must be one of 1-50, 51-200, 201-1000, 1001+'],
      [{ status: 'gone' }, 'Invalid status: gone. Must be one of active, inactive'],
      [{ fop_priority: ['a'] }, 'fop_priority must list each of agency, corporate, bta_cta, bta_cta_manual exactly once'],
      [{ booking_mode: 'x' }, 'Invalid booking_mode: x. Must be one of sbt, cbt, both'],
      [{}, 'No fields to update'],
      [{ markup_active: 'false' }, 'No fields to update'],
    ]
    for (const [body, error] of cases) {
      const res = await patch(bcg, body)
      expect(res.json, JSON.stringify(body)).toEqual({ error })
      expect(res.status).toBe(400)
    }
  })

  it('PATCH: references must belong to this TMC', async () => {
    expect(await patch(bcg, { managed_by: a.corpAdmin.id }))
      .toEqual({ status: 422, json: { error: 'Account manager must be a member of your TMC' } })
    const theirBranch = await one<{ id: string }>(db, sql`
      insert into branches (tmc_id, name) values (${a.otherTmcAdmin!.tmc_id}, 'Elsewhere') returning id`)
    expect(await patch(bcg, { branch_id: theirBranch.id }))
      .toEqual({ status: 422, json: { error: 'Branch not found for this TMC' } })
    expect(await patch(bcg, { client_group_id: NO_SUCH_ID }))
      .toEqual({ status: 404, json: { error: 'Client group not found for this TMC' } })
    expect(await call(clientPatch, { as: a.otherTmcAdmin!, method: 'PATCH', ...at('/api/tmc/clients', bcg), body: { name: 'X' } }))
      .toEqual({ status: 404, json: { error: 'Client not found' } })
  })

  it('PATCH: saves, normalises, and returns the same shape as GET', async () => {
    const res = await patch(bcg, {
      client_code: ' bcg01 ', city: ' Gurugram ', email: '', size: '51-200',
      markup_active: false, fop_priority: ['corporate', 'agency', 'bta_cta', 'bta_cta_manual'],
      managed_by: a.tc!.id, currency: ' inr ', booking_mode: 'both',
    })
    expect(res.status).toBe(200)
    expect(res.json).toMatchSnapshot()
    const detail = await call(clientGet, { as: a.tmcAdmin, ...at('/api/tmc/clients', bcg) })
    expect((detail.json as { client: unknown }).client).toEqual((res.json as { client: unknown }).client)
  })

  it('PATCH: a client code already in use is a 409', async () => {
    expect(await patch(other, { client_code: 'BCG01' }))
      .toEqual({ status: 409, json: { error: 'Client code "BCG01" is already used by another client.' } })
  })

  it('DELETE: deactivates, and doing it twice is fine', async () => {
    const del = () => call(clientDelete, { as: a.tmcAdmin, method: 'DELETE', ...at('/api/tmc/clients', other) })
    const first = await del()
    expect(first).toMatchObject({ status: 200, json: { ok: true, client: { id: other, status: 'inactive' } } })
    expect(await del()).toEqual({ status: 200, json: { ok: true, client: { id: other, status: 'inactive' } } })
    expect(await maybeOne(db, sql`select status from clients where id = ${other}`)).toEqual({ status: 'inactive' })
  })

  // ── admin-access ───────────────────────────────────────────────────────────

  it('admin-access: lists the corporate admins', async () => {
    const res = await call(adminsGet, { as: a.tmcAdmin, ...at('/api/tmc/clients', bcg, '/admin-access') })
    expect(res.status).toBe(200)
    expect(res.json).toMatchSnapshot()
  })

  it('admin-access: a reset goes to the address on file, only for an admin', async () => {
    const post = (body: unknown) =>
      call(adminReset, { as: a.tmcAdmin, method: 'POST', ...at('/api/tmc/clients', bcg, '/admin-access'), body })
    expect(await post({})).toEqual({ status: 400, json: { error: 'employeeId is required' } })
    const traveller = await one<{ id: string }>(db, sql`
      select id from employees where client_id = ${bcg} and role <> 'admin' order by id limit 1`)
    expect(await post({ employeeId: traveller.id }))
      .toEqual({ status: 404, json: { error: 'That person is not an admin at this client' } })

    const before = authCalls.length
    const res = await post({ employeeId: a.corpAdmin.id })
    expect(res.status).toBe(200)
    expect((res.json as { message: string }).message).toBe(`Password reset sent to ${a.corpAdmin.email}.`)
    const sent = authCalls.slice(before)
    expect(sent.map(c => [c.method, c.args[0]])).toEqual([['resetPasswordForEmail', a.corpAdmin.email]])
  })

  // ── What reaches the client ────────────────────────────────────────────────

  it('allocations: deal codes and forms of payment, with how they arrive', async () => {
    expect((await call(allocationsGet, { as: a.otherTmcAdmin!, ...at('/api/tmc/clients', bcg, '/allocations') })).status).toBe(404)
    const res = await call(allocationsGet, { as: a.tmcAdmin, ...at('/api/tmc/clients', bcg, '/allocations') })
    expect(res.status).toBe(200)
    expect(res.json).toMatchSnapshot()
  })

  it('commercials: the rules in force, and the client switches', async () => {
    expect((await call(commercialsGet, { as: a.otherTmcAdmin!, ...at('/api/tmc/clients', bcg, '/commercials') })).status).toBe(404)
    const res = await call(commercialsGet, { as: a.tmcAdmin, ...at('/api/tmc/clients', bcg, '/commercials') })
    expect(res.status).toBe(200)
    expect(res.json).toMatchSnapshot()
  })
})

// ═══ A client's buckets, GST and mandatory info ═════════════════════════════

d('tmc/clients/[id] configuration', () => {
  let a: Actors
  let bcg: string

  beforeAll(async () => {
    await resetDatabase()
    a = await actors()
    bcg = a.corpAdmin.client_id!
  })

  const bucketId = async (name: string) =>
    (await one<{ id: string }>(db, sql`
      select id from buckets where tmc_id = ${a.tmcAdmin.tmc_id} and name = ${name}`)).id

  it('buckets: the ones this client is in', async () => {
    const res = await call(clientBucketsGet, { as: a.tmcAdmin, ...at('/api/tmc/clients', bcg, '/buckets') })
    expect(res.status).toBe(200)
    expect(res.json).toMatchSnapshot()
  })

  it('buckets PUT: validation, and another TMC\'s bucket is refused', async () => {
    const put = (body: unknown) =>
      call(clientBucketsPut, { as: a.tmcAdmin, method: 'PUT', ...at('/api/tmc/clients', bcg, '/buckets'), body })
    expect(await put({ bucketIds: 'x' })).toEqual({ status: 400, json: { error: 'bucketIds must be an array' } })
    const theirs = await one<{ id: string }>(db, sql`
      insert into buckets (tmc_id, name) values (${a.otherTmcAdmin!.tmc_id}, 'Theirs') returning id`)
    expect(await put({ bucketIds: [theirs.id] }))
      .toEqual({ status: 422, json: { error: 'Bucket not found for this TMC' } })
  })

  it('buckets PUT: replaces the membership wholesale', async () => {
    const want = [await bucketId('SMEs'), await bucketId('kj')]
    const res = await call(clientBucketsPut, {
      as: a.tmcAdmin, method: 'PUT', ...at('/api/tmc/clients', bcg, '/buckets'), body: { bucketIds: [...want, want[0]] },
    })
    expect(res.status).toBe(200)
    const names = (res.json as { buckets: { name: string }[] }).buckets.map(b => b.name).sort()
    expect(names).toEqual(['SMEs', 'kj'].sort())
    const rows = await many<{ bucket_id: string }>(db, sql`select bucket_id from bucket_clients where client_id = ${bcg}`)
    expect(rows.map(r => r.bucket_id).sort()).toEqual([...want].sort())
  })

  // ── GST ────────────────────────────────────────────────────────────────────

  const gst = (method: string, body?: unknown, extra = '') =>
    call(method === 'GET' ? gstGet : method === 'POST' ? gstPost : method === 'PATCH' ? gstPatch : gstDelete, {
      as: a.tmcAdmin, method, ...at('/api/tmc/clients', bcg, `/gst${extra}`), body,
    })

  it('gst: the registrations on file', async () => {
    const res = await gst('GET')
    expect(res.status).toBe(200)
    expect(res.json).toMatchSnapshot()
  })

  it('gst POST: another client\'s cost centre is refused', async () => {
    const theirs = await one<{ id: string }>(db, sql`
      insert into cost_centres (client_id, code, name)
      select id, 'ELSEWHERE', 'Elsewhere' from clients where id <> ${bcg} order by id limit 1
      returning id`)
    expect(await gst('POST', { cost_centre_id: theirs.id }))
      .toEqual({ status: 422, json: { error: 'Cost centre not found for this client' } })
  })

  it('gst POST: saves with a finding for a malformed number; overlaps and duplicates are 409', async () => {
    // Clear the existing window so the new one does not collide with it.
    await exec(db, sql`delete from client_gst_registrations where client_id = ${bcg}`)
    const res = await gst('POST', {
      gstin: ' 27abcde1234f1z5 ', gst_holder: ' BCG India ', state: 'Karnataka',
      valid_from: '2026-01-01', valid_to: '2026-12-31', is_primary: true,
    })
    expect(res.status).toBe(200)
    const body = res.json as { registration: Record<string, unknown>; finding: unknown }
    expect({ ...body, registration: fresh(body.registration) }).toMatchSnapshot()

    expect(await gst('POST', { valid_from: '2026-06-01' })).toEqual({
      status: 409,
      json: { error: 'Another registration with no cost centre already covers part of that date range. Two overlapping registrations make it ambiguous which GSTIN invoices a booking.' },
    })
    expect(await gst('POST', { gstin: '27ABCDE1234F1Z5', valid_from: '2027-01-01' }))
      .toEqual({ status: 409, json: { error: 'That GST number is already on file for this client' } })
  })

  it('gst PATCH: entryId required; making one primary clears the others', async () => {
    expect(await gst('PATCH', {})).toEqual({ status: 400, json: { error: 'entryId is required' } })
    const second = await gst('POST', { gstin: '29BBBBB1111B1Z1', valid_from: '2027-01-01' })
    const secondId = (second.json as { registration: { id: string } }).registration.id

    const res = await gst('PATCH', { entryId: secondId, is_primary: true, city: ' Bengaluru ' })
    expect(res.status).toBe(200)
    expect((res.json as { registration: unknown }).registration).toMatchObject({ id: secondId, is_primary: true, city: 'Bengaluru' })
    const primaries = await many<{ id: string }>(db, sql`
      select id from client_gst_registrations where client_id = ${bcg} and is_primary`)
    expect(primaries).toEqual([{ id: secondId }])

    // An edit that leaves the dates alone is tested against the row as it stands.
    expect((await gst('PATCH', { entryId: secondId, contact: '1234' })).status).toBe(200)
  })

  it('gst DELETE', async () => {
    expect(await gst('DELETE')).toEqual({ status: 400, json: { error: 'entryId is required' } })
    const row = await one<{ id: string }>(db, sql`
      select id from client_gst_registrations where client_id = ${bcg} order by created_at limit 1`)
    expect(await gst('DELETE', undefined, `?entryId=${row.id}`)).toEqual({ status: 200, json: { ok: true } })
    expect(await maybeOne(db, sql`select id from client_gst_registrations where id = ${row.id}`)).toBeNull()
  })

  // ── Mandatory info ─────────────────────────────────────────────────────────

  const mandatory = (handler: unknown, method: string, body?: unknown, extra = '') =>
    call(handler, { as: a.tmcAdmin, method, ...at('/api/tmc/clients', bcg, `/mandatory-info${extra}`), body })

  it('mandatory-info: create, re-save by code, list, delete', async () => {
    expect(await mandatory(mandatoryGet, 'GET')).toEqual({ status: 200, json: { ok: true, entries: [] } })
    expect(await mandatory(mandatoryPost, 'POST', { code: ' ' }))
      .toEqual({ status: 400, json: { error: 'A mandatory entry needs a code' } })

    const created = await mandatory(mandatoryPost, 'POST', { code: ' emp id ', description: ' Employee ID ', gds_entry: 'rm*empid' })
    expect(created.status).toBe(200)
    const entry = (created.json as { entry: Record<string, unknown> }).entry
    expect(fresh(entry)).toMatchSnapshot()

    // The code is the identity: saving it again edits the same row.
    const resaved = await mandatory(mandatoryPost, 'POST', { code: 'EMP ID', description: 'Staff number', is_mandatory: false })
    expect((resaved.json as { entry: Record<string, unknown> }).entry)
      .toMatchObject({ id: entry.id, description: 'Staff number', is_mandatory: false, gds_entry: null })

    const list = await mandatory(mandatoryGet, 'GET')
    expect((list.json as { entries: unknown[] }).entries).toHaveLength(1)

    expect(await mandatory(mandatoryDelete, 'DELETE')).toEqual({ status: 400, json: { error: 'entryId is required' } })
    expect(await mandatory(mandatoryDelete, 'DELETE', undefined, `?entryId=${entry.id}`)).toEqual({ status: 200, json: { ok: true } })
    expect(await mandatory(mandatoryGet, 'GET')).toEqual({ status: 200, json: { ok: true, entries: [] } })
  })
})

// ═══ Buckets and client groups ══════════════════════════════════════════════

d('tmc/buckets and tmc/client-groups', () => {
  let a: Actors
  let clientIds: string[]

  beforeAll(async () => {
    await resetDatabase()
    a = await actors()
    clientIds = (await many<{ id: string }>(db, sql`
      select id from clients where tmc_id = ${a.tmcAdmin.tmc_id} order by id`)).map(r => r.id)
  })

  const bucketNamed = async (name: string) =>
    (await one<{ id: string }>(db, sql`
      select id from buckets where tmc_id = ${a.tmcAdmin.tmc_id} and name = ${name}`)).id

  it('buckets: 401 and 403', async () => {
    expect((await call(bucketsGet, { url: '/api/tmc/buckets' })).status).toBe(401)
    expect((await call(bucketsGet, { as: a.corpAdmin, url: '/api/tmc/buckets' })).status).toBe(403)
  })

  it('buckets: with client and deal-code counts', async () => {
    const res = await call(bucketsGet, { as: a.tmcAdmin, url: '/api/tmc/buckets' })
    expect(res.status).toBe(200)
    expect(res.json).toMatchSnapshot()
    const none = await call(bucketsGet, { as: a.tmcAdmin, url: '/api/tmc/buckets?search=zz-none-zz' })
    expect((none.json as Paged<unknown>).total).toBe(0)
  })

  it('buckets POST: validation, create, duplicate name', async () => {
    const post = (body: unknown) => call(bucketsPost, { as: a.tmcAdmin, method: 'POST', url: '/api/tmc/buckets', body })
    expect(await post({ name: ' ' })).toEqual({ status: 400, json: { error: 'Bucket name is required' } })
    const res = await post({ name: ' North Desk ', code: ' nd ', description: '' })
    expect(res.status).toBe(200)
    const bucket = (res.json as { bucket: Record<string, unknown> }).bucket
    expect(fresh(bucket)).toEqual({ name: 'North Desk', code: 'ND', description: null, clientCount: 0, dealCodeCount: 0 })
    expect(await post({ name: 'North Desk' })).toEqual({ status: 409, json: { error: 'A bucket with that name already exists' } })
  })

  it('bucket [id]: another TMC cannot see it; members and the codes it hands out', async () => {
    const id = await bucketNamed('Corps with vibes')
    expect(await call(bucketGet, { as: a.otherTmcAdmin!, ...at('/api/tmc/buckets', id) }))
      .toEqual({ status: 404, json: { error: 'Bucket not found' } })
    const res = await call(bucketGet, { as: a.tmcAdmin, ...at('/api/tmc/buckets', id) })
    expect(res.status).toBe(200)
    expect(res.json).toMatchSnapshot()
  })

  it('bucket [id] PATCH: validation, duplicates, foreign clients, and replacing members', async () => {
    const id = await bucketNamed('North Desk')
    const p = (body: unknown) => call(bucketPatch, { as: a.tmcAdmin, method: 'PATCH', ...at('/api/tmc/buckets', id), body })
    expect(await p({ name: '' })).toEqual({ status: 400, json: { error: 'Bucket name cannot be empty' } })
    expect(await p({ name: 'SMEs' })).toEqual({ status: 409, json: { error: 'A bucket with that name already exists' } })
    const theirClient = await one<{ id: string }>(db, sql`
      insert into clients (tmc_id, name) values (${a.otherTmcAdmin!.tmc_id}, 'Not Yours') returning id`)
    expect(await p({ clientIds: [clientIds[0], theirClient.id] }))
      .toEqual({ status: 422, json: { error: 'One or more of those clients do not belong to your TMC' } })

    expect(await p({ description: ' Northern accounts ', clientIds: [clientIds[0], clientIds[1]] }))
      .toEqual({ status: 200, json: { ok: true } })
    expect(await one(db, sql`select description from buckets where id = ${id}`)).toEqual({ description: 'Northern accounts' })
    const members = await many<{ client_id: string }>(db, sql`
      select client_id from bucket_clients where bucket_id = ${id} order by client_id`)
    expect(members.map(m => m.client_id)).toEqual([clientIds[0], clientIds[1]].sort())
  })

  it('bucket [id] DELETE: refused while anything is assigned to it; an unused one goes', async () => {
    const used = await one<{ id: string }>(db, sql`
      select b.id from buckets b
      where b.tmc_id = ${a.tmcAdmin.tmc_id}
        and exists (select 1 from deal_code_assignments d where d.bucket_id = b.id)
      order by b.name limit 1`)
    const refused = await call(bucketDelete, { as: a.tmcAdmin, method: 'DELETE', ...at('/api/tmc/buckets', used.id) })
    expect(refused.status).toBe(409)
    expect(refused.json).toMatchSnapshot()

    const unused = await bucketNamed('North Desk')
    expect(await call(bucketDelete, { as: a.tmcAdmin, method: 'DELETE', ...at('/api/tmc/buckets', unused) }))
      .toEqual({ status: 200, json: { ok: true } })
    expect(await maybeOne(db, sql`select id from buckets where id = ${unused}`)).toBeNull()
  })

  // ── Client groups ──────────────────────────────────────────────────────────

  it('client-groups: a corporate user is refused; the list and search', async () => {
    expect(await call(groupsGet, { as: a.corpAdmin, url: '/api/tmc/client-groups' }))
      .toEqual({ status: 403, json: { error: 'Forbidden' } })
    const res = await call(groupsGet, { as: a.tmcAdmin, url: '/api/tmc/client-groups' })
    expect(res.status).toBe(200)
    expect(res.json).toMatchSnapshot()
    const none = await call(groupsGet, { as: a.tmcAdmin, url: '/api/tmc/client-groups?search=zz-none-zz' })
    expect((none.json as Paged<unknown>).total).toBe(0)
  })

  const postGroup = (body: unknown, as = a.tmcAdmin) =>
    call(groupsPost, { as, method: 'POST', url: '/api/tmc/client-groups', body })

  it('client-groups POST: permission, validation, create, duplicate code', async () => {
    expect((await postGroup({ name: 'X' }, a.corpAdmin)).status).toBe(403)
    expect(await postGroup({ name: '' })).toEqual({ status: 400, json: { error: 'Client group name is required' } })
    expect(await postGroup({ name: 'G', contact_email: 'nope' }))
      .toEqual({ status: 400, json: { error: '"nope" is not a valid email address.' } })
    const res = await postGroup({ name: ' Acme Group ', group_code: ' acme ', city: ' Pune ', contact_email: 'ops@example.test' })
    expect(res.status).toBe(201)
    expect(fresh((res.json as { clientGroup: Record<string, unknown> }).clientGroup)).toMatchSnapshot()
    expect(await postGroup({ name: 'Other', group_code: 'ACME' }))
      .toEqual({ status: 409, json: { error: 'Group code "ACME" is already used by another group.' } })
  })

  it('client-group [id]: not found, nothing to update, edit, delete unassigns its clients', async () => {
    const group = await one<{ id: string }>(db, sql`
      select id from client_groups where tmc_id = ${a.tmcAdmin.tmc_id} and name = 'Acme Group'`)
    const p = (id: string, body: unknown, as = a.tmcAdmin) =>
      call(groupPatch, { as, method: 'PATCH', ...at('/api/tmc/client-groups', id), body })

    expect(await p(group.id, { name: 'X' }, a.otherTmcAdmin!)).toEqual({ status: 404, json: { error: 'Client group not found' } })
    expect(await p(group.id, {})).toEqual({ status: 400, json: { error: 'No fields to update' } })
    const edited = await p(group.id, { name: 'Acme Holdings', bill_to_state: ' MH ' })
    expect(edited).toMatchObject({ status: 200, json: { ok: true, clientGroup: { id: group.id, name: 'Acme Holdings', bill_to_state: 'MH', group_code: 'ACME' } } })

    await exec(db, sql`update clients set client_group_id = ${group.id} where id = ${clientIds[0]}`)
    expect(await call(groupDelete, { as: a.tmcAdmin, method: 'DELETE', ...at('/api/tmc/client-groups', group.id) }))
      .toEqual({ status: 200, json: { ok: true } })
    expect(await one(db, sql`select client_group_id from clients where id = ${clientIds[0]}`)).toEqual({ client_group_id: null })
  })
})

// ═══ Cost centres ═══════════════════════════════════════════════════════════

d('tmc/cost-centres', () => {
  let a: Actors
  let bcg: string

  beforeAll(async () => {
    await resetDatabase()
    a = await actors()
    bcg = a.corpAdmin.client_id!
    // Someone on a code that is not in the list, so `unlisted` has content.
    await exec(db, sql`
      update employees set cost_centre = 'LEGACY9', department = ' Finance '
      where id = (select id from employees where client_id = ${bcg} and cost_centre is null order by id limit 1)`)
  })

  it('GET: centres with headcount, departments in use, and unlisted codes', async () => {
    expect(await call(centresGet, { as: a.tmcAdmin, url: '/api/tmc/cost-centres' }))
      .toEqual({ status: 400, json: { error: 'clientId is required' } })
    const res = await call(centresGet, { as: a.tmcAdmin, url: `/api/tmc/cost-centres?clientId=${bcg}` })
    expect(res.status).toBe(200)
    expect(res.json).toMatchSnapshot()
  })

  const post = (body: unknown) => call(centresPost, { as: a.tmcAdmin, method: 'POST', url: '/api/tmc/cost-centres', body })
  const patch = (body: unknown) => call(centresPatch, { as: a.tmcAdmin, method: 'PATCH', url: '/api/tmc/cost-centres', body })

  it('POST: validation, create, duplicate', async () => {
    expect(await post({ clientId: bcg })).toEqual({ status: 400, json: { error: 'clientId and code are required' } })
    const res = await post({ clientId: bcg, code: ' OPS1 ' })
    expect(res.status).toBe(201)
    expect(fresh((res.json as { costCentre: Record<string, unknown> }).costCentre))
      .toEqual({ code: 'OPS1', name: 'OPS1', employees: 0 })
    expect(await post({ clientId: bcg, code: 'OPS1' })).toEqual({ status: 409, json: { error: '"OPS1" already exists for this client' } })
  })

  it('PATCH: validation, duplicate, and a rename carries its people', async () => {
    expect(await patch({ clientId: bcg, code: 'X' }))
      .toEqual({ status: 400, json: { error: 'clientId, code and previousCode are required' } })
    expect(await patch({ clientId: bcg, code: 'OPS1', previousCode: 'IT101G' }))
      .toEqual({ status: 409, json: { error: '"OPS1" already exists for this client' } })

    const onIt = await one<{ n: number }>(db, sql`
      select count(*)::int as n from employees where client_id = ${bcg} and cost_centre = 'IT101G'`)
    const res = await patch({ clientId: bcg, code: 'IT202', name: 'Information Technology', previousCode: 'IT101G' })
    expect(res).toEqual({ status: 200, json: { ok: true, moved: onIt.n } })
    expect(await one(db, sql`
      select count(*)::int as n from employees where client_id = ${bcg} and cost_centre = 'IT202'`)).toEqual({ n: onIt.n })
  })

  it('DELETE: refused while anyone is on it; an empty one goes', async () => {
    const del = (code: string) =>
      call(centresDelete, { as: a.tmcAdmin, method: 'DELETE', url: `/api/tmc/cost-centres?clientId=${bcg}&code=${code}` })
    expect(await call(centresDelete, { as: a.tmcAdmin, method: 'DELETE', url: '/api/tmc/cost-centres' }))
      .toEqual({ status: 400, json: { error: 'clientId and code are required' } })
    const blocked = await del('IT202')
    expect(blocked.status).toBe(409)
    expect((blocked.json as { error: string }).error).toMatch(/ on "IT202"\. Move them to another cost centre first\.$/)
    expect(await del('OPS1')).toEqual({ status: 200, json: { ok: true } })
  })
})
