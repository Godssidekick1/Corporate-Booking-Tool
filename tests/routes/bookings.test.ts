import { describe, it, expect, beforeAll, vi } from 'vitest'
import { GET as bookingsGet } from '@/app/api/bookings/route'
import { GET as recentGet } from '@/app/api/bookings/recent/route'
import { GET as actionableGet } from '@/app/api/bookings/actionable/route'
import { GET as tripsGet, POST as tripsPost } from '@/app/api/trips/route'
import { GET as tripGet, PATCH as tripPatch, DELETE as tripDelete } from '@/app/api/trips/[tripId]/route'
import { GET as publicTicket } from '@/app/api/public/ticket/[token]/route'
import { GET as qrGet } from '@/app/api/book/[bookingId]/qr/route'
import { GET as bookingGet, PATCH as bookingPatch } from '@/app/api/book/[bookingId]/route'
import { POST as policyPreview } from '@/app/api/book/policy-preview/route'
import { call } from '../harness/call'
import { actors, type Actors } from '../harness/actors'
import { resetDatabase } from '../harness/db'
import { db } from '@/app/lib/db'
import { sql, many, one, maybeOne, exec } from '@/app/lib/db/sql'
import type { FlatFlightResult } from '@/app/lib/book/types'

// ── A traveller's bookings and trips ─────────────────────────────────────────
// The lists behind "My trips" and the dashboard, a single booking, the public
// e-ticket and its QR, trips, and the live policy preview.
//
// THE MARKUP RULE runs through all of it: the airline's own figures
// (total_cost, commercials) must never reach a traveller's response. Asserted
// explicitly below, not just left to the snapshots.
//
// Amadeus is faked: PATCH /api/book/[bookingId] re-sends passenger details.
// ─────────────────────────────────────────────────────────────────────────────

const addPassenger = vi.fn(async () => ({}))
vi.mock('@/app/lib/amadeus/client', async orig => {
  const actual = await orig<typeof import('@/app/lib/amadeus/client')>()
  return { ...actual, amadeus: { ...actual.amadeus, addPassenger: (...args: unknown[]) => addPassenger(...(args as [])) } }
})

const HAS_DB = Boolean(process.env.DATABASE_URL)
const d = HAS_DB ? describe : describe.skip

// No airline figure anywhere in a response body, at any depth.
//
// By VALUE, not by key name: two list routes deliberately put the sell figure
// in a field called total_cost. What must never appear is the airline total of
// a booking that carries a MARKUP (displayedFare above the airline total) --
// with both on screen the markup is a subtraction. A discount-only booking is
// different: its displayed fare IS the airline fare, shown beside an explicit
// discount line, and that reveals nothing.
//
// The template has no marked-up booking, so beforeAll makes one.
let airlineTotals: number[] = []
function assertNoAirlineFigures(body: unknown) {
  const text = JSON.stringify(body)
  expect(text).not.toMatch(/"commercials"/)
  for (const total of airlineTotals) {
    expect(text, `airline total ${total} appears in the response`).not.toMatch(new RegExp(`[:\\[,]${total}[,}\\]]`))
  }
}

d('traveller bookings and trips', () => {
  let a: Actors
  let admin: { id: string }                    // BCG's admin, who has ticketed bookings
  let traveller: { id: string }                // a BCG employee with bookings of their own
  let ticketed: { id: string; share_token: string }
  let held: { id: string }

  beforeAll(async () => {
    await resetDatabase()
    a = await actors()
    admin = { id: a.corpAdmin.id }
    traveller = await one(db, sql`
      select e.id from employees e
      where e.client_id = ${a.corpAdmin.client_id} and e.role = 'employee'
        and exists (select 1 from bookings b where b.employee_id = e.id)
      order by e.id limit 1`)
    ticketed = await one(db, sql`
      select id, share_token from bookings
      where employee_id = ${admin.id} and status = 'ticketed' and share_token is not null and commercials is not null
      order by created_at, id limit 1`)
    held = await one(db, sql`
      select id from bookings where employee_id = ${admin.id} and status = 'held' order by created_at, id limit 1`)
    // Mark the ticketed booking up by 777: the traveller now sees a displayed
    // fare and a sell total 777 above what the airline charged, while
    // fare_breakdown.passengerBreakup still holds the airline's own split --
    // exactly the shape add-passenger freezes for a marked-up fare.
    await exec(db, sql`
      update bookings set
        commercials = jsonb_set(commercials, '{displayedFare}',
          to_jsonb((commercials->'airline'->>'total')::numeric + 777)),
        sell_total = sell_total + 777
      where id = ${ticketed.id}`)
    airlineTotals = (await many<{ total: number }>(db, sql`
      select distinct (commercials->'airline'->>'total')::float8 as total from bookings
      where (commercials->>'displayedFare')::numeric > (commercials->'airline'->>'total')::numeric`)).map(r => r.total)
    expect(airlineTotals.length).toBeGreaterThan(0)
  })

  // ── Lists ──────────────────────────────────────────────────────────────────

  it('bookings: 401, and a person with no employee row', async () => {
    expect((await call(bookingsGet, { url: '/api/bookings' })).status).toBe(401)
    expect((await call(bookingsGet, { as: { id: '00000000-0000-0000-0000-00000000abcd' }, url: '/api/bookings' })).status).toBe(404)
  })

  it('bookings: my trips, grouped, sell-side only', async () => {
    const res = await call(bookingsGet, { as: admin, url: '/api/bookings' })
    expect(res.status).toBe(200)
    assertNoAirlineFigures(res.json)
    expect(res.json).toMatchSnapshot()
  })

  it('bookings: the limit is honoured', async () => {
    const res = await call(bookingsGet, { as: admin, url: '/api/bookings?limit=2' })
    const body = res.json as { trips: { bookings: unknown[] }[]; ungroupedBookings: unknown[] }
    const count = body.trips.reduce((n, t) => n + t.bookings.length, 0) + body.ungroupedBookings.length
    expect(count).toBe(2)
  })

  it('recent: an admin sees the client, an employee only themselves', async () => {
    const asAdmin = await call(recentGet, { as: admin, url: '/api/bookings/recent?limit=50' })
    expect(asAdmin.status).toBe(200)
    assertNoAirlineFigures(asAdmin.json)
    expect(asAdmin.json).toMatchSnapshot()

    const asTraveller = await call(recentGet, { as: traveller, url: '/api/bookings/recent?limit=50' })
    const rows = (asTraveller.json as { bookings: { isOwn: boolean }[] }).bookings
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every(r => r.isOwn)).toBe(true)
  })

  it('recent: a manager sees their direct reports too', async () => {
    const manager = await one<{ id: string }>(db, sql`
      select e.id from employees e
      where e.client_id = ${a.corpAdmin.client_id} and exists (select 1 from employees r where r.manager_id = e.id)
        and e.role <> 'admin'
      order by e.id limit 1`)
    await exec(db, sql`update employees set role = 'manager' where id = ${manager.id}`)
    const reports = (await many<{ id: string }>(db, sql`select id from employees where manager_id = ${manager.id}`)).map(r => r.id)
    const res = await call(recentGet, { as: manager, url: '/api/bookings/recent?limit=50' })
    const expected = await one<{ n: number }>(db, sql`
      select count(*)::int as n from bookings where employee_id = any(${[manager.id, ...reports]})`)
    expect((res.json as { bookings: unknown[] }).bookings).toHaveLength(Math.min(expected.n, 50))
  })

  it('actionable: bookings waiting on the traveller', async () => {
    const res = await call(actionableGet, { as: traveller, url: '/api/bookings/actionable' })
    expect(res.status).toBe(200)
    assertNoAirlineFigures(res.json)
    expect(res.json).toMatchSnapshot()
  })

  // ── One booking ────────────────────────────────────────────────────────────

  const at = (id: string, extra = '') => ({ url: `/api/book/${id}${extra}`, params: { bookingId: id } })

  it('booking: someone else\'s is refused', async () => {
    expect(await call(bookingGet, { as: traveller, ...at(ticketed.id) }))
      .toEqual({ status: 403, json: { error: 'Not authorized to view this booking' } })
    expect((await call(bookingGet, { as: admin, ...at('00000000-0000-0000-0000-000000000000') })).status).toBe(404)
  })

  it('booking: the sell-side view, with no airline figure in it', async () => {
    const res = await call(bookingGet, { as: admin, ...at(ticketed.id) })
    expect(res.status).toBe(200)
    assertNoAirlineFigures(res.json)
    expect(res.json).toMatchSnapshot()
  })

  it('booking: no marked-up booking reveals its airline figure to its traveller', async () => {
    const markedUp = await many<{ id: string; employee_id: string }>(db, sql`
      select id, employee_id from bookings
      where (commercials->>'displayedFare')::numeric > (commercials->'airline'->>'total')::numeric
      order by id`)
    expect(markedUp.length).toBeGreaterThan(0)
    for (const b of markedUp) {
      const res = await call(bookingGet, { as: { id: b.employee_id }, ...at(b.id) })
      expect(res.status).toBe(200)
      assertNoAirlineFigures(res.json)
    }
  })

  it('booking PATCH: only before the airline booking, with passengers', async () => {
    const patch = (id: string, body: unknown) => call(bookingPatch, { as: admin, method: 'PATCH', ...at(id), body })
    expect((await patch(ticketed.id, { customerInfo: { PassengerDetails: [{}] } })).status).toBe(409)

    await exec(db, sql`update bookings set status = 'approved' where id = ${held.id}`)
    expect(await patch(held.id, { customerInfo: { PassengerDetails: [] } })).toEqual({
      status: 400, json: { error: 'customerInfo.PassengerDetails must include at least one passenger' },
    })

    const corrected = { Email: 'fixed@example.test', PassengerDetails: [{ FirstName: 'Fixed', LastName: 'Name' }] }
    addPassenger.mockClear()
    expect(await patch(held.id, { customerInfo: corrected })).toEqual({ status: 200, json: { ok: true } })
    expect(addPassenger).toHaveBeenCalledTimes(1)
    expect((await one<{ traveler_snapshot: unknown }>(db, sql`
      select traveler_snapshot from bookings where id = ${held.id}`)).traveler_snapshot).toEqual(corrected)
  })

  // ── Public ticket and QR ───────────────────────────────────────────────────

  it('public ticket: malformed and unknown tokens look the same', async () => {
    const get = (token: string) => call(publicTicket, { url: `/api/public/ticket/${token}`, params: { token } })
    expect(await get('nope')).toEqual({ status: 404, json: { error: 'Ticket not found' } })
    expect(await get('0'.repeat(32))).toEqual({ status: 404, json: { error: 'Ticket not found' } })
  })

  it('public ticket: the receipt, passport masked, no airline figures', async () => {
    const res = await call(publicTicket, { url: `/api/public/ticket/${ticketed.share_token}`, params: { token: ticketed.share_token } })
    expect(res.status).toBe(200)
    assertNoAirlineFigures(res.json)
    expect(JSON.stringify(res.json)).not.toMatch(/dateOfBirth|DateOfBirth/)
    expect(res.json).toMatchSnapshot()
  })

  it('public ticket: a booking that is no longer ticketed shows nothing', async () => {
    const other = await one<{ id: string; share_token: string }>(db, sql`
      select id, share_token from bookings where share_token is not null and id <> ${ticketed.id} order by id limit 1`)
    await exec(db, sql`update bookings set status = 'cancelled' where id = ${other.id}`)
    expect((await call(publicTicket, { url: `/api/public/ticket/${other.share_token}`, params: { token: other.share_token } })).status).toBe(404)
  })

  it('qr: owner only; nothing before ticketing; the public URL once ticketed', async () => {
    expect((await call(qrGet, { as: traveller, ...at(ticketed.id, '/qr') })).status).toBe(403)
    expect(await call(qrGet, { as: admin, ...at(held.id, '/qr') })).toEqual({ status: 200, json: { ok: true, qr: null, url: null } })
    const res = await call(qrGet, { as: admin, ...at(ticketed.id, '/qr') })
    const body = res.json as { qr: string; url: string }
    expect(body.url).toMatch(new RegExp(`/t/${ticketed.share_token}$`))
    expect(body.qr).toMatch(/^data:image\/png;base64,/)
  })

  // ── Trips ──────────────────────────────────────────────────────────────────

  it('trips: mine, deleted hidden', async () => {
    const res = await call(tripsGet, { as: admin, url: '/api/trips' })
    expect(res.status).toBe(200)
    expect(res.json).toMatchSnapshot()
  })

  it('trips POST: a name is required; creates an open trip', async () => {
    expect(await call(tripsPost, { as: admin, method: 'POST', url: '/api/trips', body: { name: ' ' } }))
      .toEqual({ status: 400, json: { error: 'Trip name is required' } })
    const res = await call(tripsPost, { as: admin, method: 'POST', url: '/api/trips', body: { name: ' Offsite ' } })
    expect(res.status).toBe(200)
    const trip = (res.json as { trip: { id: string; name: string; status: string } }).trip
    expect(trip).toMatchObject({ name: 'Offsite', status: 'open' })
    expect(await maybeOne(db, sql`select created_by, client_id from trips where id = ${trip.id}`))
      .toEqual({ created_by: admin.id, client_id: a.corpAdmin.client_id })
  })

  const tripAt = (id: string) => ({ url: `/api/trips/${id}`, params: { tripId: id } })

  it('trip: owner only; the workspace with its bookings, sell-side', async () => {
    const trip = await one<{ id: string }>(db, sql`
      select t.id from trips t where t.created_by = ${admin.id} and t.status <> 'deleted'
        and exists (select 1 from bookings b where b.trip_id = t.id)
      order by t.created_at, t.id limit 1`)
    expect(await call(tripGet, { as: traveller, ...tripAt(trip.id) }))
      .toEqual({ status: 403, json: { error: 'Not authorized to view this trip' } })
    const res = await call(tripGet, { as: admin, ...tripAt(trip.id) })
    expect(res.status).toBe(200)
    assertNoAirlineFigures(res.json)
    expect(res.json).toMatchSnapshot()
  })

  it('trip PATCH and DELETE', async () => {
    const trip = await one<{ id: string }>(db, sql`
      select id from trips where created_by = ${admin.id} and status = 'open' order by created_at, id limit 1`)
    expect(await call(tripPatch, { as: admin, method: 'PATCH', ...tripAt(trip.id), body: { status: 'open' } }))
      .toEqual({ status: 400, json: { error: 'status must be one of: completed' } })
    expect(await call(tripPatch, { as: traveller, method: 'PATCH', ...tripAt(trip.id), body: { status: 'completed' } }))
      .toEqual({ status: 403, json: { error: 'Not authorized to edit this trip' } })
    expect(await call(tripPatch, { as: admin, method: 'PATCH', ...tripAt(trip.id), body: { status: 'completed' } }))
      .toEqual({ status: 200, json: { ok: true, trip: { id: trip.id, status: 'completed' } } })

    expect(await call(tripDelete, { as: admin, method: 'DELETE', ...tripAt(trip.id) }))
      .toEqual({ status: 200, json: { ok: true, trip: { id: trip.id, status: 'deleted' } } })
    expect(await call(tripDelete, { as: admin, method: 'DELETE', ...tripAt(trip.id) }))
      .toEqual({ status: 200, json: { ok: true, trip: { id: trip.id, status: 'deleted' } } })
    expect(await call(tripPatch, { as: admin, method: 'PATCH', ...tripAt(trip.id), body: { status: 'completed' } }))
      .toEqual({ status: 409, json: { error: "This trip is deleted and can't be marked complete." } })
    expect((await call(tripGet, { as: admin, ...tripAt('00000000-0000-0000-0000-000000000000') })).status).toBe(404)
  })

  // ── Policy preview ─────────────────────────────────────────────────────────

  it('policy preview: validation, and a verdict for a covered traveller', async () => {
    const preview = (body: unknown) => call(policyPreview, { as: traveller, method: 'POST', url: '/api/book/policy-preview', body })
    expect(await preview({})).toEqual({ status: 400, json: { error: 'flight and totalFare are required' } })

    const leg = { airlineCode: 'AI', flightNumber: '101', bookingCode: 'Y', cabin: 'Economy' }
    const origin = { code: 'DEL', name: 'Delhi', city: 'Delhi', dateTime: '2030-01-10T08:00:00' }
    const destination = { code: 'BOM', name: 'Mumbai', city: 'Mumbai', dateTime: '2030-01-10T10:10:00' }
    const flight = {
      flightKey: 'k', provider: 'test', isLcc: false, itemNo: '1', cabin: 'Economy', legs: [leg],
      journeys: [{ journeyNo: 1, origin, destination, stops: [], stopCount: 0, legs: [leg] }],
      origin, destination, airline: { code: 'AI', name: 'AI' }, stopCount: 0, stops: [], fareOptions: [],
    } as unknown as FlatFlightResult
    const res = await preview({ flight, totalFare: 6000, isRefundable: true })
    expect(res.status).toBe(200)
    expect(res.json).toMatchSnapshot()
  })
})
