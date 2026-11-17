import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { POST as pricePost } from '@/app/api/book/price/route'
import { POST as addPassengerPost } from '@/app/api/book/add-passenger/route'
import { POST as bookingPost } from '@/app/api/book/booking/route'
import { POST as ticketPost } from '@/app/api/book/ticket/route'
import { call } from '../harness/call'
import { actors, type Actors } from '../harness/actors'
import { resetDatabase } from '../harness/db'
import { db } from '@/app/lib/db'
import { sql, one, exec } from '@/app/lib/db/sql'
import { forgetFareRulesInFlight } from '@/app/lib/book/quoteFareRules'

// ── When the airline doesn't answer ──────────────────────────────────────────
// Every airline call has a time limit now. For Booking and Ticket, no answer
// is not "not done": the airline is asked what happened (GetBookingDetails),
// a booking or ticket it has is recorded, and when it still can't say, the
// booking is marked so the next attempt asks before acting again -- never a
// second PNR or a second ticket on a guess.
// ─────────────────────────────────────────────────────────────────────────────

const fake = { pricing: vi.fn(), addPassenger: vi.fn(), fareRule: vi.fn(), booking: vi.fn(), ticket: vi.fn(), bookingStatus: vi.fn() }

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
      ticket: (...a: unknown[]) => fake.ticket(...a),
      bookingStatus: (...a: unknown[]) => fake.bookingStatus(...a),
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

const origin = { code: 'DEL', name: 'Delhi', city: 'Delhi', dateTime: '2030-12-11T07:30:00' }
const destination = { code: 'BOM', name: 'Mumbai', city: 'Mumbai', dateTime: '2030-12-11T09:40:00' }
const LEG = { airlineCode: 'AI', flightNumber: '2955', bookingCode: 'T', cabin: 'Economy' }
const ITINERARY = {
  flightKey: 'DEL-2955', provider: '1A', isLcc: false, itemNo: '1', cabin: 'Economy', legs: [LEG],
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

// What the airline holds, in Booking's own shape.
const held = (ref: string, status: string, ticketNo = '') => ({
  Status: 'Success', ReferenceNo: ref,
  AirBookingResponse: [{ BookingStatus: status, PNR: 'NA1PNR', FlightDetails: [], CustomerInfo: { PassengerDetails: [{ TicketNo: ticketNo }] } }],
})

d('when the airline does not answer', () => {
  let a: Actors
  let AmadeusError: typeof import('@/app/lib/amadeus/client').AmadeusError
  const noAnswer = (endpoint: string) => new AmadeusError(`No answer from Amadeus ${endpoint} within 90 s`, 'TIMEOUT', 'timeout', undefined, 'req-na')

  // An approved booking, ready to confirm.
  async function approvedBooking(ref: string): Promise<string> {
    fake.pricing.mockResolvedValueOnce(pricing(ref))
    expect((await call(pricePost, {
      as: a.corpAdmin, method: 'POST', url: '/api/book/price',
      body: { key: 'SEARCH-KEY', pricingKey: `PK-${ref}`, provider: '1A', resultIndex: '1', itinerary: ITINERARY },
    })).status).toBe(200)
    fake.addPassenger.mockResolvedValueOnce({ ReferenceNo: ref })
    const added = await call(addPassengerPost, {
      as: a.corpAdmin, method: 'POST', url: '/api/book/add-passenger',
      body: {
        key: `KEY-${ref}`, pricingKey: `PK-${ref}`, provider: '1A', resultIndex: '1', referenceNo: ref, totalFare: 6000,
        currency: 'INR', isRefundable: true, fareType: 'NRM', passengerBreakup: [], searchKey: 'SEARCH-KEY', itinerary: ITINERARY,
        confirmDuplicate: true,
        customerInfo: { Email: 'c@example.test', Mobile: '9999999999', PassengerDetails: [{ FirstName: 'Ravi', LastName: 'Kumar' }] },
      },
    })
    expect(added.status).toBe(200)
    const id = (added.json as { bookingId: string }).bookingId
    await exec(db, sql`update bookings set status = 'approved' where id = ${id}`)
    return id
  }
  const confirm = (bookingId: string) => call(bookingPost, { as: a.corpAdmin, method: 'POST', url: '/api/book/booking', body: { bookingId } })
  const ticket = (bookingId: string) => call(ticketPost, { as: a.corpAdmin, method: 'POST', url: '/api/book/ticket', body: { bookingId } })
  const row = (id: string) => one<{ status: string; provider_unconfirmed: string | null }>(db, sql`
    select status, provider_unconfirmed from bookings where id = ${id}`)

  beforeAll(async () => {
    await resetDatabase()
    a = await actors()
    ;({ AmadeusError } = await vi.importActual<typeof import('@/app/lib/amadeus/client')>('@/app/lib/amadeus/client'))
  })
  beforeEach(() => { for (const f of Object.values(fake)) f.mockReset(); forgetFareRulesInFlight() })

  it('Booking unanswered, but the airline has it: recorded as held, not failed', async () => {
    const id = await approvedBooking('REF-NA-1')
    fake.booking.mockRejectedValueOnce(noAnswer('Flight/Booking'))
    fake.bookingStatus.mockResolvedValueOnce({ state: 'held', response: held('REF-NA-1', 'Hold') })
    const res = await confirm(id)
    expect(res.status).toBe(200)
    expect(res.json).toMatchObject({ ok: true, status: 'held' })
    expect(await row(id)).toMatchObject({ status: 'held', provider_unconfirmed: null })
  })

  it('Booking unanswered and the airline can’t say: marked, never booked again on a guess', async () => {
    const id = await approvedBooking('REF-NA-2')
    fake.booking.mockRejectedValueOnce(noAnswer('Flight/Booking'))
    fake.bookingStatus.mockResolvedValueOnce({ state: 'unknown', response: null })
    const first = await confirm(id)
    expect(first.status).toBe(502)
    expect((first.json as { error: string }).error).toMatch(/can’t yet tell whether this booking went through.*don’t book it again/)
    expect(await row(id)).toMatchObject({ status: 'approved', provider_unconfirmed: 'booking' })

    // Trying again while the airline still can't say: refused, Booking not called.
    fake.booking.mockClear()
    fake.bookingStatus.mockResolvedValueOnce({ state: 'unknown', response: null })
    expect((await confirm(id)).json).toMatchObject({ code: 'OUTCOME_UNKNOWN' })
    expect(fake.booking).not.toHaveBeenCalled()

    // Later the airline says it was made: recorded, still without booking again.
    fake.bookingStatus.mockResolvedValueOnce({ state: 'held', response: held('REF-NA-2', 'Hold') })
    expect((await confirm(id)).json).toMatchObject({ ok: true, status: 'held' })
    expect(fake.booking).not.toHaveBeenCalled()
    expect(await row(id)).toMatchObject({ status: 'held', provider_unconfirmed: null })
  })

  it('Booking unanswered and the airline says it failed: failed, as before', async () => {
    const id = await approvedBooking('REF-NA-3')
    fake.booking.mockRejectedValueOnce(noAnswer('Flight/Booking'))
    fake.bookingStatus.mockResolvedValueOnce({ state: 'failed', response: held('REF-NA-3', 'Failed') })
    expect((await confirm(id)).status).toBe(502)
    expect(await row(id)).toMatchObject({ status: 'failed', provider_unconfirmed: null })
  })

  it('Ticket unanswered, but issued at the airline: the ticket is recorded', async () => {
    const id = await approvedBooking('REF-NA-4')
    fake.booking.mockResolvedValueOnce(held('REF-NA-4', 'Hold'))
    expect((await confirm(id)).status).toBe(200)

    fake.ticket.mockRejectedValueOnce(noAnswer('Flight/Ticket'))
    fake.bookingStatus.mockResolvedValueOnce({ state: 'ticketed', response: held('REF-NA-4', 'Ticketed', '0981234567890') })
    const res = await ticket(id)
    expect(res.status).toBe(200)
    expect(res.json).toMatchObject({ ok: true, status: 'ticketed', ticketNumbers: ['0981234567890'] })
  })

  it('Ticket unanswered and unknown: marked, and the next try asks before ticketing again', async () => {
    const id = await approvedBooking('REF-NA-5')
    fake.booking.mockResolvedValueOnce(held('REF-NA-5', 'Hold'))
    expect((await confirm(id)).status).toBe(200)

    fake.ticket.mockRejectedValueOnce(noAnswer('Flight/Ticket'))
    fake.bookingStatus.mockResolvedValueOnce({ state: 'unknown', response: null })
    const first = await ticket(id)
    expect((first.json as { error: string }).error).toMatch(/can’t yet tell whether the ticket was issued/)
    expect(await row(id)).toMatchObject({ status: 'held', provider_unconfirmed: 'ticket' })

    fake.ticket.mockClear()
    fake.bookingStatus.mockResolvedValueOnce({ state: 'unknown', response: null })
    expect((await ticket(id)).json).toMatchObject({ code: 'OUTCOME_UNKNOWN' })
    expect(fake.ticket).not.toHaveBeenCalled()
  })

  it('pricing unanswered: a plain "didn’t answer", safe to try again', async () => {
    fake.pricing.mockRejectedValueOnce(new AmadeusError('No answer from Amadeus flight/Pricing within 60 s', 'TIMEOUT', 'timeout', undefined, 'req-pr'))
    const res = await call(pricePost, {
      as: a.corpAdmin, method: 'POST', url: '/api/book/price',
      body: { key: 'SEARCH-KEY', pricingKey: 'PK-NA-6', provider: '1A', resultIndex: '1', itinerary: ITINERARY },
    })
    expect((res.json as { error: string }).error).toMatch(/didn’t answer in time/)
  })
})
