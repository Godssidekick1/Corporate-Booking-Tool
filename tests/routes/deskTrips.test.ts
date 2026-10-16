import { describe, it, expect, beforeAll } from 'vitest'
import { POST as tripsPost } from '@/app/api/trips/route'
import { GET as tripGet } from '@/app/api/trips/[tripId]/route'
import { POST as submitPost } from '@/app/api/trips/[tripId]/submit/route'
import { GET as deskTripsGet } from '@/app/api/tmc/trips/route'
import { POST as chainPost } from '@/app/api/tmc/approval-chains/direct/route'
import { call } from '../harness/call'
import { actors, type Actors, type Actor } from '../harness/actors'
import { resetDatabase } from '../harness/db'
import { db } from '@/app/lib/db'
import { sql, one, exec } from '@/app/lib/db/sql'

// ── The travel desk plans trips ──────────────────────────────────────────────
// A counsellor with "Book for travellers" sets up a trip for a traveller in
// their portfolio -- the traveller's trip, arranged by the counsellor -- sees
// it among the desk's trips, and submits it for the company's sign-off on the
// traveller's behalf. Outside the portfolio, or without the permission:
// nothing.
// ─────────────────────────────────────────────────────────────────────────────

const HAS_DB = Boolean(process.env.DATABASE_URL)
const d = HAS_DB ? describe : describe.skip

d('desk trips', () => {
  let a: Actors
  let tc: Actor
  let traveller: { id: string; client_id: string }
  let outsider: { id: string }
  let approver: { id: string }

  beforeAll(async () => {
    await resetDatabase()
    a = await actors()
    if (!a.tc) throw new Error('[tests] template lacks a TC')
    tc = a.tc
    await exec(db, sql`
      insert into employee_permissions (employee_id, permission_key) values (${tc.id}, 'book_on_behalf')
      on conflict do nothing`)
    traveller = await one(db, sql`
      select e.id, e.client_id from employees e join employee_client_access x on x.client_id = e.client_id
      join clients c on c.id = e.client_id
      where x.employee_id = ${tc.id} and c.status <> 'inactive' and e.status = 'active' and e.role = 'employee'
      order by e.created_at, e.id limit 1`)
    outsider = await one(db, sql`
      select e.id from employees e join clients c on c.id = e.client_id
      where c.tmc_id = ${tc.tmc_id} and c.status <> 'inactive' and e.status = 'active'
        and c.id not in (select client_id from employee_client_access where employee_id = ${tc.id})
      order by e.created_at, e.id limit 1`)
    approver = await one(db, sql`
      select id from employees where client_id = ${traveller.client_id} and id <> ${traveller.id} and status = 'active'
      order by created_at, id limit 1`)
  })

  const idOf = (r: { json: unknown }) => (r.json as { trip: { id: string } }).trip.id
  const desk = (as: { id: string }, qs: string) => call(deskTripsGet, { as, url: `/api/tmc/trips?page=1${qs}` })
  const tripIds = (r: { json: unknown }) => ((r.json as { trips: { trip: { id: string } }[] }).trips ?? []).map(g => g.trip.id)

  let tripId: string

  it('a counsellor sets up a trip for a portfolio traveller: theirs, arranged by the counsellor', async () => {
    const res = await call(tripsPost, {
      as: tc, method: 'POST', url: '/api/trips',
      body: { name: 'Desk-planned visit', travellerId: traveller.id, travelType: 'domestic', billable: true, budgetAmount: 30000 },
    })
    expect(res.status).toBe(200)
    tripId = idOf(res)
    expect(await one(db, sql`select created_by, arranged_by, billable from trips where id = ${tripId}`))
      .toEqual({ created_by: traveller.id, arranged_by: tc.id, billable: true })
    // Opened from the desk: it is not the counsellor's own.
    expect(await call(tripGet, { as: tc, url: `/api/trips/${tripId}`, params: { tripId } }))
      .toMatchObject({ status: 200, json: { mine: false, traveller: { id: traveller.id } } })
  })

  it("the desk's trips: the counsellor's own, and everything the desk keeps within their reach", async () => {
    const mine = await desk(tc, '&scope=mine')
    expect(mine.status).toBe(200)
    expect(tripIds(mine)).toContain(tripId)
    const first = (mine.json as { trips: { trip: { client_name: string | null; traveller_name: string | null } }[] }).trips[0]
    expect(first.trip.client_name).toBeTruthy()
    expect(tripIds(await desk(tc, '&scope=desk'))).toContain(tripId)
    expect(tripIds(await desk(tc, `&scope=desk&clientId=${traveller.client_id}`))).toContain(tripId)
    // The TMC's admin sees every client's.
    expect(tripIds(await desk(a.tmcAdmin, '&scope=desk'))).toContain(tripId)
    // A traveller is not the desk.
    expect((await desk({ id: traveller.id }, '&scope=desk')).status).toBe(403)
  })

  it('outside the portfolio, or without the permission: refused', async () => {
    expect((await call(tripsPost, {
      as: tc, method: 'POST', url: '/api/trips', body: { name: 'Nope', travellerId: outsider.id },
    })).status).toBe(404)
    await exec(db, sql`delete from employee_permissions where employee_id = ${tc.id} and permission_key = 'book_on_behalf'`)
    try {
      expect(await desk(tc, '&scope=mine')).toEqual({ status: 403, json: { error: 'Missing permission: book_on_behalf' } })
      expect((await call(tripGet, { as: tc, url: `/api/trips/${tripId}`, params: { tripId } })).status).toBe(403)
    } finally {
      await exec(db, sql`insert into employee_permissions (employee_id, permission_key) values (${tc.id}, 'book_on_behalf')`)
    }
  })

  it("the desk submits the trip for the company's sign-off; the company's approver decides", async () => {
    await exec(db, sql`update clients set trip_approval_mode = 'on_submit' where id = ${traveller.client_id}`)
    const chain = await call(chainPost, {
      as: a.tmcAdmin, method: 'POST', url: '/api/tmc/approval-chains/direct',
      body: { clientId: traveller.client_id, employeeId: traveller.id, category: 'trip', mode: 'sequential', quorum: 'all',
        approvers: [{ approver_type: 'specific_user', approver_user_id: approver.id, min_verdict: 'green' }] },
    })
    expect(chain.status).toBe(200)
    // One booked flight in it (a copy of one of the company's bookings).
    await exec(db, sql`
      insert into bookings
      select (jsonb_populate_record(null::bookings, to_jsonb(b) || jsonb_build_object(
        'id', gen_random_uuid(), 'trip_id', ${tripId}::uuid, 'employee_id', ${traveller.id}::uuid,
        'booked_by', ${tc.id}::uuid, 'status', 'ticketed', 'share_token', null, 'pnr', null,
        'provider_order_id', null, 'amadeus_key', null))).*
      from (select * from bookings where client_id = ${traveller.client_id} order by created_at, id limit 1) b`)
    const res = await call(submitPost, { as: tc, method: 'POST', url: `/api/trips/${tripId}/submit`, params: { tripId }, body: {} })
    expect(res).toEqual({ status: 200, json: { ok: true, approvalStatus: 'pending', tier: 1 } })
    expect(await one(db, sql`select approver_id from approvals where trip_id = ${tripId} and status = 'pending'`))
      .toEqual({ approver_id: approver.id })
  })
})
