import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { POST as pricePost } from '@/app/api/book/price/route'
import { POST as addPassengerPost } from '@/app/api/book/add-passenger/route'
import { POST as bookingPost } from '@/app/api/book/booking/route'
import { call } from '../harness/call'
import { actors, type Actors } from '../harness/actors'
import { resetDatabase } from '../harness/db'
import { db } from '@/app/lib/db'
import { sql, one, exec } from '@/app/lib/db/sql'
import { forgetFareRulesInFlight } from '@/app/lib/book/quoteFareRules'

// ── A traveller already on this flight ───────────────────────────────────────
// 17 Nov 2026: a third booking of one passenger on AI 2654 came back from the
// airline "Failed" with no reason. Airlines refuse a further booking of a
// person already on a flight. add-passenger asks first, whatever the company's
// own duplicate setting; a booking the airline turns down anyway is explained
// by it, not met with "please try again".
// ─────────────────────────────────────────────────────────────────────────────

const fake = { pricing: vi.fn(), addPassenger: vi.fn(), fareRule: vi.fn(), booking: vi.fn() }

vi.mock('@/app/lib/amadeus/client', async orig => {
  const actual = await orig<typeof import('@/app/lib/amadeus/client')>()
  return {
    ...actual,
    amadeus: {
      ...actual.amadeus,
      pricing: (...a: unknown[]) => fake.pricing(...a),
      addPassenger: (...a: unknown[]) => fake.addPassenger(...a),
      fareRule: (...a: unknown[]) => fake.fareRule(...a),
      booking: (...a: unknown[]) => fake.booking(...a),
    },
  }
})

vi.mock('@/app/lib/rule-engine/checkBookingAgainstPolicy', async orig => {
  const actual = await orig<typeof import('@/app/lib/rule-engine/checkBookingAgainstPolicy')>()
  return {
    ...actual,
    checkBookingAgainstPolicy: () => Promise.resolve({ ok: true, policyGroupName: 'P', bandCode: 'L1', verdict: 'green', breaches: [] }),
  }
})

const HAS_DB = Boolean(process.env.DATABASE_URL)
const d = HAS_DB ? describe : describe.skip

const origin = { code: 'DEL', name: 'Delhi', city: 'Delhi', dateTime: '2030-12-09T07:30:00' }
const destination = { code: 'BOM', name: 'Mumbai', city: 'Mumbai', dateTime: '2030-12-09T09:40:00' }
const LEG = { airlineCode: 'AI', flightNumber: '2654', bookingCode: 'T', cabin: 'Economy' }
const ITINERARY = {
  flightKey: 'DEL-2654', provider: '1A', isLcc: false, itemNo: '1', cabin: 'Economy', legs: [LEG],
  journeys: [{ journeyNo: 1, stops: [], stopCount: 0, legs: [LEG], origin, destination }],
  origin, destination, airline: { code: 'AI', name: 'Air India' }, stopCount: 0, stops: [], fareOptions: [],
}

function pricing(ref: string) {
  return {
    Key: `KEY-${ref}`, ReferenceNo: ref,
    AirPricingResponse: [{ PricingInfos: { PricingInfo: [{
      Total: { Fare: '6000', BaseFare: '5200', OtherTax: '800', FuelSurcharge: '0' },
      Currency: 'INR', FareType: 'NRM', Meal: 'NO',
      FareBreakDowns: { FareBreakDown: [{ PaxType: 'ADT', BaseFare: '5200', TotalTax: '800', TotalFare: '6000', Refundable: 'Refundable' }] },
      FareInfos: { FareInfo: [{ PaxFareBasis: 'TU1YXSII' }] },
      Penalties: { ChangePenalty: [], CancelPenalty: [] },
    }] } }],
  }
}

d('a traveller already on this flight', () => {
  let a: Actors
  let clientId: string
  let setting: string | null

  // Priced and passenger-added, as the booking pages do; the booking's id.
  async function book(ref: string, extra: Record<string, unknown> = {}) {
    fake.pricing.mockResolvedValueOnce(pricing(ref))
    const priced = await call(pricePost, {
      as: a.corpAdmin, method: 'POST', url: '/api/book/price',
      body: { key: 'SEARCH-KEY', pricingKey: `PK-${ref}`, provider: '1A', resultIndex: '1', itinerary: ITINERARY },
    })
    expect(priced.status).toBe(200)
    fake.addPassenger.mockResolvedValueOnce({ ReferenceNo: ref })
    return call(addPassengerPost, {
      as: a.corpAdmin, method: 'POST', url: '/api/book/add-passenger',
      body: {
        key: `KEY-${ref}`, pricingKey: `PK-${ref}`, provider: '1A', resultIndex: '1', referenceNo: ref, totalFare: 6000,
        currency: 'INR', isRefundable: true, fareType: 'NRM', passengerBreakup: [], searchKey: 'SEARCH-KEY', itinerary: ITINERARY,
        customerInfo: { Email: 'c@example.test', Mobile: '9999999999', PassengerDetails: [{ FirstName: 'Ravi', LastName: 'Kumar' }] },
        ...extra,
      },
    })
  }

  beforeAll(async () => {
    await resetDatabase()
    a = await actors()
    const row = await one<{ client_id: string; duplicate_booking_check: string | null }>(db, sql`
      select c.id as client_id, c.duplicate_booking_check from employees e join clients c on c.id = e.client_id where e.id = ${a.corpAdmin.id}`)
    clientId = row.client_id
    setting = row.duplicate_booking_check
    // The company's own check off: the same-flight check must not depend on it.
    await exec(db, sql`update clients set duplicate_booking_check = 'off' where id = ${clientId}`)
  })
  afterAll(async () => {
    await exec(db, sql`update clients set duplicate_booking_check = ${setting} where id = ${clientId}`)
  })
  beforeEach(() => { for (const f of Object.values(fake)) f.mockReset(); forgetFareRulesInFlight() })

  it('asks before the airline sees the passenger, then books when confirmed', async () => {
    const first = await book('REF-SF-1')
    expect(first.status).toBe(200)

    fake.addPassenger.mockClear()
    const again = await book('REF-SF-2')
    expect(again.status).toBe(409)
    expect(again.json).toMatchObject({ code: 'DUPLICATE_WARNING' })
    expect((again.json as { error: string }).error).toMatch(/already has a booking on AI 2654 on 9 Dec.*Book it anyway\?/)
    // Asked before the airline: it never saw this passenger.
    expect(fake.addPassenger).toHaveBeenCalledTimes(0)

    const confirmed = await book('REF-SF-3', { confirmDuplicate: true })
    expect(confirmed.status).toBe(200)
  })

  // The same "before the airline" principle for the passengers themselves
  // (app/lib/book/passengerChecks.ts): each refused with plain words, the
  // airline never asked.
  it('passengers the airline would refuse are refused first, saying why', async () => {
    const send = async (passengers: Record<string, unknown>[], contact: Record<string, unknown> = {}) => {
      fake.addPassenger.mockClear()
      const res = await book(`REF-PC-${Math.random().toString(36).slice(2, 8)}`, {
        confirmDuplicate: true,
        customerInfo: { Email: 'c@example.test', Mobile: '9999999999', PassengerDetails: passengers, ...contact },
      })
      expect(fake.addPassenger).not.toHaveBeenCalled()
      return res
    }
    const adult = { FirstName: 'Ravi', LastName: 'Kumar', PaxType: 'ADT' }
    // The flight is 9 Dec 2030: born Jan 2026, this "infant" will be 4 that day.
    const infantTooOld = await send([adult, { FirstName: 'Mira', LastName: 'Kumar', PaxType: 'INF', DateOfBirth: '01/01/2026' }])
    expect(infantTooOld.status).toBe(400)
    expect(infantTooOld.json).toMatchObject({ code: 'INVALID_PASSENGER', field: 'dateOfBirth', passenger: 1 })
    expect((infantTooOld.json as { error: string }).error).toMatch(/under 2 on the day of travel/)

    expect((await send([adult, { ...adult }])).json).toMatchObject({ code: 'INVALID_PASSENGER', error: expect.stringMatching(/same name/) })
    expect((await send([adult], { Email: 'not-an-email' })).json).toMatchObject({ code: 'INVALID_PASSENGER', field: 'email' })
    // Names keep their own code, as before.
    expect((await send([{ ...adult, LastName: '00003' }])).json).toMatchObject({ code: 'INVALID_PASSENGER_NAME' })
  })

  it('a booking the airline turns down with no reason is explained, not "try again"', async () => {
    const res = await book('REF-SF-4', { confirmDuplicate: true })
    expect(res.status).toBe(200)
    const bookingId = (res.json as { bookingId: string }).bookingId
    await exec(db, sql`update bookings set status = 'approved' where id = ${bookingId}`)

    const { AmadeusError } = await vi.importActual<typeof import('@/app/lib/amadeus/client')>('@/app/lib/amadeus/client')
    fake.booking.mockRejectedValueOnce(new AmadeusError('Amadeus Booking failed: no reason given by the provider', '', '', { Status: 'Failure' }, 'req-sf-4'))
    const confirm = await call(bookingPost, { as: a.corpAdmin, method: 'POST', url: '/api/book/booking', body: { bookingId } })
    expect(confirm.status).toBe(502)
    expect(confirm.json).toMatchObject({ code: 'ALREADY_ON_FLIGHT' })
    const error = (confirm.json as { error: string }).error
    expect(error).toMatch(/turned this booking down.*already has 2 bookings on AI 2654 on 9 Dec/)
    expect(error).not.toMatch(/try again/i)
    expect((await one<{ status: string }>(db, sql`select status from bookings where id = ${bookingId}`)).status).toBe('failed')
  })
})
