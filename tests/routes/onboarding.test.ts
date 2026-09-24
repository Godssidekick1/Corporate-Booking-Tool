import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import { GET as tmcsGet, POST as tmcsPost } from '@/app/api/platform/tmcs/route'
import { GET as tmcGet, POST as tmcInvite, PATCH as tmcPatch } from '@/app/api/platform/tmcs/[id]/route'
import { GET as staffCsvGet, POST as staffCsvPost } from '@/app/api/platform/tmcs/[id]/staff-csv/route'
import { POST as internalCreateTmc } from '@/app/api/internal/create-tmc/route'
import { POST as createCorporate } from '@/app/api/tmc/create-corporate/bulk/route'
import { call } from '../harness/call'
import { actors, type Actors } from '../harness/actors'
import { resetDatabase } from '../harness/db'
import { authCalls, failNextAuthWith } from '../harness/authAdmin'
import { db } from '@/app/lib/db'
import { sql, many, one, maybeOne } from '@/app/lib/db/sql'

// ── Bringing tenants into existence ──────────────────────────────────────────
// The platform surface (TMCs, their admins, their counsellor roster by CSV),
// the Postman fallback that onboards a TMC, and a TMC onboarding a client with
// its roster.
//
// Every one of these creates accounts, so GoTrue is FAKED: no real user is
// created and no email is sent. The fake's ids are derived from the email.
// ─────────────────────────────────────────────────────────────────────────────

const HAS_DB = Boolean(process.env.DATABASE_URL)
const d = HAS_DB ? describe : describe.skip

const NO_SUCH_ID = '00000000-0000-0000-0000-0000000fab1e'

interface Paged<T> { items: T[]; total: number }

const BANDS = [
  { code: 'L1', label: 'Associate', rank: 1 },
  { code: 'L2', label: 'Manager', rank: 2 },
  { code: 'L3', label: 'Director', rank: 3 },
]

d('onboarding', () => {
  let a: Actors
  let platform: { id: string }

  beforeAll(async () => {
    await resetDatabase()
    a = await actors()
    platform = a.platformAdmin!
    vi.stubEnv('INTERNAL_API_SECRET', 'test-internal-secret')
  })
  afterAll(() => { vi.unstubAllEnvs() })
  beforeEach(() => { authCalls.length = 0 })

  const invites = () => authCalls.filter(c => c.method === 'inviteUserByEmail').map(c => c.args[0])

  // ── The platform: TMCs ─────────────────────────────────────────────────────

  it('platform: only platform admins; everyone else gets 404, not 403', async () => {
    expect((await call(tmcsGet, { as: null, url: '/api/platform/tmcs' })).status).toBe(401)
    expect(await call(tmcsGet, { as: a.tmcAdmin, url: '/api/platform/tmcs' }))
      .toEqual({ status: 404, json: { error: 'Not found' } })
    expect((await call(tmcGet, { as: a.corpAdmin, url: `/api/platform/tmcs/${a.tmcAdmin.tmc_id}`,
      params: { id: a.tmcAdmin.tmc_id! } })).status).toBe(404)
  })

  it('platform: every TMC with its client, staff and admin counts', async () => {
    const res = await call(tmcsGet, { as: platform, url: '/api/platform/tmcs?pageSize=50' })
    expect(res.status).toBe(200)
    expect(res.json).toMatchSnapshot()
    const searched = (await call(tmcsGet, { as: platform, url: '/api/platform/tmcs?search=amadeus' })).json as
      Paged<{ name: string }>
    expect(searched.items.map(t => t.name)).toEqual(['Amadeus'])
  })

  it('platform: one TMC, with its desk', async () => {
    const res = await call(tmcGet, { as: platform, url: '/x', params: { id: a.tmcAdmin.tmc_id! } })
    expect(res.status).toBe(200)
    expect(res.json).toMatchSnapshot()
    expect((await call(tmcGet, { as: platform, url: '/x', params: { id: NO_SUCH_ID } })).status).toBe(404)
  })

  let created: string

  it('platform: create a TMC and invite its first admin', async () => {
    const post = (body: unknown) => call(tmcsPost, { as: platform, method: 'POST', url: '/api/platform/tmcs', body })
    expect((await post({ tmcName: 'X' })).json).toEqual({ error: 'tmcName, adminEmail and adminName are required' })
    expect((await post({ tmcName: 'X', adminEmail: 'nope', adminName: 'Y' })).json)
      .toEqual({ error: '"nope" is not a valid email address' })
    // A name used by exactly one TMC is caught before anything is created.
    expect(await post({ tmcName: 'amadeus', adminEmail: 'a@example.test', adminName: 'A' }))
      .toEqual({ status: 409, json: { error: 'A TMC named "amadeus" already exists.' } })
    // And a name that is ALREADY duplicated. The check used maybeSingle(), which
    // errors on two matches; the error read as "no clash" and yet another copy
    // was made -- the template holds seventeen "AMEX".
    expect(await post({ tmcName: 'AMEX', adminEmail: 'b@example.test', adminName: 'B' }))
      .toEqual({ status: 409, json: { error: 'A TMC named "AMEX" already exists.' } })
    expect(invites()).toEqual([])

    const res = await post({ tmcName: ' Fresh Travel ', adminEmail: ' Boss@Fresh.Example ', adminName: ' Fresh Boss ' })
    expect(res.status).toBe(201)
    created = (res.json as { tmcId: string }).tmcId
    expect(res.json).toMatchObject({ ok: true, message: '" Fresh Travel " created. Invite sent to  Boss@Fresh.Example .' })
    expect(await one(db, sql`select name, status from tmcs where id = ${created}`))
      .toEqual({ name: 'Fresh Travel', status: 'active' })
    expect(await many(db, sql`select email, full_name, role, status, client_id from employees where tmc_id = ${created}`))
      .toEqual([{ email: 'boss@fresh.example', full_name: 'Fresh Boss', role: 'tmc_admin', status: 'invited', client_id: null }])
    expect(invites()).toEqual(['boss@fresh.example'])
    expect((authCalls[0].args[1] as { data: unknown }).data)
      .toEqual({ full_name: 'Fresh Boss', tmc_id: created, role: 'tmc_admin' })
  })

  it('platform: a failed invite leaves no TMC behind', async () => {
    failNextAuthWith('A user with this email address has already been registered')
    const res = await call(tmcsPost, { as: platform, method: 'POST', url: '/api/platform/tmcs',
      body: { tmcName: 'Doomed Travel', adminEmail: 'doomed@example.test', adminName: 'D' } })
    expect(res).toEqual({ status: 500, json: { error: 'A user with this email address has already been registered' } })
    expect(await maybeOne(db, sql`select id from tmcs where name = 'Doomed Travel'`)).toBeNull()
  })

  it('platform: invite a further admin; refuse an email already there', async () => {
    const invite = (id: string, body: unknown) =>
      call(tmcInvite, { as: platform, method: 'POST', url: '/x', params: { id }, body })
    expect((await invite(NO_SUCH_ID, { fullName: 'A', email: 'a@example.test' })).status).toBe(404)
    expect((await invite(created, { fullName: 'A', email: 'boss@fresh.example' })).json)
      .toEqual({ error: 'Someone with that email is already at this TMC.' })
    expect((await invite(created, { fullName: '', email: 'x@example.test' })).status).toBe(400)
    const res = await invite(created, { fullName: 'Second Boss', email: 'second@fresh.example' })
    expect(res).toEqual({ status: 201, json: { ok: true, message: 'Invite sent to second@fresh.example for Fresh Travel.' } })
    expect(await many(db, sql`select email, role, status from employees where tmc_id = ${created} order by email`)).toEqual([
      { email: 'boss@fresh.example', role: 'tmc_admin', status: 'invited' },
      { email: 'second@fresh.example', role: 'tmc_admin', status: 'invited' },
    ])
  })

  it('platform: retire and restore a TMC', async () => {
    const patch = (id: string, body: unknown) =>
      call(tmcPatch, { as: platform, method: 'PATCH', url: '/x', params: { id }, body })
    expect((await patch(created, { status: 'deleted' })).status).toBe(400)
    expect((await patch(NO_SUCH_ID, { status: 'inactive' })).status).toBe(404)
    expect(await patch(created, { status: 'inactive' }))
      .toEqual({ status: 200, json: { ok: true, tmc: { id: created, name: 'Fresh Travel', status: 'inactive' } } })
  })

  // ── The platform: a TMC's counsellors by spreadsheet ───────────────────────

  it('staff csv: the download is the template', async () => {
    const res = await call(staffCsvGet, { as: platform, url: '/x', params: { id: a.tmcAdmin.tmc_id! } })
    expect(res.status).toBe(200)
    expect(res.json).toMatchSnapshot()
    expect((await call(staffCsvGet, { as: platform, url: '/x', params: { id: NO_SUCH_ID } })).status).toBe(404)
  })

  it('staff csv: creates the new, skips the known, reports the rest', async () => {
    const rows = [
      { email: 'tc.one@fresh.example', full_name: 'TC One', permissions: 'manage_users; manage_clients' },
      { email: 'boss@fresh.example', full_name: 'Already Here' },
      { email: '', full_name: 'Nobody' },
      { email: 'bad-email', full_name: 'Bad' },
      { email: 'admin2@fresh.example', full_name: 'Admin Two', role: 'tmc_admin' },
      { email: 'tc.two@fresh.example', full_name: 'TC Two', permissions: 'fly_planes' },
      { email: 'tc.three@fresh.example', full_name: 'TC Three' },
    ]
    const res = await call(staffCsvPost, { as: platform, method: 'POST', url: '/x', params: { id: created }, body: { rows } })
    expect(res.status).toBe(200)
    const body = res.json as { created: number; skipped: number; errors: { row: number; error: string }[] }
    expect(body.created).toBe(2)
    expect(body.skipped).toBe(1)
    expect(body.errors.map(e => e.row)).toEqual([4, 5, 6, 7])
    expect(body.errors[2].error).toBe('Only "tc" can be imported, not "tmc_admin"')
    expect(body.errors[3].error).toMatch(/^Unknown permission\(s\): fly_planes\. Valid: /)
    expect(await many(db, sql`
      select e.email, e.role, e.status, array(select p.permission_key from employee_permissions p
        where p.employee_id = e.id order by p.permission_key) as permissions
      from employees e where e.tmc_id = ${created} and e.role = 'tc' order by e.email`)).toEqual([
      { email: 'tc.one@fresh.example', role: 'tc', status: 'invited', permissions: ['manage_clients', 'manage_users'] },
      { email: 'tc.three@fresh.example', role: 'tc', status: 'invited', permissions: [] },
    ])
    expect((await call(staffCsvPost, { as: platform, method: 'POST', url: '/x', params: { id: created }, body: { rows: [] } })).json)
      .toEqual({ error: 'The file has no rows' })
  })

  // ── The Postman fallback ───────────────────────────────────────────────────

  it('internal create-tmc: needs the shared secret, then runs the same onboarding', async () => {
    const body = { tmcName: 'Postman Travel', adminEmail: 'pm@postman.example', adminName: 'Post Man' }
    expect(await call(internalCreateTmc, { method: 'POST', url: '/x', body }))
      .toEqual({ status: 401, json: { error: 'Unauthorized' } })
    expect((await call(internalCreateTmc, { method: 'POST', url: '/x', body, headers: { 'x-internal-secret': 'wrong' } })).status)
      .toBe(401)
    const res = await call(internalCreateTmc, {
      method: 'POST', url: '/x', body, headers: { 'x-internal-secret': 'test-internal-secret' } })
    expect(res.status).toBe(201)
    const tmcId = (res.json as { tmcId: string }).tmcId
    expect(await one(db, sql`select count(*)::int as n from employees where tmc_id = ${tmcId} and role = 'tmc_admin'`))
      .toEqual({ n: 1 })
  })

  // ── A TMC onboarding a client ──────────────────────────────────────────────

  const onboard = (body: unknown, as: { id: string } = a.tmcAdmin) =>
    call(createCorporate, { as, method: 'POST', url: '/api/tmc/create-corporate/bulk', body })

  it('create corporate: needs manage_clients, and the client\'s own details', async () => {
    expect((await onboard({ client: {} }, a.corpAdmin)).status).toBe(403)
    expect(await onboard({})).toEqual({ status: 400, json: { error: 'Client details are required' } })
    expect((await onboard({ client: { corporateName: 'Acme' } })).json)
      .toEqual({ error: 'corporateName, adminEmail, and adminName are required' })
    const base = { corporateName: 'Acme', adminEmail: 'a@acme.example', adminName: 'A' }
    expect((await onboard({ client: { ...base, bands: [] } })).json)
      .toEqual({ error: 'At least one band is required — employees need a band for policy to apply' })
    expect((await onboard({ client: { ...base, bands: [BANDS[0], { ...BANDS[1], rank: 1 }] } })).json)
      .toEqual({ error: 'Two bands share rank 1 — each band needs its own rank' })
    expect((await onboard({ client: { ...base, bands: BANDS, size: 'huge' } })).json)
      .toEqual({ error: 'Invalid size: huge. Must be one of 1-50, 51-200, 201-1000, 1001+' })
    expect((await onboard({ client: { ...base, bands: BANDS, policyGroupId: NO_SUCH_ID } })).json)
      .toEqual({ error: 'Policy group not found for this TMC' })
    expect((await onboard({ client: { ...base, bands: BANDS, client_groupId: NO_SUCH_ID } })).json)
      .toEqual({ error: 'client_group not found for this TMC' })
    expect((await onboard({ client: base, employees: Array.from({ length: 251 }, () => ({})) })).json)
      .toEqual({ error: 'Maximum 250 employees per upload' })
    expect(invites()).toEqual([])
  })

  it('create corporate: a same-named client is a question, not a refusal', async () => {
    const existing = await one<{ name: string }>(db, sql`
      select name from clients where tmc_id = ${a.tmcAdmin.tmc_id} order by name, id limit 1`)
    const client = { corporateName: existing.name.toUpperCase(), adminEmail: 'dup@dup.example', adminName: 'Dup', bands: BANDS }
    const res = await onboard({ client })
    expect(res.status).toBe(409)
    expect((res.json as { duplicates: { name: string }[] }).duplicates.map(x => x.name)).toContain(existing.name)
    const confirmed = await onboard({ client: { ...client, confirmDuplicateName: true } })
    expect(confirmed.status).toBe(201)
  })

  it('create corporate: the client, its bands, its GSTIN, its policy, its admin and its roster', async () => {
    const group = await one<{ id: string }>(db, sql`
      select id from policy_groups where tmc_id = ${a.tmcAdmin.tmc_id} order by name, id limit 1`)
    const res = await onboard({
      client: {
        corporateName: ' Globex ', adminEmail: ' CFO@Globex.Example ', adminName: ' Hank ', bands: BANDS,
        gstNumber: ' 29abcde1234f1z5 ', industry: ' Energy ', size: '51-200', bookingMode: 'both',
        policyGroupId: group.id,
      },
      employees: [
        { email: 'one@globex.example', full_name: 'One', role: 'Manager', band: 'l2', department: ' Ops ' },
        { email: 'two@globex.example', full_name: 'Two' },
        { email: 'three@globex.example', full_name: 'Three', role: 'pilot' },
        { email: 'four@globex.example', full_name: 'Four', band: 'L9' },
        { email: 'nope', full_name: 'Bad' },
      ],
    })
    expect(res.status).toBe(201)
    const body = res.json as { clientId: string; employeesCreated: number; employeesFailed: number; employeeResults: unknown[] }
    expect(body).toMatchObject({ ok: true, employeesCreated: 2, employeesFailed: 3 })
    expect(body.employeeResults).toEqual([
      { email: 'one@globex.example', status: 'created' },
      { email: 'two@globex.example', status: 'created' },
      { email: 'three@globex.example', status: 'failed', error: 'Invalid role: pilot' },
      { email: 'four@globex.example', status: 'failed', error: 'Unknown band: L9' },
      { email: 'nope', status: 'failed', error: 'Missing or invalid email/full_name' },
    ])
    const clientId = body.clientId
    expect(await one(db, sql`
      select name, status, setup_completed, industry, size, booking_mode, tmc_id from clients where id = ${clientId}`))
      .toEqual({ name: 'Globex', status: 'active', setup_completed: false, industry: 'Energy', size: '51-200',
        booking_mode: 'both', tmc_id: a.tmcAdmin.tmc_id })
    expect(await many(db, sql`select code, label, rank from bands where client_id = ${clientId} order by rank`)).toEqual(BANDS)
    expect(await many(db, sql`select gstin, gst_holder, is_primary from client_gst_registrations where client_id = ${clientId}`))
      .toEqual([{ gstin: '29ABCDE1234F1Z5', gst_holder: 'Globex', is_primary: true }])
    expect(await many(db, sql`select policy_group_id from client_policy_groups where client_id = ${clientId}`))
      .toEqual([{ policy_group_id: group.id }])
    expect(await many(db, sql`
      select email, full_name, role, status, band_code, band_rank, department, onboarding_method
      from employees where client_id = ${clientId} order by email`)).toEqual([
      // The admin goes on the most senior band.
      { email: 'cfo@globex.example', full_name: 'Hank', role: 'admin', status: 'invited', band_code: 'L3', band_rank: 3,
        department: null, onboarding_method: 'invite' },
      { email: 'one@globex.example', full_name: 'One', role: 'manager', status: 'invited', band_code: 'L2', band_rank: 2,
        department: 'Ops', onboarding_method: 'invite' },
      { email: 'two@globex.example', full_name: 'Two', role: 'employee', status: 'invited', band_code: 'L1', band_rank: 1,
        department: null, onboarding_method: 'invite' },
    ])
    expect(invites()).toEqual(['cfo@globex.example', 'one@globex.example', 'two@globex.example'])
  })

  it('create corporate: a CBT-only client\'s roster are profiles, with no accounts', async () => {
    const res = await onboard({
      client: { corporateName: 'Initech', adminEmail: 'bill@initech.example', adminName: 'Bill', bands: BANDS, bookingMode: 'cbt' },
      employees: [{ email: 'peter@initech.example', full_name: 'Peter', band: 'L1' }],
    })
    expect(res.status).toBe(201)
    const clientId = (res.json as { clientId: string }).clientId
    expect(await many(db, sql`
      select email, status, auth_user_id is null as no_account from employees where client_id = ${clientId} and role <> 'admin'`))
      .toEqual([{ email: 'peter@initech.example', status: 'active', no_account: true }])
    // Only the admin was invited.
    expect(invites()).toEqual(['bill@initech.example'])
  })

  it('create corporate: roster bands are the client\'s own codes, and blank means the least senior', async () => {
    // The importer used to uppercase the cell and default a blank to the
    // literal 'L1', from before clients named their own bands -- so a client
    // with bands "Band 1".."Band 3" failed every row.
    const bands = [
      { code: 'Band 1', label: 'Junior', rank: 1 },
      { code: 'Band 2', label: 'Middle', rank: 2 },
      { code: 'Band 3', label: 'Senior', rank: 3 },
    ]
    const res = await onboard({
      client: { corporateName: 'Hooli', adminEmail: 'gavin@hooli.example', adminName: 'Gavin', bands, bookingMode: 'cbt' },
      employees: [
        { email: 'richard@hooli.example', full_name: 'Richard', band: 'band 2' },
        { email: 'dinesh@hooli.example', full_name: 'Dinesh' },
      ],
    })
    expect(res.json).toMatchObject({ employeesCreated: 2, employeesFailed: 0 })
    const clientId = (res.json as { clientId: string }).clientId
    expect(await many(db, sql`
      select email, band_code from employees where client_id = ${clientId} and role <> 'admin' order by email`)).toEqual([
      { email: 'dinesh@hooli.example', band_code: 'Band 1' },
      { email: 'richard@hooli.example', band_code: 'Band 2' },
    ])
  })

  it('create corporate: a failed admin invite leaves no client behind', async () => {
    failNextAuthWith('Email rate limit exceeded')
    const res = await onboard({
      client: { corporateName: 'Vandelay', adminEmail: 'art@vandelay.example', adminName: 'Art', bands: BANDS },
    })
    expect(res).toEqual({ status: 400, json: { error: 'Email rate limit exceeded' } })
    expect(await maybeOne(db, sql`select id from clients where name = 'Vandelay'`)).toBeNull()
  })
})
