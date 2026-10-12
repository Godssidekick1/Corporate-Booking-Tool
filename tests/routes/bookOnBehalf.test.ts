import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import { POST as chainPost } from '@/app/api/tmc/approval-chains/direct/route'
import { POST as searchPost } from '@/app/api/book/search/route'
import { POST as pricePost } from '@/app/api/book/price/route'
import { POST as addPassengerPost } from '@/app/api/book/add-passenger/route'
import { POST as bookPost } from '@/app/api/book/booking/route'
import { GET as bookingGet } from '@/app/api/book/[bookingId]/route'
import { call } from '../harness/call'
import { actors, type Actors } from '../harness/actors'
import { resetDatabase } from '../harness/db'
import { db } from '@/app/lib/db'
import { sql, many, one, exec } from '@/app/lib/db/sql'

// ── Booking on someone's behalf, through the routes ──────────────────────────
// The rules themselves are tested in tests/lib/bookingActor.test.ts. These pin
// what the routes do with them: whose booking it becomes, whose approval chain
// runs, whose quote may be booked, and who may confirm it.
//
// Amadeus is faked: add-passenger and booking create PNRs.
// ─────────────────────────────────────────────────────────────────────────────

const fake = { searchFlights: vi.fn(), pricing: vi.fn(), addPassenger: vi.fn(), booking: vi.fn() }

vi.mock('@/app/lib/amadeus/client', async orig => {
  const actual = await orig<typeof import('@/app/lib/amadeus/client')>()
  return {
    ...actual,
    amadeus: {
      ...actual.amadeus,
      searchFlights: (...a: unknown[]) => fake.searchFlights(...a),
      pricing: (...a: unknown[]) => fake.pricing(...a),
      addPassenger: (...a: unknown[]) => fake.addPassenger(...a),
      booking: (...a: unknown[]) => fake.booking(...a),
    },
  }
})

const HAS_DB = Boolean(process.env.DATABASE_URL)
const d = HAS_DB ? describe : describe.skip

function pricing(key: string, ref: string, total = 10800) {
  return {
    Key: key, ReferenceNo: ref,
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

d('book on behalf', () => {
  let a: Actors
  let clientId: string
  let admin: { id: string }       // the corporate admin, booking
  let colleague: { id: string }   // whom they book for
  let approver: { id: string }    // the colleague's own chain names them
  let bystander: { id: string }   // an ordinary employee of the same client

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-23T12:00:00Z'))
    await resetDatabase()
    a = await actors()
    clientId = a.corpAdmin.client_id!
    admin = { id: a.corpAdmin.id }
    const others = await many<{ id: string }>(db, sql`
      select id from employees
      where client_id = ${clientId} and id <> ${admin.id} and role = 'employee' and status = 'active'
      order by id limit 3`)
    if (others.length < 3) throw new Error('[tests] the corporate admin\'s client needs three employees')
    ;[colleague, approver, bystander] = others

    // The COLLEAGUE's chain: one step, a named approver, every verdict. The
    // admin's own chain is whatever the template has; if the booking used it,
    // this approver would not be the one asked.
    const chain = await call(chainPost, {
      as: a.tmcAdmin, method: 'POST', url: '/api/tmc/approval-chains/direct',
      body: { clientId, employeeId: colleague.id, category: 'air', mode: 'sequential', quorum: 'all',
        approvers: [{ approver_type: 'specific_user', approver_user_id: approver.id, min_verdict: 'green' }] },
    })
    expect(chain.status).toBe(200)
  })
  afterAll(() => { vi.useRealTimers() })

  beforeEach(() => { for (const f of Object.values(fake)) f.mockReset() })

  const price = (as: { id: string }, key: string, travellerId?: string) => {
    fake.pricing.mockResolvedValueOnce(pricing(key, `REF-${key}`))
    return call(pricePost, {
      as, method: 'POST', url: '/api/book/price',
      body: { key: 'SK', pricingKey: 'PK', provider: 'test', resultIndex: '1', itinerary: ITINERARY, travellerId },
    })
  }
  const addPassenger = (as: { id: string }, key: string, travellerId?: string) => {
    fake.addPassenger.mockResolvedValueOnce({ ReferenceNo: `REF-${key}` })
    return call(addPassengerPost, {
      as, method: 'POST', url: '/api/book/add-passenger',
      body: {
        key, pricingKey: 'PK', provider: 'test', resultIndex: '1', referenceNo: `REF-${key}`, totalFare: 10800,
        currency: 'INR', isRefundable: true, fareType: 'Retail', passengerBreakup: [], searchKey: 'SK',
        itinerary: ITINERARY, travellerId,
        customerInfo: { Email: 'c@example.test', Mobile: '9999999999', PassengerDetails: [{ FirstName: 'C', LastName: 'Olleague' }] },
      },
    })
  }

  it('an ordinary employee naming someone else is refused before the airline', async () => {
    const res = await call(searchPost, {
      as: bystander, method: 'POST', url: '/api/book/search',
      body: { travellerId: colleague.id, origin: 'DEL', destination: 'BOM', departDate: '10/11/2030', tripType: 'oneway' },
    })
    expect(res).toEqual({ status: 403, json: { error: 'You can only book travel for yourself.' } })
    expect((await price(bystander, 'NO', colleague.id)).status).toBe(403)
    expect(fake.searchFlights).not.toHaveBeenCalled()
    expect(fake.pricing).not.toHaveBeenCalled()
  })

  let bookingId: string

  it('a corporate admin books a colleague: the colleague travels, the admin booked, the colleague\'s chain runs', async () => {
    expect((await price(admin, 'B1', colleague.id)).status).toBe(200)
    expect(await one(db, sql`
      select employee_id, priced_by, client_id from price_quotes where amadeus_key = 'B1'`))
      .toEqual({ employee_id: colleague.id, priced_by: admin.id, client_id: clientId })

    const res = await addPassenger(admin, 'B1', colleague.id)
    expect(res).toMatchObject({ status: 200, json: { ok: true, status: 'pending_approval' } })
    bookingId = (res.json as { bookingId: string }).bookingId

    expect(await one(db, sql`select employee_id, booked_by, client_id from bookings where id = ${bookingId}`))
      .toEqual({ employee_id: colleague.id, booked_by: admin.id, client_id: clientId })
    expect(await many(db, sql`select tier, status, approver_id from approvals where booking_id = ${bookingId}`))
      .toEqual([{ tier: 1, status: 'pending', approver_id: approver.id }])
  })

  it('a quote is booked only by whoever priced it, for whom it was priced', async () => {
    expect((await price(admin, 'B2', colleague.id)).status).toBe(200)
    // The traveller, holding the admin's quote.
    expect(await addPassenger(colleague, 'B2')).toMatchObject({ status: 409, json: { code: 'QUOTE_EXPIRED' } })
    // The admin, booking it for someone else.
    expect(await addPassenger(admin, 'B2')).toMatchObject({ status: 409, json: { code: 'QUOTE_EXPIRED' } })
    expect(fake.addPassenger).not.toHaveBeenCalled()
  })

  it('the booking is visible to the traveller and the booker, nobody else at the client', async () => {
    const view = (as: { id: string }) => call(bookingGet, { as, url: `/api/book/${bookingId}`, params: { bookingId } })
    expect((await view(colleague)).status).toBe(200)
    expect((await view(admin)).status).toBe(200)
    expect(await view(bystander)).toEqual({ status: 403, json: { error: 'Not authorized to view this booking' } })
  })

  it('once approved, the booker or the traveller may confirm it; it records who did', async () => {
    const book = (as: { id: string }, id: string) =>
      call(bookPost, { as, method: 'POST', url: '/api/book/booking', body: { bookingId: id } })
    await exec(db, sql`update bookings set status = 'approved' where id = ${bookingId}`)

    expect(await book(bystander, bookingId)).toEqual({ status: 403, json: { error: 'Not authorized to act on this booking' } })

    fake.booking.mockResolvedValueOnce({ ReferenceNo: 'REF-B1', AirBookingResponse: [{ PNR: 'PNRB1' }] })
    expect((await book(colleague, bookingId)).status).toBe(200)
    expect(await one(db, sql`select status, confirmed_by from bookings where id = ${bookingId}`))
      .toEqual({ status: 'held', confirmed_by: colleague.id })

    // A second one, confirmed by the admin who made it.
    expect((await price(admin, 'B3', colleague.id)).status).toBe(200)
    const second = (await addPassenger(admin, 'B3', colleague.id)).json as { bookingId: string }
    await exec(db, sql`update bookings set status = 'approved' where id = ${second.bookingId}`)
    fake.booking.mockResolvedValueOnce({ ReferenceNo: 'REF-B3', AirBookingResponse: [{ PNR: 'PNRB3' }] })
    expect((await book(admin, second.bookingId)).status).toBe(200)
    expect(await one(db, sql`select confirmed_by from bookings where id = ${second.bookingId}`))
      .toEqual({ confirmed_by: admin.id })
  })

  it('booking for yourself is recorded as such', async () => {
    expect((await price(colleague, 'S1')).status).toBe(200)
    const res = await addPassenger(colleague, 'S1')
    expect(res.status).toBe(200)
    expect(await one(db, sql`select employee_id, booked_by from bookings where id = ${(res.json as { bookingId: string }).bookingId}`))
      .toEqual({ employee_id: colleague.id, booked_by: colleague.id })
  })
})
