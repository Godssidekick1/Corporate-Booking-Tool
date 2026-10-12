import { describe, it, expect, beforeAll } from 'vitest'
import { db } from '@/app/lib/db'
import { sql, one, exec } from '@/app/lib/db/sql'
import type { Principal } from '@/app/lib/auth/session'
import { resolveActor, actingTraveller } from '@/app/lib/book/bookingActor'
import { SELF_BOOKING_OFF } from '@/app/lib/clients/clientGates'
import { actors, type Actors, type Actor } from '../harness/actors'
import { resetDatabase } from '../harness/db'

// ── Who may book for whom (app/lib/book/bookingActor.ts) ─────────────────────
// The table at the top of that file, row by row, against real people in the
// template. Each refusal is asserted by its exact answer: a traveller the
// caller may not book for must look like one who does not exist.
// ─────────────────────────────────────────────────────────────────────────────

const HAS_DB = Boolean(process.env.DATABASE_URL)
const d = HAS_DB ? describe : describe.skip

const NOT_FOUND = { ok: false, status: 404, error: 'Traveller not found' }

// resolveActor reads only the caller's id and employee record.
async function principal(id: string): Promise<Principal> {
  const e = await one<{ role: string; status: string; client_id: string | null; tmc_id: string | null }>(db, sql`
    select role, status, client_id, tmc_id from employees where id = ${id}`)
  return {
    id, email: '', sessionId: '', mustChangePassword: false, lastSignInAt: null, isPlatformAdmin: false,
    context: { scope: 'system' } as Principal['context'],
    employee: { id, fullName: null, role: e.role, status: e.status, clientId: e.client_id, tmcId: e.tmc_id, firstLoginCompleted: true },
  }
}

d('bookingActor', () => {
  let a: Actors
  let tc: Actor
  // A colleague of the corporate admin, and someone at a client of the same
  // TMC that the counsellor does NOT hold.
  let colleague: { id: string; client_id: string }
  let outsider: { id: string; client_id: string }

  const colleagueAt = (clientId: string, not: string) => one<{ id: string; client_id: string }>(db, sql`
    select id, client_id from employees
    where client_id = ${clientId} and id <> ${not} and status <> 'deactivated'
    order by created_at, id limit 1`)

  beforeAll(async () => {
    await resetDatabase()
    a = await actors()
    if (!a.tc || !a.otherTmcAdmin || !a.employee) throw new Error('[tests] template lacks a TC, a second TMC or an employee')
    tc = a.tc
    colleague = await colleagueAt(a.corpAdmin.client_id!, a.corpAdmin.id)
    outsider = await one(db, sql`
      select e.id, e.client_id from employees e join clients c on c.id = e.client_id
      where c.tmc_id = ${tc.tmc_id} and c.status <> 'inactive' and e.status <> 'deactivated'
        and c.id <> ${a.corpAdmin.client_id}
        and c.id not in (select client_id from employee_client_access where employee_id = ${tc.id})
      order by e.created_at, e.id limit 1`)
  })

  it('booking for yourself: unchanged, whoever you are', async () => {
    const r = await resolveActor(db, await principal(a.corpAdmin.id))
    expect(r).toEqual({ ok: true, actor: {
      traveller: { id: a.corpAdmin.id, client_id: a.corpAdmin.client_id }, bookerId: a.corpAdmin.id, via: 'self', bookingMode: null,
    } })
    // Naming yourself is the same as naming nobody.
    expect(await resolveActor(db, await principal(a.corpAdmin.id), a.corpAdmin.id)).toEqual(r)
  })

  it('an ordinary employee cannot book for anyone else', async () => {
    expect(await resolveActor(db, await principal(a.employee!.id), a.corpAdmin.id))
      .toEqual({ ok: false, status: 403, error: 'You can only book travel for yourself.' })
  })

  it('a corporate admin books for colleagues, not for other companies, not at a CBT client', async () => {
    const admin = await principal(a.corpAdmin.id)
    const r = await resolveActor(db, admin, colleague.id)
    expect(r.ok && r.actor).toMatchObject({ traveller: colleague, bookerId: a.corpAdmin.id, via: 'corporate_admin' })

    expect(await resolveActor(db, admin, outsider.id)).toEqual(NOT_FOUND)

    await exec(db, sql`update clients set booking_mode = 'cbt' where id = ${colleague.client_id}`)
    try {
      expect(await resolveActor(db, admin, colleague.id)).toEqual({ ok: false, status: 403, error: SELF_BOOKING_OFF })
    } finally {
      await exec(db, sql`update clients set booking_mode = 'sbt' where id = ${colleague.client_id}`)
    }
  })

  it('a TMC admin books anyone at their own TMC, nobody at another', async () => {
    const r = await resolveActor(db, await principal(a.tmcAdmin.id), outsider.id)
    expect(r.ok && r.actor).toMatchObject({ traveller: outsider, via: 'tmc' })
    expect(await resolveActor(db, await principal(a.otherTmcAdmin!.id), outsider.id)).toEqual(NOT_FOUND)
  })

  it('a counsellor needs book_on_behalf, and then only reaches their portfolio', async () => {
    const counsellor = await principal(tc.id)
    const portfolioPerson = await one<{ id: string; client_id: string }>(db, sql`
      select e.id, e.client_id from employees e join employee_client_access x on x.client_id = e.client_id
      join clients c on c.id = e.client_id
      where x.employee_id = ${tc.id} and c.status <> 'inactive' and e.status <> 'deactivated'
      order by e.created_at, e.id limit 1`)

    await exec(db, sql`delete from employee_permissions where employee_id = ${tc.id} and permission_key = 'book_on_behalf'`)
    expect(await resolveActor(db, counsellor, portfolioPerson.id))
      .toEqual({ ok: false, status: 403, error: 'Missing permission: book_on_behalf' })

    await exec(db, sql`insert into employee_permissions (employee_id, permission_key) values (${tc.id}, 'book_on_behalf')`)
    const r = await resolveActor(db, counsellor, portfolioPerson.id)
    expect(r.ok && r.actor).toMatchObject({ traveller: portfolioPerson, bookerId: tc.id, via: 'tmc' })
    expect(await resolveActor(db, counsellor, outsider.id)).toEqual(NOT_FOUND)
  })

  it('nobody books for the deactivated, for TMC staff, or for a malformed id', async () => {
    const admin = await principal(a.tmcAdmin.id)
    await exec(db, sql`update employees set status = 'deactivated' where id = ${outsider.id}`)
    try {
      expect(await resolveActor(db, admin, outsider.id)).toEqual(NOT_FOUND)
    } finally {
      await exec(db, sql`update employees set status = 'active' where id = ${outsider.id}`)
    }
    expect(await resolveActor(db, admin, tc.id)).toEqual(NOT_FOUND)
    expect(await resolveActor(db, admin, 'not-a-uuid')).toEqual(NOT_FOUND)
  })

  it('on an existing booking: the traveller as before; someone allowed acts as the traveller; anyone else as themself', async () => {
    const me = { id: a.corpAdmin.id, client_id: a.corpAdmin.client_id }
    const admin = await principal(a.corpAdmin.id)
    expect(await actingTraveller(db, admin, me, { employee_id: me.id })).toEqual({ traveller: me, onBehalf: false })
    expect(await actingTraveller(db, admin, me, null)).toEqual({ traveller: me, onBehalf: false })
    expect(await actingTraveller(db, admin, me, { employee_id: colleague.id }))
      .toEqual({ traveller: colleague, onBehalf: true })
    // Not theirs to act on: the route's own "not authorized" check then refuses.
    expect(await actingTraveller(db, admin, me, { employee_id: outsider.id })).toEqual({ traveller: me, onBehalf: false })
  })
})
