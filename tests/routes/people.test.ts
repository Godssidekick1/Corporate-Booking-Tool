import { describe, it, expect, beforeAll, vi } from 'vitest'
import { GET as tmcProfileGet, PATCH as tmcProfilePatch } from '@/app/api/tmc/profile/route'
import { GET as meGet, PATCH as mePatch } from '@/app/api/employees/me/route'
import { POST as createEmployee } from '@/app/api/employees/route'
import { GET as usersGet } from '@/app/api/settings/users/route'
import { PATCH as userPatch } from '@/app/api/settings/users/[id]/route'
import { GET as tmcEmployeesGet } from '@/app/api/tmc/employees/route'
import { PATCH as tmcEmployeePatch } from '@/app/api/tmc/employees/[id]/route'
import { call } from '../harness/call'
import { actors, type Actors } from '../harness/actors'
import { resetDatabase } from '../harness/db'
import { authCalls } from '../harness/authAdmin'
import { db } from '@/app/lib/db'
import { sql, many, maybeOne, exec } from '@/app/lib/db/sql'

// ── The people screens ───────────────────────────────────────────────────────
// Profiles, the corporate user directory, adding an employee, and the TMC-side
// roster and reporting-line editor.
//
// POST /api/employees creates accounts through GoTrue's admin API. That is
// faked here -- against the real project a test would create real users and
// send real invite emails. Data calls go through untouched.
// ─────────────────────────────────────────────────────────────────────────────

vi.mock('@/utils/supabase/service', async orig => {
  const actual = await orig<typeof import('@/utils/supabase/service')>()
  const { fakeAuth } = await import('../harness/authAdmin')
  return { ...actual, createServiceClient: () => ({ ...actual.createServiceClient(), auth: fakeAuth }) }
})

const HAS_DB = Boolean(process.env.DATABASE_URL)
const d = HAS_DB ? describe : describe.skip

const employee = (id: string) => maybeOne<Record<string, unknown>>(db, sql`select * from employees where id = ${id}`)

const VALID_PROFILE = {
  title: 'MR', gender: 'Male', dateOfBirth: '01/01/1990',
  email: 'traveller@example.test', mobile: '9999999999',
  address: 'Test Address', city: 'Testcity', state: 'Teststate', zipCode: '400001',
}

d('people screens', () => {
  let a: Actors
  let colleague: string        // another employee in the corporate admin's client
  let colleague2: string

  beforeAll(async () => {
    await resetDatabase()
    a = await actors()
    const others = await many<{ id: string }>(db, sql`
      select id from employees
      where client_id = ${a.corpAdmin.client_id} and id <> ${a.corpAdmin.id}
      order by created_at, id`)
    colleague = others[0].id
    colleague2 = others[1].id
  })

  // ── GET/PATCH /api/tmc/profile ─────────────────────────────────────────────

  it('tmc/profile: 401 signed out', async () => {
    expect((await call(tmcProfileGet, { url: '/api/tmc/profile' })).status).toBe(401)
  })

  it('tmc/profile: a corporate user is refused', async () => {
    expect(await call(tmcProfileGet, { as: a.corpAdmin, url: '/api/tmc/profile' }))
      .toEqual({ status: 403, json: { error: 'Not a TMC account' } })
  })

  it('tmc/profile: a tmc_admin sees full access and the whole portfolio', async () => {
    const res = await call(tmcProfileGet, { as: a.tmcAdmin, url: '/api/tmc/profile' })
    expect(res.status).toBe(200)
    expect(res.json).toMatchSnapshot()
  })

  it('tmc/profile: a tc sees their permissions and granted clients only', async () => {
    const res = await call(tmcProfileGet, { as: a.tc, url: '/api/tmc/profile' })
    expect(res.status).toBe(200)
    const body = res.json as { access: { permissions: string[] } }
    body.access.permissions = [...body.access.permissions].sort()
    expect(body).toMatchSnapshot()
  })

  it('tmc/profile PATCH: an empty name is refused', async () => {
    expect(await call(tmcProfilePatch, { as: a.tmcAdmin, method: 'PATCH', url: '/api/tmc/profile', body: { fullName: '  ' } }))
      .toEqual({ status: 400, json: { error: 'Name cannot be empty' } })
  })

  it('tmc/profile PATCH: renames only the caller', async () => {
    const res = await call(tmcProfilePatch, { as: a.tmcAdmin, method: 'PATCH', url: '/api/tmc/profile', body: { fullName: '  Renamed Admin ' } })
    expect(res).toEqual({ status: 200, json: { ok: true, fullName: 'Renamed Admin' } })
    expect((await employee(a.tmcAdmin.id))?.full_name).toBe('Renamed Admin')
  })

  it('tmc/profile PATCH: a corporate user cannot use it', async () => {
    expect((await call(tmcProfilePatch, { as: a.corpAdmin, method: 'PATCH', url: '/api/tmc/profile', body: { fullName: 'X' } })).status).toBe(403)
  })

  // ── GET/PATCH /api/employees/me ────────────────────────────────────────────

  it('employees/me: the traveller profile', async () => {
    const res = await call(meGet, { as: a.corpAdmin, url: '/api/employees/me' })
    expect(res.status).toBe(200)
    expect(res.json).toMatchSnapshot()
  })

  it('employees/me: 404 for someone with no employee row', async () => {
    expect((await call(meGet, { as: { id: '00000000-0000-0000-0000-00000000beef' }, url: '/api/employees/me' })).status).toBe(404)
  })

  it('employees/me PATCH: validates the profile before saving', async () => {
    const res = await call(mePatch, { as: a.corpAdmin, method: 'PATCH', url: '/api/employees/me', body: { ...VALID_PROFILE, title: 'DR' } })
    expect(res).toEqual({ status: 400, json: { error: 'title must be one of MR, MRS, MS, MSTR, MISS' } })
  })

  it('employees/me PATCH: a partial passport is refused', async () => {
    const res = await call(mePatch, { as: a.corpAdmin, method: 'PATCH', url: '/api/employees/me', body: { ...VALID_PROFILE, passportNumber: 'X1' } })
    expect(res.status).toBe(400)
  })

  it('employees/me PATCH: saves the profile and completes first login', async () => {
    await exec(db, sql`update employees set first_login_completed = false where id = ${a.corpAdmin.id}`)
    const res = await call(mePatch, { as: a.corpAdmin, method: 'PATCH', url: '/api/employees/me', body: VALID_PROFILE })
    expect(res.status).toBe(200)
    expect(res.json).toMatchSnapshot()
    const row = await employee(a.corpAdmin.id)
    expect(row?.first_login_completed).toBe(true)
    expect((row?.traveler_profile as { city: string }).city).toBe('Testcity')
  })

  // ── POST /api/employees ────────────────────────────────────────────────────

  const newEmployee = (over: Record<string, unknown> = {}) => ({
    email: 'New.Person@Example.Test', full_name: 'New Person', role: 'employee', band: 'l2', ...over,
  })

  it('employees POST: 401 signed out', async () => {
    expect((await call(createEmployee, { method: 'POST', url: '/api/employees', body: newEmployee() })).status).toBe(401)
  })

  it('employees POST: only a corporate admin may add people', async () => {
    expect(await call(createEmployee, { as: a.employee, method: 'POST', url: '/api/employees', body: newEmployee() }))
      .toEqual({ status: 403, json: { error: 'Only admins can create employees directly' } })
  })

  it('employees POST: required fields', async () => {
    expect((await call(createEmployee, { as: a.corpAdmin, method: 'POST', url: '/api/employees', body: { email: 'x@example.test' } })).status).toBe(400)
  })

  it('employees POST: an invalid role is refused', async () => {
    expect(await call(createEmployee, { as: a.corpAdmin, method: 'POST', url: '/api/employees', body: newEmployee({ role: 'overlord' }) }))
      .toEqual({ status: 400, json: { error: 'Invalid role: overlord' } })
  })

  it('employees POST: an unknown band is 422', async () => {
    expect(await call(createEmployee, { as: a.corpAdmin, method: 'POST', url: '/api/employees', body: newEmployee({ band: 'L9' }) }))
      .toEqual({ status: 422, json: { error: 'Band L9 not found for this client' } })
  })

  it('employees POST: a direct add needs a long enough starting password', async () => {
    const res = await call(createEmployee, { as: a.corpAdmin, method: 'POST', url: '/api/employees', body: newEmployee({ method: 'direct', password: 'short' }) })
    expect(res.status).toBe(400)
  })

  it('employees POST: an invite creates an INVITED employee with the band denormalised', async () => {
    const before = authCalls.length
    const res = await call(createEmployee, { as: a.corpAdmin, method: 'POST', url: '/api/employees', body: newEmployee() })
    expect(res.status).toBe(201)
    const { employeeId, message } = res.json as { employeeId: string; message: string }
    expect(message).toBe('Invite sent to New Person at new.person@example.test.')
    expect(authCalls.slice(before).map(c => c.method)).toEqual(['inviteUserByEmail'])

    const row = await employee(employeeId)
    expect(row).toMatchObject({
      email: 'new.person@example.test', role: 'employee', status: 'invited',
      band_code: 'L2', band_rank: 2, onboarding_method: 'invite', first_login_completed: false,
      client_id: a.corpAdmin.client_id, auth_user_id: employeeId,
    })
  })

  it('employees POST: the same email again is a 409', async () => {
    const res = await call(createEmployee, { as: a.corpAdmin, method: 'POST', url: '/api/employees', body: newEmployee() })
    expect(res).toEqual({ status: 409, json: { error: 'An employee with this email already exists (status: invited)' } })
  })

  it('employees POST: a direct add creates an ACTIVE employee', async () => {
    const res = await call(createEmployee, {
      as: a.corpAdmin, method: 'POST', url: '/api/employees',
      body: newEmployee({ email: 'direct@example.test', method: 'direct', password: 'long-enough-1' }),
    })
    expect(res.status).toBe(201)
    const row = await employee((res.json as { employeeId: string }).employeeId)
    expect(row).toMatchObject({ status: 'active', onboarding_method: 'direct_create' })
  })

  // ── GET /api/settings/users ────────────────────────────────────────────────

  it('settings/users: only a corporate admin', async () => {
    expect((await call(usersGet, { as: a.employee, url: '/api/settings/users' })).status).toBe(403)
  })

  it('settings/users: first page', async () => {
    const res = await call(usersGet, { as: a.corpAdmin, url: '/api/settings/users' })
    expect(res.status).toBe(200)
    expect(res.json).toMatchSnapshot()
  })

  it('settings/users: search', async () => {
    const res = await call(usersGet, { as: a.corpAdmin, url: '/api/settings/users?search=new' })
    expect(res.json).toMatchSnapshot()
  })

  it('settings/users: ?all=true for the hierarchy tree', async () => {
    const res = await call(usersGet, { as: a.corpAdmin, url: '/api/settings/users?all=true' })
    expect((res.json as { total: number }).total).toBeGreaterThan(0)
    expect(res.json).toMatchSnapshot()
  })

  it('settings/users: ?ids= resolves specific people', async () => {
    const res = await call(usersGet, { as: a.corpAdmin, url: `/api/settings/users?ids=${colleague}` })
    expect((res.json as { items: { id: string }[] }).items.map(i => i.id)).toEqual([colleague])
  })

  // ── PATCH /api/settings/users/[id] ─────────────────────────────────────────

  const patchUser = (id: string, body: unknown, as = a.corpAdmin) =>
    call(userPatch, { as, method: 'PATCH', url: `/api/settings/users/${id}`, body, params: { id } })

  it('settings/users/[id]: only a corporate admin', async () => {
    expect((await patchUser(colleague, { role: 'manager' }, a.employee!)).status).toBe(403)
  })

  it('settings/users/[id]: an employee of another client is not found', async () => {
    expect((await patchUser(a.tmcAdmin.id, { role: 'manager' })).status).toBe(404)
  })

  it('settings/users/[id]: an admin cannot edit themselves', async () => {
    expect(await patchUser(a.corpAdmin.id, { role: 'manager' }))
      .toEqual({ status: 400, json: { error: 'You cannot edit your own account here' } })
  })

  it('settings/users/[id]: bands and managers belong to the TMC', async () => {
    expect((await patchUser(colleague, { band: 'L3' })).status).toBe(403)
    expect((await patchUser(colleague, { managerId: null })).status).toBe(403)
  })

  it('settings/users/[id]: validates role and status', async () => {
    expect((await patchUser(colleague, { role: 'overlord' })).status).toBe(400)
    expect((await patchUser(colleague, { status: 'invited' })).status).toBe(400)
    expect((await patchUser(colleague, {})).status).toBe(400)
  })

  it('settings/users/[id]: cannot activate someone who never accepted their invite', async () => {
    await exec(db, sql`update employees set status = 'invited' where id = ${colleague2}`)
    expect(await patchUser(colleague2, { status: 'active' }))
      .toEqual({ status: 400, json: { error: 'This employee has not accepted their invite yet.' } })
    await exec(db, sql`update employees set status = 'active' where id = ${colleague2}`)
  })

  it('settings/users/[id]: changes a role', async () => {
    const res = await patchUser(colleague, { role: 'Manager' })
    expect(res.status).toBe(200)
    expect(res.json).toMatchSnapshot()
  })

  // ── GET /api/tmc/employees ─────────────────────────────────────────────────

  it('tmc/employees: clientId is required', async () => {
    expect((await call(tmcEmployeesGet, { as: a.tmcAdmin, url: '/api/tmc/employees' })).status).toBe(400)
  })

  it('tmc/employees: another TMC cannot list this client', async () => {
    const res = await call(tmcEmployeesGet, { as: a.otherTmcAdmin, url: `/api/tmc/employees?clientId=${a.corpAdmin.client_id}` })
    expect(res).toEqual({ status: 404, json: { error: 'Client not found for this TMC' } })
  })

  it('tmc/employees: the roster', async () => {
    const res = await call(tmcEmployeesGet, { as: a.tmcAdmin, url: `/api/tmc/employees?clientId=${a.corpAdmin.client_id}` })
    expect(res.status).toBe(200)
    expect(res.json).toMatchSnapshot()
  })

  it('tmc/employees: ?missingManager=1 narrows to people with no reporting line', async () => {
    const res = await call(tmcEmployeesGet, { as: a.tmcAdmin, url: `/api/tmc/employees?clientId=${a.corpAdmin.client_id}&missingManager=1` })
    expect(res.json).toMatchSnapshot()
  })

  it('tmc/employees: search', async () => {
    const res = await call(tmcEmployeesGet, { as: a.tmcAdmin, url: `/api/tmc/employees?clientId=${a.corpAdmin.client_id}&search=new` })
    expect(res.json).toMatchSnapshot()
  })

  // ── PATCH /api/tmc/employees/[id] ──────────────────────────────────────────

  const patchReporting = (id: string, body: unknown, as: Actors['tmcAdmin'] | null = a.tmcAdmin) =>
    call(tmcEmployeePatch, { as, method: 'PATCH', url: `/api/tmc/employees/${id}`, body, params: { id } })

  it('tmc/employees/[id]: an unknown employee is 404', async () => {
    expect((await patchReporting('00000000-0000-0000-0000-000000000000', { band: 'L1' })).status).toBe(404)
  })

  it('tmc/employees/[id]: another TMC cannot edit this employee', async () => {
    expect(await patchReporting(colleague, { band: 'L1' }, a.otherTmcAdmin))
      .toEqual({ status: 404, json: { error: 'Employee not found for this TMC' } })
  })

  it('tmc/employees/[id]: marking top of hierarchy clears the manager', async () => {
    await exec(db, sql`update employees set manager_id = ${colleague2} where id = ${colleague}`)
    const res = await patchReporting(colleague, { topOfHierarchy: true })
    expect(res.status).toBe(200)
    expect(res.json).toMatchSnapshot()
  })

  it('tmc/employees/[id]: top of hierarchy and a manager are mutually exclusive', async () => {
    expect((await patchReporting(colleague, { topOfHierarchy: true, managerId: colleague2 })).status).toBe(400)
  })

  it('tmc/employees/[id]: giving someone a manager un-marks them as top', async () => {
    const res = await patchReporting(colleague, { managerId: colleague2 })
    expect(res.status).toBe(200)
    expect(res.json).toMatchSnapshot()
  })

  it('tmc/employees/[id]: a reporting loop is refused', async () => {
    const res = await patchReporting(colleague2, { managerId: colleague })
    expect(res.status).toBe(400)
  })

  it('tmc/employees/[id]: moves someone to a band, denormalising code and rank', async () => {
    const res = await patchReporting(colleague, { band: 'L4' })
    expect(res.status).toBe(200)
    expect(res.json).toMatchSnapshot()
  })

  it('tmc/employees/[id]: an unconfigured band is 422', async () => {
    expect((await patchReporting(colleague, { band: 'L9' })).status).toBe(422)
  })

  it('tmc/employees/[id]: nothing to update', async () => {
    expect((await patchReporting(colleague, {})).status).toBe(400)
  })
})
