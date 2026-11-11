import { describe, it, expect, beforeAll } from 'vitest'
import { PATCH as employeePatch } from '@/app/api/tmc/employees/[id]/route'
import { GET as rosterGet } from '@/app/api/tmc/traveler-profiles/route'
import { call } from '../harness/call'
import { actors, type Actors } from '../harness/actors'
import { resetDatabase } from '../harness/db'
import { db } from '@/app/lib/db'
import { sql, one, many, exec } from '@/app/lib/db/sql'
import { getPool } from '@/app/lib/db/pool'

// ── Corporate admins, set by the TMC from Traveller profiles ─────────────────
// A client may have several corporate admins. The TMC promotes and demotes
// them (PATCH /api/tmc/employees/[id] with role), never leaving a client with
// none; the roster tags them and filters to them.
// ─────────────────────────────────────────────────────────────────────────────

const HAS_DB = Boolean(process.env.DATABASE_URL)
const d = HAS_DB ? describe : describe.skip

d('corporate admins', () => {
  let a: Actors
  let clientId: string
  let colleague: { id: string; full_name: string }

  const setRole = (as: { id: string }, id: string, role: unknown) =>
    call(employeePatch, { as, method: 'PATCH', url: `/api/tmc/employees/${id}`, params: { id }, body: { role } })
  const roleOf = async (id: string) => (await one<{ role: string }>(db, sql`select role from employees where id = ${id}`)).role
  const admins = () => many<{ id: string }>(db, sql`
    select id from employees where client_id = ${clientId} and role = 'admin' and status = 'active' order by id`)

  beforeAll(async () => {
    await resetDatabase()
    a = await actors()
    clientId = a.corpAdmin.client_id!
    colleague = await one(db, sql`
      select id, full_name from employees where client_id = ${clientId} and role = 'employee' and status = 'active'
      order by id limit 1`)
  })

  it('the roster tags roles and filters to the admins', async () => {
    const res = await call(rosterGet, { as: a.tmcAdmin, url: `/api/tmc/traveler-profiles?clientId=${clientId}&role=admin` })
    expect(res.status).toBe(200)
    const items = (res.json as { items: { id: string; role: string }[] }).items
    expect(items.length).toBeGreaterThan(0)
    expect(items.every(i => i.role === 'admin')).toBe(true)
    expect(items.map(i => i.id)).toContain(a.corpAdmin.id)

    expect((await call(rosterGet, { as: a.tmcAdmin, url: `/api/tmc/traveler-profiles?clientId=${clientId}&role=owner` })).status).toBe(400)
  })

  it('promote, then demote: written, audited, and the answer says whether they can sign in', async () => {
    const up = await setRole(a.tmcAdmin, colleague.id, 'admin')
    expect(up.status).toBe(200)
    expect(up.json).toMatchObject({ ok: true, employee: { id: colleague.id, role: 'admin' }, canSignIn: expect.any(Boolean) })
    expect(await roleOf(colleague.id)).toBe('admin')

    const logged = await one<{ metadata: unknown; user_id: string }>(db, sql`
      select metadata, user_id from audit_log where action = 'employee.role_changed' and entity_id = ${colleague.id}
      order by created_at desc limit 1`)
    expect(logged).toEqual({ metadata: { from: 'employee', to: 'admin' }, user_id: a.tmcAdmin.id })

    const down = await setRole(a.tmcAdmin, colleague.id, 'employee')
    expect(down.status).toBe(200)
    expect(await roleOf(colleague.id)).toBe('employee')

    // Sent unchanged: nothing to do, nothing logged.
    const before = (await one<{ n: number }>(db, sql`select count(*)::int as n from audit_log where entity_id = ${colleague.id}`)).n
    expect((await setRole(a.tmcAdmin, colleague.id, 'employee')).status).toBe(200)
    expect((await one<{ n: number }>(db, sql`select count(*)::int as n from audit_log where entity_id = ${colleague.id}`)).n).toBe(before)
  })

  it('the last active admin cannot be removed', async () => {
    // Leave the corporate admin as the client's only one.
    await exec(db, sql`update employees set role = 'employee'
      where client_id = ${clientId} and role = 'admin' and id <> ${a.corpAdmin.id}`)
    expect(await admins()).toEqual([{ id: a.corpAdmin.id }])

    const res = await setRole(a.tmcAdmin, a.corpAdmin.id, 'employee')
    expect(res.status).toBe(409)
    expect(res.json).toMatchObject({ code: 'LAST_ADMIN' })
    expect(await roleOf(a.corpAdmin.id)).toBe('admin')

    // With a second admin, the first can step down.
    expect((await setRole(a.tmcAdmin, colleague.id, 'admin')).status).toBe(200)
    expect((await setRole(a.tmcAdmin, a.corpAdmin.id, 'finance')).status).toBe(200)
    expect(await admins()).toEqual([{ id: colleague.id }])
    // Put back for the tests below.
    expect((await setRole(a.tmcAdmin, a.corpAdmin.id, 'admin')).status).toBe(200)
  })

  it('two admins removed at the same moment: the second waits, then is refused', async () => {
    expect((await admins()).map(r => r.id).sort()).toEqual([a.corpAdmin.id, colleague.id].sort())
    // Another desk is mid-way through removing the corporate admin: it holds
    // the client's admin rows and has written, not yet committed.
    const other = await getPool().connect()
    try {
      await other.query('begin')
      await other.query(`select id from employees where client_id = $1 and role = 'admin' and status = 'active' for update`, [clientId])
      await other.query(`update employees set role = 'employee' where id = $1`, [a.corpAdmin.id])

      // This removal must wait for that one rather than read around it.
      let settled = false
      const pending = setRole(a.tmcAdmin, colleague.id, 'employee').then(r => { settled = true; return r })
      await new Promise(r => setTimeout(r, 400))
      expect(settled).toBe(false)

      await other.query('commit')
      const res = await pending
      expect(res.status).toBe(409)
      expect(res.json).toMatchObject({ code: 'LAST_ADMIN' })
    } finally {
      other.release()
    }
    expect(await admins()).toEqual([{ id: colleague.id }])
    // Restore the corporate admin.
    expect((await setRole(a.tmcAdmin, a.corpAdmin.id, 'admin')).status).toBe(200)
    expect((await setRole(a.tmcAdmin, colleague.id, 'employee')).status).toBe(200)
  })

  it('refused: an unknown role, a deactivated person, another TMC, a counsellor without manage_users', async () => {
    expect((await setRole(a.tmcAdmin, colleague.id, 'owner')).status).toBe(400)
    expect((await setRole(a.tmcAdmin, colleague.id, 'tmc_admin')).status).toBe(400)

    await exec(db, sql`update employees set status = 'deactivated' where id = ${colleague.id}`)
    try {
      expect((await setRole(a.tmcAdmin, colleague.id, 'admin')).status).toBe(409)
    } finally {
      await exec(db, sql`update employees set status = 'active' where id = ${colleague.id}`)
    }

    if (a.otherTmcAdmin) {
      expect((await setRole(a.otherTmcAdmin, colleague.id, 'admin')).status).toBe(404)
    }
    if (a.tc) {
      const tc = a.tc
      await exec(db, sql`delete from employee_permissions where employee_id = ${tc.id} and permission_key = 'manage_users'`)
      expect((await setRole(tc, colleague.id, 'admin')).status).toBe(403)
    }
    expect(await roleOf(colleague.id)).toBe('employee')
  })
})
