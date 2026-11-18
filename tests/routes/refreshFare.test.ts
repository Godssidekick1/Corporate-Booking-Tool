import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { POST as chainPost } from '@/app/api/tmc/approval-chains/direct/route'
import { GET as rulesGet, POST as rulesPost } from '@/app/api/tmc/policy-rules/route'
import { POST as pricePost } from '@/app/api/book/price/route'
import { POST as addPassenger } from '@/app/api/book/add-passenger/route'
import { POST as refreshFare } from '@/app/api/approvals/[approvalId]/refresh-fare/route'
import { PATCH as decide } from '@/app/api/approvals/[approvalId]/route'
import { readFileSync } from 'node:fs'
import pg from 'pg'
import { testOwnerUrl } from '../harness/testDatabase'
import { GET as approvalsGet } from '@/app/api/approvals/route'
import * as bookingsRepo from '@/app/lib/repositories/bookings'
import { AmadeusError } from '@/app/lib/amadeus/client'
import { call } from '../harness/call'
import { actors, type Actors } from '../harness/actors'
import { resetDatabase } from '../harness/db'
import { db } from '@/app/lib/db'
import { sql, many, one, exec } from '@/app/lib/db/sql'

// ── Refresh fare after a long wait ───────────────────────────────────────────
// An approval waits hours; a search's keys live ~25 minutes. Refresh re-finds
// the fare in a fresh search when the stored keys are stale
// (app/lib/book/refindFare.ts). Whatever the new price or verdict, the
// approver decides on it (user, 2026-11-18): they see how much it moved since
// approval was asked for (bookings.requested_total) and the new verdict.
//
// The traveller is an L1 colleague in policy group d, whose domestic cap is
// set to ₹12,000: a ₹10,800 fare is within policy, ₹20,000 is far beyond it.
// Amadeus is faked.
// ─────────────────────────────────────────────────────────────────────────────

const fake = { searchFlights: vi.fn(), pricing: vi.fn(), addPassenger: vi.fn() }

vi.mock('@/app/lib/amadeus/client', async orig => {
  const actual = await orig<typeof import('@/app/lib/amadeus/client')>()
  return {
    ...actual,
    amadeus: {
      ...actual.amadeus,
      searchFlights: (...a: unknown[]) => fake.searchFlights(...a),
      pricing: (...a: unknown[]) => fake.pricing(...a),
      addPassenger: (...a: unknown[]) => fake.addPassenger(...a),
    },
  }
})

const HAS_DB = Boolean(process.env.DATABASE_URL)
const d = HAS_DB ? describe : describe.skip

function pricing(key: string, total: number) {
  return {
    Key: key, ReferenceNo: `REF-${key}`,
    AirPricingResponse: [{ PricingInfos: { PricingInfo: [{
      Total: { Fare: String(total), BaseFare: String(total - 800), OtherTax: '500', FuelSurcharge: '300' },
      Currency: 'INR', FareType: 'Retail', Meal: 'NO',
      FareBreakDowns: { FareBreakDown: [{
        PaxType: 'ADT', BaseFare: String(total - 800), TotalTax: '800', TotalFare: String(total), Refundable: 'Refundable',
        Taxes: { Tax: [{ TaxCode: 'K3', Amount: '500' }, { TaxCode: 'YQ', Amount: '300' }] },
      }] },
      FareInfos: { FareInfo: [{ PaxFareBasis: 'Y1' }] },
      Penalties: { ChangePenalty: [], CancelPenalty: [] },
    }] } }],
  }
}

const LEG = { airlineCode: 'AI', flightNumber: '101', bookingCode: 'Y', cabin: 'Economy' }
const ITINERARY = {
  flightKey: 'k', provider: 'test', isLcc: false, itemNo: '1', cabin: 'Economy', legs: [LEG],
  journeys: [{ journeyNo: 1, stops: [], stopCount: 0, legs: [LEG],
    origin: { code: 'DEL', name: 'Delhi', city: 'Delhi', dateTime: '2030-11-10T08:00:00' },
    destination: { code: 'BOM', name: 'Mumbai', city: 'Mumbai', dateTime: '2030-11-10T10:10:00' } }],
  origin: { code: 'DEL', name: 'Delhi', city: 'Delhi', dateTime: '2030-11-10T08:00:00' },
  destination: { code: 'BOM', name: 'Mumbai', city: 'Mumbai', dateTime: '2030-11-10T10:10:00' },
  airline: { code: 'AI', name: 'Air India' }, stopCount: 0, stops: [], fareOptions: [],
}

// A fresh search's answer: the booked flight (AI 101), or another one. As the
// airline sends it, `Flight` is the journey index ("1") and the flight number
// is AirLine.Identification.
function searchResult(identification: string, bookingClass = 'Y') {
  const place = (code: string, at: string) => ({ AirportCode: code, AirportName: code, CityName: code, DateTime: at })
  return {
    Key: 'FRESH-SEARCH',
    Availibilities: [{ Availibility: [{
      IsLCC: 'false', Provider: 'test', FlightKey: 'ai', ItemNo: '7',
      TotalDuration: [{ flight: '1', text: '02:10' }],
      Itineraries: { Itinerary: [{
        Origin: place('DEL', '2030-11-10T08:00:00'), Destination: place('BOM', '2030-11-10T10:10:00'),
        AirLine: { Code: 'AI', Name: 'AI', Identification: identification },
        Leg: '1', Flight: '1', StopCount: '0-Stop', Duration: '02:10', Cabin: 'Y', BookingCode: bookingClass, Key: 'seg',
      }] },
      PricingInfos: { PricingInfo: [{
        Currency: 'INR', Pricingkey: 'PK-FRESH', Meal: 'NO', FareType: 'NRM',
        FareInfos: { FareInfo: [{ Cabin: 'Y', BookingCode: bookingClass, PaxType: 'ADT', PaxFareBasis: `${bookingClass}9`, PaxBookingClass: bookingClass }] },
      }] },
    }] }],
  }
}

const stale = () => new AmadeusError('Invalid session key', 'ERR', 'Session')

d('refresh fare after a long wait', () => {
  let a: Actors
  let colleague: { id: string }
  let approver: { id: string }

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-19T12:00:00Z'))
    await resetDatabase()
    a = await actors()
    approver = { id: a.corpAdmin.id }
    const groupD = (await one<{ id: string }>(db, sql`
      select id from policy_groups where tmc_id = ${a.tmcAdmin.tmc_id} and name = 'd'`)).id
    colleague = await one<{ id: string }>(db, sql`
      select id from employees where client_id = ${a.corpAdmin.client_id} and band_code = 'L1' and id <> ${a.corpAdmin.id}
        and status = 'active' order by id limit 1`)

    // Group d's domestic cap at ₹12,000, no grace; every other rule as it is.
    const current = await call(rulesGet, { as: a.tmcAdmin, url: `/api/tmc/policy-rules?groupId=${groupD}` })
    const rows = (current.json as { rows: { travel_type: string; limit_key: string; limit_value: number | null; limit_bool: boolean | null; limit_list: string[] | null }[] }).rows
      .filter(r => r.limit_key !== 'max_fare_domestic' && r.limit_key !== 'fare_grace' && r.limit_key !== 'fare_grace_unit')
      .map(({ travel_type, limit_key, limit_value, limit_bool, limit_list }) =>
        limit_list !== null ? { travel_type, limit_key, limit_list } : { travel_type, limit_key, limit_value, limit_bool })
    expect((await call(rulesPost, { as: a.tmcAdmin, method: 'POST', url: '/api/tmc/policy-rules',
      body: { policyGroupId: groupD, rules: [...rows, { travel_type: 'flight', limit_key: 'max_fare_domestic', limit_value: 12000 }] } })).status).toBe(200)

    // Every booking goes to the corporate admin for approval, within policy too.
    await exec(db, sql`update clients set within_policy_approval = 'required' where id = ${a.corpAdmin.client_id}`)
    expect((await call(chainPost, { as: a.tmcAdmin, method: 'POST', url: '/api/tmc/approval-chains/direct',
      body: { clientId: a.corpAdmin.client_id, employeeId: colleague.id, category: 'air', mode: 'sequential', quorum: 'all',
        approvers: [{ approver_type: 'specific_user', approver_user_id: approver.id, min_verdict: 'green' }] } })).status).toBe(200)
  })
  afterAll(() => { vi.useRealTimers() })
  beforeEach(() => { for (const f of Object.values(fake)) f.mockReset() })

  async function book(key: string, searchKey = 'SK'): Promise<string> {
    fake.pricing.mockResolvedValueOnce(pricing(key, 10800))
    expect((await call(pricePost, {
      as: colleague, method: 'POST', url: '/api/book/price',
      body: { key: searchKey, pricingKey: 'PK', provider: 'test', resultIndex: '1', itinerary: ITINERARY },
    })).status).toBe(200)
    fake.addPassenger.mockResolvedValueOnce({ ReferenceNo: `REF-${key}` })
    const res = await call(addPassenger, {
      as: colleague, method: 'POST', url: '/api/book/add-passenger',
      body: {
        key, pricingKey: 'PK', provider: 'test', resultIndex: '1', referenceNo: `REF-${key}`, totalFare: 10800,
        currency: 'INR', isRefundable: true, fareType: 'Retail', passengerBreakup: [], searchKey, itinerary: ITINERARY,
        customerInfo: { Email: 't@example.test', Mobile: '9999999999', PassengerDetails: [{ FirstName: 'T', LastName: 'Raveller' }] },
        confirmDuplicate: true,
      },
    })
    expect(res).toMatchObject({ status: 200, json: { status: 'pending_approval' } })
    return (res.json as { bookingId: string }).bookingId
  }

  const pendingFor = (bookingId: string) => one<{ id: string }>(db, sql`
    select id from approvals where booking_id = ${bookingId} and status = 'pending'`)
  const refresh = (approvalId: string, as: { id: string } = approver) => call(refreshFare, {
    as, method: 'POST', url: `/api/approvals/${approvalId}/refresh-fare`, params: { approvalId }, body: {},
  })
  const bookingRow = (id: string) => one<{ status: string; total_cost: number; sell_total: number; search_key: string; pricing_key: string; result_index: string }>(db, sql`
    select status, total_cost, sell_total, search_key, pricing_key, result_index from bookings where id = ${id}`)

  type Refreshed = { outcome: string; change: string; previousTotal: number; newTotal: number; requestedTotal: number;
    sinceRequest: { amount: number; percent: number }; policyVerdict: string; message: string }

  it('a rise that leaves the fare out of policy stays with the approver: the new price, how much it rose, the new verdict', async () => {
    const id = await book('UP')
    const step = await pendingFor(id)
    const asked = (await bookingRow(id)).sell_total
    fake.pricing.mockResolvedValueOnce(pricing('UP-NEW', 20000))

    const res = await refresh(step.id)
    expect(res.status).toBe(200)
    const body = res.json as Refreshed
    expect(body).toMatchObject({ outcome: 'continue', change: 'up', previousTotal: asked, requestedTotal: asked, policyVerdict: 'red' })
    expect(body.sinceRequest.amount).toBeCloseTo(body.newTotal - asked, 2)
    expect(body.sinceRequest.percent).toBeGreaterThan(0)
    expect(body.message).toMatch(/^The fare is now ₹[\d,]+, up ₹[\d,]+ \([\d.]+%\) from ₹[\d,]+ when approval was asked for\. It is outside the traveller’s policy\.$/)

    // Still the approver's: the same step, now carrying the new verdict.
    expect((await bookingRow(id)).status).toBe('pending_approval')
    expect(await one(db, sql`select id, status, verdict from approvals where booking_id = ${id}`))
      .toEqual({ id: step.id, status: 'pending', verdict: 'red' })

    // The card shows the price asked for beside today's.
    const queue = await call(approvalsGet, { as: approver, url: '/api/approvals' })
    const card = (queue.json as { pending: { bookingId: string; booking: { totalCost: number; requestedTotal?: number } }[] }).pending
      .find(p => p.bookingId === id)!
    expect(card.booking).toMatchObject({ requestedTotal: asked, totalCost: body.newTotal })

    // A second check still measures from the price asked for.
    fake.pricing.mockResolvedValueOnce(pricing('UP-NEWER', 21000))
    const again = (await refresh(step.id)).json as Refreshed
    expect(again).toMatchObject({ previousTotal: body.newTotal, requestedTotal: asked })

    // And the approver can approve it at that price.
    expect((await call(decide, { as: approver, method: 'PATCH', url: `/api/approvals/${step.id}`, params: { approvalId: step.id },
      body: { decision: 'approve' } })).json).toMatchObject({ ok: true, bookingStatus: 'approved' })
  })

  it('an unmoved price: no "requested at" line on the card', async () => {
    const id = await book('SAME')
    const step = await pendingFor(id)
    fake.pricing.mockResolvedValueOnce(pricing('SAME-NEW', 10800))
    expect((await refresh(step.id)).json).toMatchObject({ change: 'same', sinceRequest: { amount: 0 } })
    const queue = await call(approvalsGet, { as: approver, url: '/api/approvals' })
    const card = (queue.json as { pending: { bookingId: string; booking: Record<string, unknown> }[] }).pending.find(p => p.bookingId === id)!
    expect(card.booking).not.toHaveProperty('requestedTotal')
  })

  it('the migration hands a booking sent back before this change to its approver again', async () => {
    const id = await book('SENTBACK')
    const step = await pendingFor(id)
    // As the old refresh left it: sent back, the step closed with its note, audited.
    await exec(db, sql`update bookings set status = 'reapproval_needed', sell_total = 10956, requested_total = null where id = ${id}`)
    await exec(db, sql`update approvals set status = 'superseded', actioned_at = now(),
      decision_note = 'The fare rose from ₹10,922 to ₹10,956 and is now outside the travel policy, so it went back to the traveller to ask for approval again.'
      where id = ${step.id}`)
    await exec(db, sql`insert into audit_log (action, entity_type, entity_id, client_id, metadata)
      values ('booking.returned_to_traveller', 'booking', ${id}, ${a.corpAdmin.client_id}, ${JSON.stringify({ previousTotal: 10921.9, newTotal: 10956.1 })}::jsonb)`)

    // Run as a migration runs: by the owner (the app's login cannot alter tables).
    const owner = new pg.Client({ connectionString: testOwnerUrl() })
    await owner.connect()
    try { await owner.query(readFileSync('db/migrations/20261118000100_requested_total.sql', 'utf8')) } finally { await owner.end() }

    expect(await one(db, sql`select status, requested_total from bookings where id = ${id}`))
      .toEqual({ status: 'pending_approval', requested_total: 10921.9 })
    expect(await one(db, sql`select status, actioned_at, decision_note from approvals where id = ${step.id}`))
      .toEqual({ status: 'pending', actioned_at: null, decision_note: null })
  })

  it('stale keys: the fare is found again in a fresh search, priced there, and the new keys kept', async () => {
    const id = await book('STALE')
    const step = await pendingFor(id)
    fake.pricing.mockRejectedValueOnce(stale())                 // the booking's own keys
    fake.searchFlights.mockResolvedValueOnce(searchResult('101'))
    fake.pricing.mockResolvedValueOnce(pricing('FRESH-PRICED', 10500))

    const res = await refresh(step.id)
    expect(res.status).toBe(200)
    expect(res.json).toMatchObject({ ok: true, outcome: 'continue', change: 'down' })

    // The search asked for the booked route and date, one adult, economy.
    expect(fake.searchFlights).toHaveBeenCalledTimes(1)
    expect(fake.searchFlights.mock.calls[0][0]).toMatchObject({
      segments: [{ Origin: 'DEL', Destination: 'BOM', DepartDate: '10/11/2030' }], rtf: false, preferredClass: '', adult: 1,
    })
    // Priced with the fresh search's keys, which the booking now carries.
    // (calls: booking it, the stale keys, then the fresh search's fare)
    expect(fake.pricing).toHaveBeenCalledTimes(3)
    expect(fake.pricing.mock.calls[2].slice(0, 4)).toEqual(['FRESH-SEARCH', 'PK-FRESH', 'test', '7'])
    expect(await bookingRow(id)).toMatchObject({
      status: 'pending_approval', total_cost: 10500, search_key: 'FRESH-SEARCH', pricing_key: 'PK-FRESH', result_index: '7',
    })
  })

  it('stale keys, and the flight is no longer offered: said plainly, nothing changes', async () => {
    const id = await book('GONE')
    const step = await pendingFor(id)
    const before = await bookingRow(id)
    fake.pricing.mockRejectedValueOnce(stale())
    fake.searchFlights.mockResolvedValueOnce(searchResult('999'))   // another flight that day

    const res = await refresh(step.id)
    expect(res).toMatchObject({ status: 200, json: { ok: true, outcome: 'flight_gone' } })
    expect((res.json as { message: string }).message).toMatch(/no longer offered/)
    expect(await bookingRow(id)).toEqual(before)
    expect(fake.pricing).toHaveBeenCalledTimes(2)                     // booking it, the stale keys; nothing after the search
    expect((await pendingFor(id)).id).toBe(step.id)
  })

  it('stale keys, and the flight is there but not the fare: fare_gone', async () => {
    const id = await book('NOFARE')
    const step = await pendingFor(id)
    fake.pricing.mockRejectedValueOnce(stale())
    fake.searchFlights.mockResolvedValueOnce(searchResult('101', 'Q'))  // only a Q-class fare left

    const res = await refresh(step.id)
    expect(res).toMatchObject({ status: 200, json: { ok: true, outcome: 'fare_gone' } })
    expect((await bookingRow(id)).status).toBe('pending_approval')
  })

  it('the approver sees what the fare was chosen from: the cheaper fare on the flight, the cheapest that day', async () => {
    // What the traveller's search showed (kept two hours; saved onto the booking).
    await bookingsRepo.saveSearchFares(db, {
      search_key: 'SK-CHOICE', client_id: a.corpAdmin.client_id!, traveller_id: colleague.id,
      flights: [
        { flightKey: 'k', label: 'AI 101', departure: '2030-11-10T08:00:00', origin: 'DEL', destination: 'BOM', journeys: 1,
          fares: [{ pricingKey: 'PK', total: 10500 }, { pricingKey: 'PK-SAVER', total: 9000 }] },
        { flightKey: '6e', label: '6E 201', departure: '2030-11-10T06:00:00', origin: 'DEL', destination: 'BOM', journeys: 1,
          fares: [{ pricingKey: 'X', total: 7000 }] },
        { flightKey: 'blr', label: '6E 9', departure: '2030-11-10T07:00:00', origin: 'DEL', destination: 'BLR', journeys: 1,
          fares: [{ pricingKey: 'Y', total: 3000 }] },
      ],
    })
    const id = await book('CHOICE', 'SK-CHOICE')
    const expected = {
      chosen: { total: 10500, name: 'Retail', refundable: true, label: 'AI 101', departure: '2030-11-10T08:00:00' },
      flightsShown: 2,
      cheaperOnFlight: { total: 9000, fares: 2 },
      cheapestFlight: { total: 7000, label: '6E 201', departure: '2030-11-10T06:00:00' },
    }
    const saved = await one<{ choice_context: unknown }>(db, sql`select choice_context from bookings where id = ${id}`)
    expect(saved.choice_context).toMatchObject(expected)

    // The approver's card carries it, with the flight's full itinerary.
    const queue = await call(approvalsGet, { as: approver, url: '/api/approvals' })
    const card = (queue.json as { pending: { bookingId: string; booking: { choice?: unknown; itinerary: { journeys?: unknown[] } } }[] }).pending
      .find(p => p.bookingId === id)!
    expect(card.booking.choice).toMatchObject(expected)
    expect(card.booking.itinerary.journeys).toHaveLength(1)

    // Without a kept search there is no comparison, and the card says nothing.
    const bare = await book('NOCHOICE', 'SK-NOT-KEPT')
    expect((await one<{ choice_context: unknown }>(db, sql`select choice_context from bookings where id = ${bare}`)).choice_context).toBeNull()
    const again = await call(approvalsGet, { as: approver, url: '/api/approvals' })
    expect((again.json as { pending: { bookingId: string; booking: Record<string, unknown> }[] }).pending
      .find(p => p.bookingId === bare)!.booking).not.toHaveProperty('choice')
  })
})
