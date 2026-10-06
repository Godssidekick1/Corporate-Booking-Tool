import { describe, it, expect, beforeAll } from 'vitest'
import { GET as tcsGet, POST as tcsPost } from '@/app/api/tmc/tcs/route'
import { PATCH as tcPatch } from '@/app/api/tmc/tcs/[id]/route'
import { GET as branchesGet, POST as branchesPost } from '@/app/api/tmc/branches/route'
import { GET as branchGet, PATCH as branchPatch, DELETE as branchDelete } from '@/app/api/tmc/branches/[id]/route'
import { GET as bandsGet, POST as bandsPost } from '@/app/api/tmc/bands/route'
import { PATCH as bandPatch, DELETE as bandDelete } from '@/app/api/tmc/bands/[id]/route'
import { GET as profilesGet } from '@/app/api/tmc/traveler-profiles/route'
import { POST as addPerson } from '@/app/api/tmc/employees/route'
import { POST as invitePerson } from '@/app/api/tmc/employees/[id]/invite/route'
import { PATCH as profilePatch } from '@/app/api/tmc/traveler-profiles/[id]/route'
import { GET as csvGet, POST as csvPost } from '@/app/api/tmc/traveler-profiles/csv/route'
import { call } from '../harness/call'
import { actors, type Actors } from '../harness/actors'
import { resetDatabase } from '../harness/db'
import { outbox, linkIn } from '../harness/mail'
import { db } from '@/app/lib/db'
import { sql, many, maybeOne, one, exec } from '@/app/lib/db/sql'

// ── The TMC's people and structure ───────────────────────────────────────────
// Travel counsellors, branches, a client's bands, and the traveller-profile
// roster (list, edit, CSV round trip).
//
// POST /api/tmc/tcs creates an account and emails an invite, which lands in
// the fake outbox (tests/harness/mail.ts).
// ─────────────────────────────────────────────────────────────────────────────

const HAS_DB = Boolean(process.env.DATABASE_URL)
const d = HAS_DB ? describe : describe.skip

const NO_SUCH_ID = '00000000-0000-0000-0000-00000000f00d'

interface Paged<T> { items: T[]; total: number }

const employee = (id: string) =>
  maybeOne<Record<string, unknown>>(db, sql`select * from employees where id = ${id}`)

const permissionsOf = async (id: string) =>
  (await many<{ k: string }>(db, sql`
    select permission_key as k from employee_permissions where employee_id = ${id} order by 1`)).map(r => r.k)

const accessOf = async (id: string) =>
  (await many<{ c: string }>(db, sql`
    select client_id as c from employee_client_access where employee_id = ${id} order by 1`)).map(r => r.c)

// ═══ Travel counsellors ═════════════════════════════════════════════════════

d('tmc/tcs', () => {
  let a: Actors
  let ownClients: string[]
  let foreignClient: string

  beforeAll(async () => {
    await resetDatabase()
    a = await actors()
    ownClients = (await many<{ id: string }>(db, sql`
      select id from clients where tmc_id = ${a.tmcAdmin.tmc_id} order by id`)).map(r => r.id)
    // A real client of another TMC -- existing, just not theirs.
    foreignClient = (await one<{ id: string }>(db, sql`
      insert into clients (tmc_id, name) values (${a.otherTmcAdmin!.tmc_id}, 'Someone Else Ltd') returning id`)).id
  })

  // Both are sets -- the UI renders checkboxes from them.
  const normalise = (body: Paged<{ permissions: string[]; clientIds: string[] }>) => ({
    ...body,
    items: body.items.map(t => ({ ...t, permissions: [...t.permissions].sort(), clientIds: [...t.clientIds].sort() })),
  })

  it('GET: 401 signed out', async () => {
    expect((await call(tcsGet, { url: '/api/tmc/tcs' })).status).toBe(401)
  })

  it('GET: only a tmc_admin', async () => {
    expect(await call(tcsGet, { as: a.corpAdmin, url: '/api/tmc/tcs' }))
      .toEqual({ status: 403, json: { error: 'Only TMC admins can view TCs' } })
    expect((await call(tcsGet, { as: a.tc!, url: '/api/tmc/tcs' })).status).toBe(403)
  })

  it('GET: the TMC\'s counsellors with permissions, access and branch', async () => {
    const res = await call(tcsGet, { as: a.tmcAdmin, url: '/api/tmc/tcs' })
    expect(res.status).toBe(200)
    expect(normalise(res.json as never)).toMatchSnapshot()
  })

  it('GET: search and ids', async () => {
    const local = a.tc!.email!.split('@')[0]
    const found = await call(tcsGet, { as: a.tmcAdmin, url: `/api/tmc/tcs?search=${encodeURIComponent(local)}` })
    expect((found.json as Paged<{ id: string }>).items.map(t => t.id)).toContain(a.tc!.id)

    const none = await call(tcsGet, { as: a.tmcAdmin, url: '/api/tmc/tcs?search=zz-no-such-person-zz' })
    expect((none.json as Paged<unknown>).total).toBe(0)

    const byId = await call(tcsGet, { as: a.tmcAdmin, url: `/api/tmc/tcs?ids=${a.tc!.id}` })
    expect((byId.json as Paged<{ id: string }>).items.map(t => t.id)).toEqual([a.tc!.id])
  })

  const newTc = (over: Record<string, unknown> = {}) => ({
    email: ' New.Counsellor@Example.Test ', full_name: ' New Counsellor ', send_invite: true,
    permissions: ['manage_policy'], clientIds: [ownClients[0]], ...over,
  })

  it('POST: validation', async () => {
    const post = (body: unknown, as = a.tmcAdmin) => call(tcsPost, { as, method: 'POST', url: '/api/tmc/tcs', body })
    expect((await post(newTc(), a.corpAdmin)).status).toBe(403)
    expect(await post(newTc({ email: '' })))
      .toEqual({ status: 400, json: { error: 'email and full_name are required' } })
    expect(await post(newTc({ email: 'no-at-sign' })))
      .toEqual({ status: 400, json: { error: 'Invalid email address' } })
    expect(await post(newTc({ permissions: ['fly_the_plane'] })))
      .toEqual({ status: 400, json: { error: 'Invalid permission(s): fly_the_plane' } })
    expect(await post(newTc({ clientIds: [foreignClient] })))
      .toEqual({ status: 400, json: { error: 'One or more clients not found for your TMC' } })
    expect(await post(newTc({ email: a.tc!.email })))
      .toEqual({ status: 409, json: { error: 'A TC with this email already exists' } })
  })

  it('POST: invites a counsellor with exactly the permissions and clients asked for', async () => {
    const res = await call(tcsPost, { as: a.tmcAdmin, method: 'POST', url: '/api/tmc/tcs', body: newTc() })
    expect(res.status).toBe(201)
    const { employeeId, message } = res.json as { employeeId: string; message: string }
    expect(message).toBe(' New Counsellor  invited as a TC.')
    expect(outbox.map(m => [m.to, linkIn(m).type])).toEqual([['new.counsellor@example.test', 'invite']])

    const row = await employee(employeeId)
    expect(row).toMatchObject({
      tmc_id: a.tmcAdmin.tmc_id, client_id: null, role: 'tc', status: 'invited',
      email: 'new.counsellor@example.test', full_name: 'New Counsellor', auth_user_id: employeeId,
    })
    expect(await permissionsOf(employeeId)).toEqual(['manage_policy'])
    expect(await accessOf(employeeId)).toEqual([ownClients[0]])
  })

  // ── PATCH /api/tmc/tcs/[id] ────────────────────────────────────────────────

  const patch = (id: string, body: unknown, as = a.tmcAdmin) =>
    call(tcPatch, { as, method: 'PATCH', url: `/api/tmc/tcs/${id}`, params: { id }, body })

  it('PATCH: only a tmc_admin, only their own counsellors', async () => {
    expect(await patch(a.tc!.id, {}, a.corpAdmin))
      .toEqual({ status: 403, json: { error: 'Only TMC admins can edit TCs' } })
    // Not a TC at all.
    expect(await patch(a.corpAdmin.id, {})).toEqual({ status: 404, json: { error: 'TC not found' } })
    expect(await patch(a.tc!.id, {}, a.otherTmcAdmin!)).toEqual({ status: 404, json: { error: 'TC not found' } })
  })

  it('PATCH: validates before writing anything', async () => {
    const perms = await permissionsOf(a.tc!.id)
    expect(await patch(a.tc!.id, { permissions: ['nope'], status: 'active' }))
      .toEqual({ status: 400, json: { error: 'Invalid permission(s): nope' } })
    expect(await patch(a.tc!.id, { clientIds: [foreignClient] }))
      .toEqual({ status: 400, json: { error: 'One or more clients not found for your TMC' } })
    expect(await patch(a.tc!.id, { status: 'invited' }))
      .toEqual({ status: 400, json: { error: 'Invalid status' } })
    expect(await permissionsOf(a.tc!.id)).toEqual(perms)
  })

  it('PATCH: another TMC\'s branch is refused', async () => {
    const theirs = await one<{ id: string }>(db, sql`
      insert into branches (tmc_id, name) values (${a.otherTmcAdmin!.tmc_id}, 'Their Office') returning id`)
    expect(await patch(a.tc!.id, { branchId: theirs.id }))
      .toEqual({ status: 422, json: { error: 'That branch does not belong to your TMC' } })
  })

  it('PATCH: replaces permissions and client access wholesale', async () => {
    const res = await patch(a.tc!.id, {
      permissions: ['view_reports', 'manage_users'],
      clientIds: [ownClients[1], ownClients[2]],
    })
    expect(res).toEqual({ status: 200, json: { ok: true } })
    expect(await permissionsOf(a.tc!.id)).toEqual(['manage_users', 'view_reports'])
    expect(await accessOf(a.tc!.id)).toEqual([ownClients[1], ownClients[2]].sort())
  })

  it('PATCH: status and branch, and clearing the branch', async () => {
    const own = await one<{ id: string }>(db, sql`
      select id from branches where tmc_id = ${a.tmcAdmin.tmc_id} order by id limit 1`)
    expect((await patch(a.tc!.id, { branchId: own.id, status: 'deactivated' })).status).toBe(200)
    expect(await employee(a.tc!.id)).toMatchObject({ branch_id: own.id, status: 'deactivated' })

    expect((await patch(a.tc!.id, { branchId: '', status: 'active' })).status).toBe(200)
    expect(await employee(a.tc!.id)).toMatchObject({ branch_id: null, status: 'active' })
  })

  it('PATCH: a write that fails part-way leaves nothing changed', async () => {
    const perms = await permissionsOf(a.tc!.id)
    const access = await accessOf(a.tc!.id)
    expect(perms.length).toBeGreaterThan(0)
    expect(access.length).toBeGreaterThan(0)

    // A repeated key passes validation and then violates the primary key on
    // insert -- AFTER the delete that cleared the old set, and after client
    // access has been wiped. Without the transaction the TC is left with
    // nothing at all.
    const res = await patch(a.tc!.id, { clientIds: [], permissions: ['view_reports', 'view_reports'] })
    expect(res.status).toBe(500)
    expect(await permissionsOf(a.tc!.id)).toEqual(perms)
    expect(await accessOf(a.tc!.id)).toEqual(access)
  })
})

// ═══ Branches ═══════════════════════════════════════════════════════════════

d('tmc/branches', () => {
  let a: Actors
  let headOffice: string

  beforeAll(async () => {
    await resetDatabase()
    a = await actors()
    headOffice = (await one<{ id: string }>(db, sql`
      select id from branches where tmc_id = ${a.tmcAdmin.tmc_id} and is_head_office`)).id
    // Someone working out of it, so staff counts and the delete guard have
    // something to show.
    await exec(db, sql`update employees set branch_id = ${headOffice} where id = ${a.tc!.id}`)
  })

  it('GET: 401 signed out, 403 for a corporate user', async () => {
    expect((await call(branchesGet, { url: '/api/tmc/branches' })).status).toBe(401)
    expect((await call(branchesGet, { as: a.corpAdmin, url: '/api/tmc/branches' })).status).toBe(403)
  })

  it('GET: the TMC\'s branches with staff counts', async () => {
    const res = await call(branchesGet, { as: a.tmcAdmin, url: '/api/tmc/branches' })
    expect(res.status).toBe(200)
    expect(res.json).toMatchSnapshot()
  })

  it('GET: search and ids', async () => {
    const none = await call(branchesGet, { as: a.tmcAdmin, url: '/api/tmc/branches?search=zz-nowhere-zz' })
    expect((none.json as Paged<unknown>).total).toBe(0)
    const byId = await call(branchesGet, { as: a.tmcAdmin, url: `/api/tmc/branches?ids=${headOffice}` })
    expect((byId.json as Paged<{ id: string }>).items.map(b => b.id)).toEqual([headOffice])
  })

  const post = (body: unknown) => call(branchesPost, { as: a.tmcAdmin, method: 'POST', url: '/api/tmc/branches', body })

  it('POST: validation', async () => {
    expect(await post({ name: ' ' })).toEqual({ status: 400, json: { error: 'Branch name is required' } })
    expect(await post({ name: 'X', status: 'closed' })).toEqual({ status: 400, json: { error: 'Invalid status: closed' } })
  })

  it('POST: creates a branch, normalising codes', async () => {
    const res = await post({
      name: ' Mumbai ', branch_no: ' bom-01 ', gst_number: '27abcde1234f1z5', gst_city: ' Mumbai ',
      gst_state: '', country: '',
    })
    expect(res.status).toBe(200)
    const { branch } = res.json as { branch: Record<string, unknown> }
    const { id, created_at, ...rest } = branch
    expect(typeof id).toBe('string')
    expect(typeof created_at).toBe('string')
    expect(rest).toMatchSnapshot()
  })

  it('POST: a duplicate name is a 409', async () => {
    expect(await post({ name: 'Mumbai' }))
      .toEqual({ status: 409, json: { error: 'A branch with that name or number already exists' } })
  })

  it('POST: a new head office demotes the old one', async () => {
    const res = await post({ name: 'Delhi HQ', is_head_office: true })
    expect(res.status).toBe(200)
    const heads = await many<{ name: string }>(db, sql`
      select name from branches where tmc_id = ${a.tmcAdmin.tmc_id} and is_head_office`)
    expect(heads).toEqual([{ name: 'Delhi HQ' }])
  })

  // ── /api/tmc/branches/[id] ─────────────────────────────────────────────────

  const at = (id: string) => ({ url: `/api/tmc/branches/${id}`, params: { id } })

  it('[id] GET: another TMC cannot see it', async () => {
    expect(await call(branchGet, { as: a.otherTmcAdmin!, ...at(headOffice) }))
      .toEqual({ status: 404, json: { error: 'Branch not found' } })
  })

  it('[id] GET: the branch and who works there', async () => {
    const res = await call(branchGet, { as: a.tmcAdmin, ...at(headOffice) })
    expect(res.status).toBe(200)
    expect(res.json).toMatchSnapshot()
  })

  it('[id] PATCH: validation and duplicates', async () => {
    const p = (body: unknown) => call(branchPatch, { as: a.tmcAdmin, method: 'PATCH', ...at(headOffice), body })
    expect(await p({ name: '' })).toEqual({ status: 400, json: { error: 'Branch name cannot be empty' } })
    expect(await p({ status: 'gone' })).toEqual({ status: 400, json: { error: 'Invalid status: gone' } })
    expect(await p({ name: 'Mumbai' }))
      .toEqual({ status: 409, json: { error: 'A branch with that name or number already exists' } })
  })

  it('[id] PATCH: edits, and promoting to head office demotes the incumbent', async () => {
    const res = await call(branchPatch, {
      as: a.tmcAdmin, method: 'PATCH', ...at(headOffice),
      body: { office_id: ' delx12345 ', is_head_office: true, status: 'inactive' },
    })
    expect(res.status).toBe(200)
    const { branch } = res.json as { branch: Record<string, unknown> }
    expect(branch).toMatchObject({ id: headOffice, office_id: 'DELX12345', is_head_office: true, status: 'inactive' })
    const heads = await many<{ id: string }>(db, sql`
      select id from branches where tmc_id = ${a.tmcAdmin.tmc_id} and is_head_office`)
    expect(heads).toEqual([{ id: headOffice }])
  })

  it('[id] DELETE: refused while someone works there', async () => {
    const res = await call(branchDelete, { as: a.tmcAdmin, method: 'DELETE', ...at(headOffice) })
    expect(res.status).toBe(409)
    expect((res.json as { error: string }).error).toMatch(/^1 person works out of ".+"\. Move them/)
  })

  it('[id] DELETE: an empty branch is removed', async () => {
    const mumbai = await one<{ id: string }>(db, sql`
      select id from branches where tmc_id = ${a.tmcAdmin.tmc_id} and name = 'Mumbai'`)
    expect(await call(branchDelete, { as: a.tmcAdmin, method: 'DELETE', ...at(mumbai.id) }))
      .toEqual({ status: 200, json: { ok: true } })
    expect(await maybeOne(db, sql`select id from branches where id = ${mumbai.id}`)).toBeNull()
  })
})

// ═══ Bands ══════════════════════════════════════════════════════════════════

d('tmc/bands', () => {
  let a: Actors
  let clientId: string
  const bandId = async (code: string) =>
    (await one<{ id: string }>(db, sql`select id from bands where client_id = ${clientId} and code = ${code}`)).id

  beforeAll(async () => {
    await resetDatabase()
    a = await actors()
    clientId = a.corpAdmin.client_id!
  })

  it('GET: 401, clientId required, another TMC\'s client is not found', async () => {
    expect((await call(bandsGet, { url: `/api/tmc/bands?clientId=${clientId}` })).status).toBe(401)
    expect(await call(bandsGet, { as: a.tmcAdmin, url: '/api/tmc/bands' }))
      .toEqual({ status: 400, json: { error: 'clientId is required' } })
    expect(await call(bandsGet, { as: a.otherTmcAdmin!, url: `/api/tmc/bands?clientId=${clientId}` }))
      .toEqual({ status: 404, json: { error: 'Client not found for this TMC' } })
  })

  it('GET: bands by rank with how many people are on each', async () => {
    const res = await call(bandsGet, { as: a.tmcAdmin, url: `/api/tmc/bands?clientId=${clientId}` })
    expect(res.status).toBe(200)
    expect(res.json).toMatchSnapshot()
  })

  const post = (body: Record<string, unknown>) =>
    call(bandsPost, { as: a.tmcAdmin, method: 'POST', url: '/api/tmc/bands', body: { clientId, ...body } })

  it('POST: validation, rank and code clashes', async () => {
    expect(await post({ code: 'L9', label: '' , rank: 9 }))
      .toEqual({ status: 400, json: { error: 'clientId, code, label, and rank are required' } })
    expect(await post({ code: 'L9', label: 'Nine', rank: 1.5 }))
      .toEqual({ status: 400, json: { error: 'rank must be a non-negative whole number' } })
    expect(await post({ code: 'L9', label: 'Nine', rank: 1 }))
      .toEqual({ status: 409, json: { error: 'Rank 1 is already used by band "L1". Each band needs its own rank.' } })
    expect(await post({ code: 'L1', label: 'Dup', rank: 9 }))
      .toEqual({ status: 409, json: { error: 'This client already has a band with code "L1"' } })
  })

  it('POST: adds a band', async () => {
    const res = await post({ code: ' L9 ', label: ' Nine ', rank: '9' })
    expect(res.status).toBe(201)
    const { band } = res.json as { band: Record<string, unknown> }
    expect(band).toMatchObject({ code: 'L9', label: 'Nine', rank: 9, employeeCount: 0 })
  })

  const patch = (id: string, body: unknown) =>
    call(bandPatch, { as: a.tmcAdmin, method: 'PATCH', url: `/api/tmc/bands/${id}`, params: { id }, body })

  it('[id] PATCH: unknown band, validation, rank clash, nothing to update', async () => {
    expect(await patch(NO_SUCH_ID, { label: 'x' })).toEqual({ status: 404, json: { error: 'Band not found' } })
    const l3 = await bandId('L3')
    expect(await patch(l3, { code: ' ' })).toEqual({ status: 400, json: { error: 'code cannot be empty' } })
    expect(await patch(l3, { rank: 4 }))
      .toEqual({ status: 409, json: { error: 'Rank 4 is already used by band "L4". Each band needs its own rank.' } })
    expect(await patch(l3, { code: 'L4' }))
      .toEqual({ status: 409, json: { error: 'This client already has a band with code "L4"' } })
    expect(await patch(l3, {})).toEqual({ status: 400, json: { error: 'Nothing to update' } })
  })

  it('[id] PATCH: a rename follows through to the employees on it', async () => {
    const l3 = await bandId('L3')
    const res = await patch(l3, { code: 'SENIOR', label: 'Senior', rank: 30 })
    expect(res).toMatchObject({ status: 200, json: { ok: true, rankChanged: true, band: { id: l3, code: 'SENIOR', rank: 30 } } })
    const onIt = await many<{ band_code: string; band_rank: number }>(db, sql`
      select band_code, band_rank from employees where band_id = ${l3}`)
    expect(onIt.length).toBeGreaterThan(0)
    expect(onIt.every(e => e.band_code === 'SENIOR' && e.band_rank === 30)).toBe(true)
  })

  it('[id] DELETE: refused while anyone is on it; an empty band goes', async () => {
    const del = (id: string) =>
      call(bandDelete, { as: a.tmcAdmin, method: 'DELETE', url: `/api/tmc/bands/${id}`, params: { id } })
    expect(await del(await bandId('L1')))
      .toEqual({ status: 409, json: { error: '1 employee is on band "L1". Move them to another band before deleting it.' } })
    const l2 = await bandId('L2')
    expect(await del(l2)).toEqual({ status: 200, json: { ok: true } })
    expect(await maybeOne(db, sql`select id from bands where id = ${l2}`)).toBeNull()
  })
})

// ═══ Traveller profiles ═════════════════════════════════════════════════════

d('tmc/traveler-profiles', () => {
  let a: Actors
  let clientId: string
  let people: { id: string; email: string }[]

  beforeAll(async () => {
    await resetDatabase()
    a = await actors()
    clientId = a.corpAdmin.client_id!
    people = await many(db, sql`
      select id, email from employees where client_id = ${clientId} order by full_name, id`)
  })

  it('GET: clientId required; another TMC\'s client is not found', async () => {
    expect(await call(profilesGet, { as: a.tmcAdmin, url: '/api/tmc/traveler-profiles' }))
      .toEqual({ status: 400, json: { error: 'clientId is required' } })
    expect(await call(profilesGet, { as: a.otherTmcAdmin!, url: `/api/tmc/traveler-profiles?clientId=${clientId}` }))
      .toEqual({ status: 404, json: { error: 'Client not found for this TMC' } })
  })

  it('GET: the roster with trips, bands and cost centres', async () => {
    const res = await call(profilesGet, { as: a.tmcAdmin, url: `/api/tmc/traveler-profiles?clientId=${clientId}` })
    expect(res.status).toBe(200)
    expect(res.json).toMatchSnapshot()
  })

  it('GET: search and ids', async () => {
    const none = await call(profilesGet, { as: a.tmcAdmin, url: `/api/tmc/traveler-profiles?clientId=${clientId}&search=zz-nobody-zz` })
    expect((none.json as Paged<unknown>).total).toBe(0)
    const byId = await call(profilesGet, { as: a.tmcAdmin, url: `/api/tmc/traveler-profiles?clientId=${clientId}&ids=${people[0].id}` })
    expect((byId.json as Paged<{ id: string }>).items.map(e => e.id)).toEqual([people[0].id])
  })

  const patch = (id: string, body: unknown) =>
    call(profilePatch, { as: a.tmcAdmin, method: 'PATCH', url: `/api/tmc/traveler-profiles/${id}`, params: { id }, body })

  it('[id] PATCH: not found, validation, unknown cost centre and band', async () => {
    expect(await patch(NO_SUCH_ID, {})).toEqual({ status: 404, json: { error: 'Employee not found' } })
    // TMC staff have no client, so no traveller profile to edit here.
    expect(await patch(a.tc!.id, {})).toEqual({ status: 404, json: { error: 'Employee not found' } })
    const id = people[0].id
    expect(await patch(id, { fullName: ' ' })).toEqual({ status: 400, json: { error: 'Name cannot be empty' } })
    expect(await patch(id, { costCentre: 'NOPE' })).toEqual({
      status: 422, json: { error: '"NOPE" is not one of this client\'s cost centres. Add it under Cost centres first.' },
    })
    expect(await patch(id, { band: 'Z9' }))
      .toEqual({ status: 422, json: { error: 'Band "Z9" is not configured for this client' } })
    expect(await patch(id, {})).toEqual({ status: 400, json: { error: 'Nothing to update' } })
  })

  it('[id] PATCH: merges the profile, keeping what the traveller entered', async () => {
    const id = people[0].id
    await exec(db, sql`
      update employees set traveler_profile = '{"mealPreference":"Veg","city":"Old City"}'::jsonb where id = ${id}`)
    const res = await patch(id, {
      fullName: ' Edited Name ', department: ' ', designation: ' Lead ', costCentre: 'IT101G', band: 'L4',
      profile: { city: ' New City ', dateOfBirth: '02/02/1992', notAField: 'dropped' },
    })
    expect(res.status).toBe(200)
    expect(res.json).toMatchSnapshot()
    expect(await employee(id)).toMatchObject({
      full_name: 'Edited Name', department: null, designation: 'Lead', cost_centre: 'IT101G',
      band_code: 'L4', band_rank: 4,
      traveler_profile: { mealPreference: 'Veg', city: 'New City', dateOfBirth: '02/02/1992' },
    })
  })

  // ── CSV ────────────────────────────────────────────────────────────────────

  it('CSV GET: the roster as the upload template', async () => {
    const res = await call(csvGet, { as: a.tmcAdmin, url: `/api/tmc/traveler-profiles/csv?clientId=${clientId}` })
    expect(res.status).toBe(200)
    expect(res.json).toMatchSnapshot()
  })

  const upload = (body: unknown) =>
    call(csvPost, { as: a.tmcAdmin, method: 'POST', url: '/api/tmc/traveler-profiles/csv', body })

  it('CSV POST: validation', async () => {
    expect(await upload({ clientId })).toEqual({ status: 400, json: { error: 'clientId and rows are required' } })
    expect(await upload({ clientId, rows: [] })).toEqual({ status: 400, json: { error: 'The file has no rows' } })
    expect(await upload({ clientId, rows: Array.from({ length: 1001 }, () => ({})) }))
      .toEqual({ status: 400, json: { error: 'Maximum 1000 rows per upload' } })
    expect((await upload({ clientId: NO_SUCH_ID, rows: [{}] })).status).toBe(404)
  })

  it('CSV POST: applies good rows, reports bad ones', async () => {
    const [p1, p2] = people
    await exec(db, sql`
      update employees set traveler_profile = '{"mobile":"9000000000","city":"Keep"}'::jsonb where id = ${p2.id}`)
    const res = await upload({
      clientId,
      rows: [
        { email: '' },
        { email: 'nobody@example.test' },
        { email: p1.email, band: 'zz' },
        { email: p1.email, cost_centre: 'NOPE' },
        // Band matched case-insensitively; an empty cell clears that field.
        { email: ` ${p2.email.toUpperCase()} `, band: 'l5', cost_centre: 'it101g', mobile: '', state: ' Goa ' },
      ],
    })
    expect(res).toEqual({
      status: 200,
      json: {
        ok: true, updated: 1, skipped: 4,
        errors: [
          { row: 2, email: '', error: 'Missing email' },
          { row: 3, email: 'nobody@example.test', error: 'No employee at this client with that email' },
          { row: 4, email: p1.email.toLowerCase(), error: 'Band "zz" is not configured' },
          { row: 5, email: p1.email.toLowerCase(), error: 'Cost centre "NOPE" does not exist' },
        ],
      },
    })
    expect(await employee(p2.id)).toMatchObject({
      band_code: 'L5', band_rank: 5, cost_centre: 'it101g',
      traveler_profile: { city: 'Keep', state: 'Goa' },
    })
    expect((await employee(p2.id))?.traveler_profile).not.toHaveProperty('mobile')
  })
})

// ═══ Adding a person by hand ════════════════════════════════════════════════

d('tmc/employees POST', () => {
  let a: Actors
  let clientId: string

  beforeAll(async () => {
    await resetDatabase()
    a = await actors()
    clientId = a.corpAdmin.client_id!
  })

  const add = (body: Record<string, unknown>, as: Actors[keyof Actors] = a.tmcAdmin) =>
    call(addPerson, { as: as as never, method: 'POST', url: '/api/tmc/employees', body })
  const person = (over: Record<string, unknown> = {}) =>
    ({ clientId, fullName: ' Asha Rao ', email: ' Asha.Rao@Example.Test ', role: 'employee', band: 'l2', ...over })

  it('401 signed out; clientId required; corporate users and other TMCs are refused', async () => {
    expect((await call(addPerson, { method: 'POST', url: '/api/tmc/employees', body: person() })).status).toBe(401)
    expect(await add({ fullName: 'X' })).toEqual({ status: 400, json: { error: 'clientId is required' } })
    expect((await add(person(), a.corpAdmin)).status).toBe(403)
    expect(await add(person(), a.otherTmcAdmin!)).toEqual({ status: 404, json: { error: 'Client not found for this TMC' } })
  })

  it('validates before writing anything', async () => {
    expect(await add(person({ fullName: ' ' }))).toEqual({ status: 400, json: { error: 'Name and email are required' } })
    expect(await add(person({ email: 'not-an-email' }))).toEqual({ status: 400, json: { error: 'Invalid email address' } })
    expect(await add(person({ role: 'overlord' }))).toEqual({ status: 400, json: { error: 'Invalid role: overlord' } })
    expect(await add(person({ band: ' ' }))).toEqual({ status: 400, json: { error: 'Band is required' } })
    expect(await add(person({ band: 'Z9' })))
      .toEqual({ status: 422, json: { error: 'Band "Z9" is not configured for this client' } })
    expect(outbox).toEqual([])
  })

  it('an SBT client: an invited account, band matched case-insensitively, invite emailed', async () => {
    await exec(db, sql`update clients set booking_mode = 'sbt' where id = ${clientId}`)
    const res = await add(person())
    expect(res.status).toBe(201)
    const { employeeId, message } = res.json as { employeeId: string; message: string }
    expect(message).toBe('Asha Rao added. Invite sent to asha.rao@example.test.')
    expect(outbox.map(m => [m.to, linkIn(m).type])).toEqual([['asha.rao@example.test', 'invite']])
    expect(await employee(employeeId)).toMatchObject({
      client_id: clientId, auth_user_id: employeeId, full_name: 'Asha Rao', email: 'asha.rao@example.test',
      role: 'employee', status: 'invited', onboarding_method: 'invite',
      band_code: 'L2', band_rank: 2, first_login_completed: false,
    })
  })

  it('the same email again is a 409', async () => {
    expect(await add(person())).toEqual({ status: 409, json: { error: 'Someone at this client already has this email' } })
  })

  it('a CBT-only client\'s person is invited too: everyone gets credentials', async () => {
    await exec(db, sql`update clients set booking_mode = 'cbt' where id = ${clientId}`)
    const res = await add(person({ email: 'cbt.person@example.test', role: 'Finance' }))
    expect(res.status).toBe(201)
    expect((res.json as { message: string }).message).toBe('Asha Rao added. Invite sent to cbt.person@example.test.')
    expect(outbox.map(m => [m.to, linkIn(m).type])).toEqual([['cbt.person@example.test', 'invite']])
    expect(await employee((res.json as { employeeId: string }).employeeId))
      .toMatchObject({ role: 'finance', status: 'invited', onboarding_method: 'invite' })
    await exec(db, sql`update clients set booking_mode = 'sbt' where id = ${clientId}`)
  })
})

// ═══ Sending someone an invite ══════════════════════════════════════════════

d('tmc/employees/[id]/invite', () => {
  let a: Actors
  let clientId: string
  let person: { id: string; email: string; full_name: string }

  beforeAll(async () => {
    await resetDatabase()
    a = await actors()
    clientId = a.corpAdmin.client_id!
    person = await one(db, sql`
      select e.id, e.email, e.full_name from employees e join accounts acc on acc.id = e.id
      where e.client_id = ${clientId} and e.id <> ${a.corpAdmin.id} and acc.password_hash is null
        and e.status <> 'deactivated'
      order by e.full_name, e.id limit 1`)
  })

  const invite = (id: string, as: Actors[keyof Actors] = a.tmcAdmin) =>
    call(invitePerson, { as: as as never, method: 'POST', url: `/api/tmc/employees/${id}/invite`, params: { id } })

  it('not found, TMC staff, another TMC, and corporate users are refused', async () => {
    expect(await invite(NO_SUCH_ID)).toEqual({ status: 404, json: { error: 'Employee not found' } })
    expect(await invite(a.tc!.id)).toEqual({ status: 404, json: { error: 'Employee not found' } })
    expect(await invite(person.id, a.otherTmcAdmin!)).toEqual({ status: 404, json: { error: 'Employee not found for this TMC' } })
    expect((await invite(person.id, a.corpAdmin)).status).toBe(403)
    expect(outbox).toEqual([])
  })

  it('the roster says who cannot sign in yet', async () => {
    const res = await call(profilesGet, { as: a.tmcAdmin, url: `/api/tmc/traveler-profiles?clientId=${clientId}&ids=${person.id}` })
    expect((res.json as Paged<{ can_sign_in: boolean }>).items[0].can_sign_in).toBe(false)
  })

  it('emails an invite, and a second one retires the first link', async () => {
    expect(await invite(person.id)).toEqual({ status: 200, json: { ok: true, message: `Invite sent to ${person.email}.` } })
    expect(await invite(person.id)).toEqual({ status: 200, json: { ok: true, message: `Invite sent to ${person.email}.` } })
    expect(outbox.map(m => [m.to, linkIn(m).type])).toEqual([[person.email, 'invite'], [person.email, 'invite']])
    const live = await one<{ n: number }>(db, sql`
      select count(*)::int as n from auth_tokens where account_id = ${person.id} and consumed_at is null`)
    expect(live.n).toBe(1)
  })

  it('someone who can already sign in, or is deactivated, is not sent one', async () => {
    await exec(db, sql`update accounts set password_hash = 'set' where id = ${person.id}`)
    expect(await invite(person.id)).toEqual({
      status: 409,
      json: { error: `${person.full_name} can already sign in. A forgotten password can be reset from the sign-in page.` },
    })
    await exec(db, sql`update accounts set password_hash = null where id = ${person.id}`)
    await exec(db, sql`update employees set status = 'deactivated' where id = ${person.id}`)
    expect(await invite(person.id)).toEqual({
      status: 409, json: { error: `${person.full_name} is deactivated. Reactivate them first.` },
    })
    expect(outbox).toEqual([])
  })
})
