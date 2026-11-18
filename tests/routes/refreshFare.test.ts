import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { POST as chainPost } from '@/app/api/tmc/approval-chains/direct/route'
import { GET as rulesGet, POST as rulesPost } from '@/app/api/tmc/policy-rules/route'
import { POST as pricePost } from '@/app/api/book/price/route'
import { POST as addPassenger } from '@/app/api/book/add-passenger/route'
import { POST as refreshFare } from '@/app/api/approvals/[approvalId]/refresh-fare/route'
import { POST as reapproval } from '@/app/api/book/[bookingId]/reapproval/route'
import { GET as actionableGet } from '@/app/api/bookings/actionable/route'
import { GET as approvalsGet } from '@/app/api/approvals/route'
import * as bookingsRepo from '@/app/lib/repositories/bookings'
import { AmadeusError } from '@/app/lib/amadeus/client'
import { call } from '../harness/call'
import { actors, type Actors } from '../harness/actors'
import { resetDatabase } from '../harness/db'
import { db } from '@/app/lib/db'
import { sql, many, one, exec } from '@/app/lib/db/sql'

// ── Refresh fare after a long wait, and asking again ─────────────────────────
// An approval waits hours; a search's keys live ~25 minutes. Refresh re-finds
// the fare in a fresh search when the stored keys are stale
// (app/lib/book/refindFare.ts). A rise that leaves the fare out of policy
// beyond its grace goes back to the traveller (reapproval_needed), who asks
// again with a reason (POST /api/book/[bookingId]/reapproval).
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
  const askAgain = (bookingId: string, body: unknown, as: { id: string } = colleague) => call(reapproval, {
    as, method: 'POST', url: `/api/book/${bookingId}/reapproval`, params: { bookingId }, body,
  })
  const bookingRow = (id: string) => one<{ status: string; total_cost: number; sell_total: number; search_key: string; pricing_key: string; result_index: string }>(db, sql`
    select status, total_cost, sell_total, search_key, pricing_key, result_index from bookings where id = ${id}`)

  let returned: string

  it('a rise that leaves the fare out of policy goes back to the traveller; nothing waits for the approver', async () => {
    returned = await book('UP')
    const step = await pendingFor(returned)
    const before = await bookingRow(returned)
    fake.pricing.mockResolvedValueOnce(pricing('UP-NEW', 20000))

    const res = await refresh(step.id)
    expect(res.status).toBe(200)
    expect(res.json).toMatchObject({ ok: true, outcome: 'returned_to_traveller', change: 'up', previousTotal: before.sell_total })
    expect((res.json as { message: string }).message).toMatch(/gone back to them to ask for approval again/)

    expect((await bookingRow(returned)).status).toBe('reapproval_needed')
    const steps = await many<{ status: string; decision_note: string }>(db, sql`
      select status, decision_note from approvals where booking_id = ${returned}`)
    expect(steps).toHaveLength(1)
    expect(steps[0].status).toBe('superseded')
    expect(steps[0].decision_note).toMatch(/now outside the travel policy/)
    expect(await many(db, sql`
      select action from audit_log where entity_id = ${returned} and action = 'booking.returned_to_traveller'`)).toHaveLength(1)

    // The step is closed: refreshing it again is refused.
    expect((await refresh(step.id)).status).toBe(409)
    // And it waits on the traveller: it is in their "needs your action" list.
    const actionable = await call(actionableGet, { as: colleague, url: '/api/bookings/actionable' })
    expect((actionable.json as { bookings: { id: string; status: string }[] }).bookings)
      .toContainEqual(expect.objectContaining({ id: returned, status: 'reapproval_needed' }))
  })

  it('asking again: a reason is required, then a new round starts at the new price', async () => {
    const noReason = await askAgain(returned, {})
    expect(noReason).toMatchObject({ status: 400, json: { code: 'POLICY_REASON_REQUIRED' } })
    expect((await askAgain(returned, { reasonCode: 'other' })).status).toBe(400)   // "other" needs a note

    // Someone at another client cannot act on it.
    const outsider = await one<{ id: string }>(db, sql`
      select id from employees where client_id is not null and client_id <> ${a.corpAdmin.client_id} and status = 'active' order by id limit 1`)
    expect((await askAgain(returned, { reasonCode: 'schedule_need' }, outsider)).status).toBeGreaterThanOrEqual(403)
    expect((await bookingRow(returned)).status).toBe('reapproval_needed')

    const res = await askAgain(returned, { reasonCode: 'schedule_need', note: 'client meeting moved' })
    expect(res).toEqual({ status: 200, json: { ok: true, bookingId: returned, status: 'pending_approval' } })
    expect((await bookingRow(returned)).status).toBe('pending_approval')
    const fresh = await one<{ approver_id: string; reason: string | null }>(db, sql`
      select approver_id, reason from approvals where booking_id = ${returned} and status = 'pending'`)
    expect(fresh.approver_id).toBe(approver.id)
    // The approver reads why it came back, and the reason given.
    expect(fresh.reason).toMatch(/^Asked again after the fare rose to ₹[\d,]+\. Reason given: .+ \(client meeting moved\)$/)

    // Asked once; asking again is refused.
    expect(await askAgain(returned, { reasonCode: 'schedule_need' }))
      .toMatchObject({ status: 409, json: { code: 'NOT_RETURNED' } })
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
