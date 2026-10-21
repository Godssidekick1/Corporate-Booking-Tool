import { describe, it, expect, beforeAll } from 'vitest'
import { POST as chainPost } from '@/app/api/tmc/approval-chains/direct/route'
import { POST as submitPost } from '@/app/api/trips/[tripId]/submit/route'
import { GET as approvalsGet } from '@/app/api/approvals/route'
import { PATCH as decide } from '@/app/api/approvals/[approvalId]/route'
import { POST as refreshFare } from '@/app/api/approvals/[approvalId]/refresh-fare/route'
import { call } from '../harness/call'
import { actors, type Actors } from '../harness/actors'
import { resetDatabase } from '../harness/db'
import { db } from '@/app/lib/db'
import { sql, many, one, maybeOne, exec } from '@/app/lib/db/sql'

// ── Trip sign-off ────────────────────────────────────────────────────────────
// Not air approval: each flight was approved, if it needed to be, when it was
// booked. A company that signs trips off has the finished trip approved as a
// whole, once, by the chain assigned for category 'trip'.
// ─────────────────────────────────────────────────────────────────────────────

const HAS_DB = Boolean(process.env.DATABASE_URL)
const d = HAS_DB ? describe : describe.skip

d('trip sign-off', () => {
  let a: Actors
  let clientId: string
  let traveller: { id: string }   // whose trip it is
  let approver: { id: string }    // the company admin, named on the trip chain
  let colleague: { id: string }   // someone else at the company

  beforeAll(async () => {
    await resetDatabase()
    a = await actors()
    clientId = a.corpAdmin.client_id!
    approver = { id: a.corpAdmin.id }
    const others = await many<{ id: string }>(db, sql`
      select id from employees where client_id = ${clientId} and id <> ${approver.id}
        and role = 'employee' and status = 'active' order by id limit 2`)
    ;[traveller, colleague] = others
    await exec(db, sql`update clients set trip_approval_mode = 'on_submit' where id = ${clientId}`)
    // The traveller's trip chain: one step, the admin, every verdict.
    const chain = await call(chainPost, {
      as: a.tmcAdmin, method: 'POST', url: '/api/tmc/approval-chains/direct',
      body: { clientId, employeeId: traveller.id, category: 'trip', mode: 'sequential', quorum: 'all',
        approvers: [{ approver_type: 'specific_user', approver_user_id: approver.id, min_verdict: 'green' }] },
    })
    expect(chain.status).toBe(200)
  })

  // A copy of one of the company's bookings, for this traveller, in this trip
  // and state: a fresh id, and nothing that must be unique carried over.
  const addBooking = (tripId: string, employeeId: string, status: string, verdict = 'amber') => exec(db, sql`
    insert into bookings
    select (jsonb_populate_record(null::bookings, to_jsonb(b) || jsonb_build_object(
      'id', gen_random_uuid(), 'trip_id', ${tripId}::uuid, 'employee_id', ${employeeId}::uuid,
      'booked_by', ${employeeId}::uuid, 'status', ${status}::text, 'policy_verdict', ${verdict}::text,
      'share_token', null, 'pnr', null, 'provider_order_id', null, 'amadeus_key', null))).*
    from (select * from bookings where client_id = ${clientId} order by created_at, id limit 1) b`)

  // A trip of the traveller's holding bookings in the given states.
  async function tripWith(...statuses: string[]): Promise<string> {
    const trip = await one<{ id: string }>(db, sql`
      insert into trips (client_id, created_by, name, status, currency, budget_amount)
      values (${clientId}, ${traveller.id}, 'Signed-off trip', 'open', 'INR', 50000) returning id`)
    for (const status of statuses) await addBooking(trip.id, traveller.id, status)
    return trip.id
  }
  const submit = (as: { id: string }, tripId: string) =>
    call(submitPost, { as, method: 'POST', url: `/api/trips/${tripId}/submit`, params: { tripId }, body: {} })
  const stepFor = (tripId: string) => maybeOne<{ id: string; approver_id: string; status: string; booking_id: string | null; verdict: string }>(db, sql`
    select id, approver_id, status, booking_id, verdict from approvals where trip_id = ${tripId} and status = 'pending'`)
  const tripStatus = async (tripId: string) =>
    (await one<{ approval_status: string }>(db, sql`select approval_status from trips where id = ${tripId}`)).approval_status
  const decideAs = (as: { id: string }, approvalId: string, body: unknown) =>
    call(decide, { as, method: 'PATCH', url: `/api/approvals/${approvalId}`, params: { approvalId }, body })

  it('refused until every booking in it is booked, and never empty', async () => {
    const empty = await tripWith()
    expect(await submit(traveller, empty))
      .toEqual({ status: 409, json: { error: 'Add at least one booking before submitting the trip.' } })
    const unfinished = await tripWith('ticketed', 'pending_approval')
    expect(await submit(traveller, unfinished))
      .toEqual({ status: 409, json: { error: '1 booking is not booked yet -- finish it first.' } })
    expect(await tripStatus(unfinished)).toBe('none')
  })

  it('submitted: one step for the whole trip, routed on its worst verdict; edits stop', async () => {
    const tripId = await tripWith('ticketed', 'held')
    expect(await submit(traveller, tripId)).toEqual({ status: 200, json: { ok: true, approvalStatus: 'pending', tier: 1 } })
    const step = await stepFor(tripId)
    expect(step).toMatchObject({ approver_id: approver.id, booking_id: null, verdict: 'amber' })
    expect(await tripStatus(tripId)).toBe('pending')
    expect(await submit(traveller, tripId)).toEqual({ status: 409, json: { error: 'This trip is already awaiting sign-off.' } })

    // The approver sees it, as a trip, with its bookings, sell-side.
    const queue = (await call(approvalsGet, { as: approver, url: '/api/approvals' })).json as {
      pending: { approvalId: string; kind: string; tripId: string; trip: { name: string; bookings: unknown[]; budget_amount: number } | null }[]
    }
    const item = queue.pending.find(p => p.approvalId === step!.id)!
    expect(item).toMatchObject({ kind: 'trip', tripId, trip: { name: 'Signed-off trip', budget_amount: 50000 } })
    expect(item.trip!.bookings).toHaveLength(2)
    expect(JSON.stringify(item)).not.toMatch(/"commercials"|passengerBreakup/)

    // Nobody else decides it; a trip step has no fare to refresh.
    expect((await decideAs(colleague, step!.id, { decision: 'approve' })).status).toBe(403)
    expect((await call(refreshFare, {
      as: approver, method: 'POST', url: `/api/approvals/${step!.id}/refresh-fare`, params: { approvalId: step!.id }, body: {},
    })).status).toBe(409)

    expect(await decideAs(approver, step!.id, { decision: 'approve', note: 'fine' }))
      .toEqual({ status: 200, json: { ok: true, tripApprovalStatus: 'approved' } })
    expect(await tripStatus(tripId)).toBe('approved')
    expect(await submit(traveller, tripId)).toEqual({ status: 409, json: { error: 'This trip is already signed off.' } })
    // Its bookings are untouched by the sign-off.
    expect((await many<{ status: string }>(db, sql`select status from bookings where trip_id = ${tripId} order by status`))
      .map(b => b.status)).toEqual(['held', 'ticketed'])
  })

  it('rejected: back to the traveller, who can submit again; the first decision stays on record', async () => {
    const tripId = await tripWith('ticketed')
    await submit(traveller, tripId)
    const first = await stepFor(tripId)
    expect(await decideAs(approver, first!.id, { decision: 'reject', note: 'over budget' }))
      .toEqual({ status: 200, json: { ok: true, tripApprovalStatus: 'rejected' } })
    expect(await tripStatus(tripId)).toBe('rejected')
    expect((await submit(traveller, tripId)).status).toBe(200)
    const rows = await many<{ status: string }>(db, sql`select status from approvals where trip_id = ${tripId} order by created_at`)
    expect(rows.map(r => r.status)).toEqual(['rejected', 'pending'])
  })

  it('whoever books for the traveller submits for them; a plain colleague may not', async () => {
    const tripId = await tripWith('ticketed')
    expect(await submit(colleague, tripId)).toEqual({ status: 403, json: { error: 'Not authorized to submit this trip' } })
    expect((await submit(approver, tripId)).status).toBe(200)
  })

  it('a submitted trip always reaches a person, even all within policy with an out-of-policy-only chain', async () => {
    const chainFor = (minVerdict: string) => call(chainPost, {
      as: a.tmcAdmin, method: 'POST', url: '/api/tmc/approval-chains/direct',
      body: { clientId, employeeId: traveller.id, category: 'trip', mode: 'sequential', quorum: 'all',
        approvers: [{ approver_type: 'specific_user', approver_user_id: approver.id, min_verdict: minVerdict }] },
    })
    expect((await chainFor('red')).status).toBe(200)
    try {
      const trip = await one<{ id: string }>(db, sql`
        insert into trips (client_id, created_by, name, status) values (${clientId}, ${traveller.id}, 'All green', 'open')
        returning id`)
      await addBooking(trip.id, traveller.id, 'ticketed', 'green')
      expect(await submit(traveller, trip.id)).toEqual({ status: 200, json: { ok: true, approvalStatus: 'pending', tier: 1 } })
      expect(await stepFor(trip.id)).toMatchObject({ approver_id: approver.id, verdict: 'green' })
    } finally {
      await chainFor('green')
    }
  })

  it('no trip chain for someone: signed off at once, as a booking with no chain is approved', async () => {
    const trip = await one<{ id: string }>(db, sql`
      insert into trips (client_id, created_by, name, status) values (${clientId}, ${colleague.id}, 'No chain', 'open')
      returning id`)
    await addBooking(trip.id, colleague.id, 'ticketed')
    // A default trip chain would apply here; make sure there is none.
    await exec(db, sql`delete from client_default_approval_templates where client_id = ${clientId} and category = 'trip'`)
    expect(await submit(colleague, trip.id)).toEqual({ status: 200, json: { ok: true, approvalStatus: 'approved' } })
  })

  it('a company that does not sign trips off: nothing to submit', async () => {
    const tripId = await tripWith('ticketed')
    await exec(db, sql`update clients set trip_approval_mode = 'not_required' where id = ${clientId}`)
    try {
      expect(await submit(traveller, tripId)).toEqual({ status: 409, json: { error: 'This company does not sign trips off.' } })
    } finally {
      await exec(db, sql`update clients set trip_approval_mode = 'on_submit' where id = ${clientId}`)
    }
  })
})
