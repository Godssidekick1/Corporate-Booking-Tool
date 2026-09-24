import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { POST as searchPost } from '@/app/api/book/search/route'
import { POST as pricePost } from '@/app/api/book/price/route'
import { POST as bookPost } from '@/app/api/book/booking/route'
import { POST as ticketPost } from '@/app/api/book/ticket/route'
import { AmadeusError } from '@/app/lib/amadeus/client'
import { call } from '../harness/call'
import { actors, type Actors } from '../harness/actors'
import { resetDatabase } from '../harness/db'
import { db } from '@/app/lib/db'
import { sql, one, maybeOne, exec } from '@/app/lib/db/sql'

// ── The booking flow: search → price → book → ticket ─────────────────────────
// Amadeus is FAKED. What these tests pin is everything on our side of the
// provider: who may call each step, the status gates, what is written, and --
// most importantly -- what happens to our record when the airline has already
// confirmed. Response mapping is unchanged by the data-layer migration and is
// exercised with the smallest payload that drives it.
//
// Never the real API: add-passenger and booking create PNRs.
// ─────────────────────────────────────────────────────────────────────────────

const fake = {
  searchFlights: vi.fn(),
  pricing: vi.fn(),
  addPassenger: vi.fn(),
  booking: vi.fn(),
  ticket: vi.fn(),
}

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
      ticket: (...a: unknown[]) => fake.ticket(...a),
    },
  }
})

const HAS_DB = Boolean(process.env.DATABASE_URL)
const d = HAS_DB ? describe : describe.skip

// One adult, AI, base 10000 + taxes 800.
const PRICING = {
  Key: 'KEY-1', ReferenceNo: 'REF-1',
  AirPricingResponse: [{
    PricingInfos: { PricingInfo: [{
      Total: { Fare: '10800', BaseFare: '10000', OtherTax: '500', FuelSurcharge: '300' },
      Currency: 'INR', FareType: 'Retail', Meal: 'NO',
      FareBreakDowns: { FareBreakDown: [{
        PaxType: 'ADT', BaseFare: '10000', TotalTax: '800', TotalFare: '10800', Refundable: 'Refundable',
        Taxes: { Tax: [{ TaxCode: 'K3', Amount: '500' }, { TaxCode: 'YQ', Amount: '300' }] },
      }] },
      FareInfos: { FareInfo: [{ PaxFareBasis: 'Y1' }] },
      Penalties: { ChangePenalty: [], CancelPenalty: [] },
    }] },
  }],
}

const ITINERARY = {
  flightKey: 'k', provider: 'test', isLcc: false, itemNo: '1', cabin: 'Economy',
  legs: [{ airlineCode: 'AI', flightNumber: '101', bookingCode: 'Y', cabin: 'Economy' }],
  journeys: [], origin: { code: 'DEL', name: 'Delhi', city: 'Delhi', dateTime: '2030-11-10T08:00:00' },
  destination: { code: 'BOM', name: 'Mumbai', city: 'Mumbai', dateTime: '2030-11-10T10:10:00' },
  airline: { code: 'AI', name: 'Air India' }, stopCount: 0, stops: [], fareOptions: [],
}

d('booking flow', () => {
  let a: Actors
  let owner: { id: string }
  let bookingId: string

  const row = (id: string) => maybeOne<Record<string, unknown>>(db, sql`
    select status, pnr, amadeus_key, provider_order_id, ticket_numbers, share_token from bookings where id = ${id}`)

  beforeAll(async () => {
    await resetDatabase()
    a = await actors()
    owner = { id: a.corpAdmin.id }
    bookingId = (await one<{ id: string }>(db, sql`
      select id from bookings where employee_id = ${owner.id} and status = 'held' order by created_at, id limit 1`)).id
  })

  beforeEach(() => {
    for (const f of Object.values(fake)) f.mockReset()
  })

  // ── Search ─────────────────────────────────────────────────────────────────

  it('search: 401, no employee row, and validation', async () => {
    const search = (as: { id: string } | null, body: unknown) => call(searchPost, { as, method: 'POST', url: '/api/book/search', body })
    expect((await search(null, {})).status).toBe(401)
    expect((await search({ id: '00000000-0000-0000-0000-00000000dead' }, {})).status).toBe(404)
    expect(await search(owner, { origin: 'DEL' })).toEqual({
      status: 400, json: { error: 'origin, destination, and departDate (DD/MM/YYYY) are required' },
    })
    expect(fake.searchFlights).not.toHaveBeenCalled()
  })

  it('search: an empty availability answers with no results', async () => {
    fake.searchFlights.mockResolvedValue({ Availibilities: [] })
    const res = await call(searchPost, {
      as: owner, method: 'POST', url: '/api/book/search',
      body: { origin: 'DEL', destination: 'BOM', departDate: '10/11/2030', tripType: 'oneway' },
    })
    expect(res).toEqual({ status: 200, json: { ok: true, results: [], availabilityKey: null } })
    expect(fake.searchFlights).toHaveBeenCalledTimes(1)
  })

  // ── Price ──────────────────────────────────────────────────────────────────

  const price = () => call(pricePost, {
    as: owner, method: 'POST', url: '/api/book/price',
    body: { key: 'SEARCH-KEY', pricingKey: 'PK', provider: 'test', resultIndex: '1', itinerary: ITINERARY },
  })

  it('price: required fields', async () => {
    expect((await call(pricePost, { as: owner, method: 'POST', url: '/api/book/price', body: {} })).status).toBe(400)
  })

  it('price: the sell-side quote, with the airline side persisted server-side only', async () => {
    fake.pricing.mockResolvedValue(PRICING)
    const res = await price()
    expect(res.status).toBe(200)
    expect(JSON.stringify(res.json)).not.toMatch(/"taxLines"|"fuelSurcharge"|"airline"/)
    expect(res.json).toMatchSnapshot()

    const quote = await one<Record<string, unknown>>(db, sql`
      select client_id, employee_id, pricing_key, provider, result_index, sell_total, airline_components
      from price_quotes where amadeus_key = 'KEY-1' and reference_no = 'REF-1'`)
    expect(quote).toMatchObject({
      client_id: a.corpAdmin.client_id, employee_id: owner.id, pricing_key: 'PK', provider: 'test', result_index: '1',
    })
    expect((quote.airline_components as { total: number }).total).toBe(10800)
  })

  it('price: re-pricing the same itinerary replaces the quote', async () => {
    fake.pricing.mockResolvedValue({ ...PRICING, AirPricingResponse: [{
      PricingInfos: { PricingInfo: [{ ...PRICING.AirPricingResponse[0].PricingInfos.PricingInfo[0],
        Total: { Fare: '11800', BaseFare: '11000', OtherTax: '500', FuelSurcharge: '300' } }] },
    }] })
    expect((await price()).status).toBe(200)
    const quotes = await one<{ n: number; total: number }>(db, sql`
      select count(*)::int as n, max((airline_components->>'total')::float8) as total
      from price_quotes where amadeus_key = 'KEY-1' and reference_no = 'REF-1'`)
    expect(quotes).toEqual({ n: 1, total: 11800 })
  })

  // ── Book ───────────────────────────────────────────────────────────────────

  const book = (id: string | undefined, as = owner) =>
    call(bookPost, { as, method: 'POST', url: '/api/book/booking', body: { bookingId: id } })

  const approve = () => exec(db, sql`
    update bookings set status = 'approved', amadeus_key = 'K-OLD', provider_order_id = 'R-OLD'
    where id = ${bookingId}`)

  it('book: required, not found, not yours, not approved', async () => {
    expect(await book(undefined)).toEqual({ status: 400, json: { error: 'bookingId is required' } })
    expect((await book('00000000-0000-0000-0000-000000000000')).status).toBe(404)
    await approve()
    const other = await one<{ id: string }>(db, sql`
      select id from employees where client_id = ${a.corpAdmin.client_id} and id <> ${owner.id} order by id limit 1`)
    expect(await book(bookingId, other)).toEqual({ status: 403, json: { error: 'Not authorized to act on this booking' } })
    await exec(db, sql`update bookings set status = 'pending_approval' where id = ${bookingId}`)
    expect((await book(bookingId)).status).toBe(409)
    expect(fake.booking).not.toHaveBeenCalled()
  })

  it('book: switched off in Corporate Settings', async () => {
    await approve()
    await exec(db, sql`update clients set hold_activation = false where id = ${a.corpAdmin.client_id}`)
    expect(await book(bookingId)).toEqual({
      status: 403, json: { error: 'Holding a booking is switched off for this account. Contact your travel desk.' },
    })
    await exec(db, sql`update clients set hold_activation = true where id = ${a.corpAdmin.client_id}`)
  })

  it('book: the airline confirms, the booking is held with its PNR', async () => {
    await approve()
    fake.booking.mockResolvedValue({ ReferenceNo: 'R-OLD', AirBookingResponse: [{ PNR: 'PNR001' }] })
    expect(await book(bookingId)).toEqual({ status: 200, json: { ok: true, bookingId, referenceNo: 'R-OLD', status: 'held' } })
    expect(fake.booking).toHaveBeenCalledWith('K-OLD', 'R-OLD', expect.anything())
    expect(await row(bookingId)).toMatchObject({ status: 'held', pnr: 'PNR001' })
  })

  it('book: an expired session is recovered by re-pricing and re-sending passengers', async () => {
    await approve()
    await exec(db, sql`
      update bookings set search_key = 'SK', pricing_key = 'PK', result_index = '1',
        traveler_snapshot = coalesce(traveler_snapshot, '{"PassengerDetails":[]}'::jsonb)
      where id = ${bookingId}`)
    fake.booking
      .mockRejectedValueOnce(new AmadeusError('Amadeus Booking failed: Result Session Expired'))
      .mockResolvedValueOnce({ ReferenceNo: 'R-NEW', AirBookingResponse: [{ PNR: 'PNR002' }] })
    fake.pricing.mockResolvedValue({ Key: 'K-NEW', ReferenceNo: 'R-PRICED' })
    fake.addPassenger.mockResolvedValue({ ReferenceNo: 'R-NEW' })

    expect(await book(bookingId)).toEqual({ status: 200, json: { ok: true, bookingId, referenceNo: 'R-NEW', status: 'held' } })
    expect(fake.booking).toHaveBeenLastCalledWith('K-NEW', 'R-NEW', expect.anything())
    expect(await row(bookingId)).toMatchObject({
      status: 'held', pnr: 'PNR002', amadeus_key: 'K-NEW', provider_order_id: 'R-NEW',
    })
  })

  it('book: a search too old to re-price fails the booking with SEARCH_EXPIRED', async () => {
    await approve()
    fake.booking.mockRejectedValue(new AmadeusError('Amadeus Booking failed: Result Session Expired'))
    fake.pricing.mockRejectedValue(new AmadeusError('Amadeus Pricing failed: Result Session Expired'))
    const res = await book(bookingId)
    expect(res.status).toBe(409)
    expect((res.json as { code: string }).code).toBe('SEARCH_EXPIRED')
    expect((await row(bookingId))?.status).toBe('failed')
  })

  it('book: any other airline failure fails the booking with a 502', async () => {
    await approve()
    fake.booking.mockRejectedValue(new AmadeusError('Amadeus Booking failed: Fare no longer available', 'F1'))
    const res = await book(bookingId)
    expect(res.status).toBe(502)
    expect((res.json as { error: string }).error).toBe('Amadeus Booking failed: Fare no longer available')
    expect((await row(bookingId))?.status).toBe('failed')
  })

  // ── Ticket ─────────────────────────────────────────────────────────────────

  const ticket = (id: string | undefined, as = owner) =>
    call(ticketPost, { as, method: 'POST', url: '/api/book/ticket', body: { bookingId: id } })

  const hold = () => exec(db, sql`
    update bookings set status = 'held', pnr = 'PNR003', share_token = null,
      amadeus_key = 'K', provider_order_id = 'R', pricing_key = 'PK', provider = 'test',
      itinerary = ${JSON.stringify(ITINERARY)}::jsonb
    where id = ${bookingId}`)

  it('ticket: required, not held, not yours', async () => {
    expect(await ticket(undefined)).toEqual({ status: 400, json: { error: 'bookingId is required' } })
    await exec(db, sql`update bookings set status = 'failed' where id = ${bookingId}`)
    const res = await ticket(bookingId)
    expect(res.status).toBe(409)
    expect(res.json).toMatchObject({ code: 'NOT_HELD', status: 'failed' })
    await hold()
    const other = await one<{ id: string }>(db, sql`
      select id from employees where client_id = ${a.corpAdmin.client_id} and id <> ${owner.id} order by id limit 1`)
    expect((await ticket(bookingId, other)).status).toBe(403)
    expect(fake.ticket).not.toHaveBeenCalled()
  })

  it('ticket: domestic ticketing switched off', async () => {
    await hold()
    await exec(db, sql`update clients set dom_ticketing = false where id = ${a.corpAdmin.client_id}`)
    expect(await ticket(bookingId)).toEqual({
      status: 403, json: { error: 'Domestic ticketing is switched off for this account. Contact your travel desk.' },
    })
    await exec(db, sql`update clients set dom_ticketing = true where id = ${a.corpAdmin.client_id}`)
  })

  it('ticket: issued; numbers kept in passenger order; a share token minted once', async () => {
    await hold()
    fake.ticket.mockResolvedValue({ AirBookingResponse: [{
      PNR: 'PNR003', CustomerInfo: { PassengerDetails: [{ TicketNo: 'T1' }, {}, { TicketNo: 'T3' }] },
    }] })
    const res = await ticket(bookingId)
    expect(res).toEqual({
      status: 200, json: { ok: true, bookingId, pnr: 'PNR003', ticketNumbers: ['T1', null, 'T3'], status: 'ticketed' },
    })
    const after = await row(bookingId)
    expect(after).toMatchObject({ status: 'ticketed', pnr: 'PNR003', ticket_numbers: ['T1', null, 'T3'] })
    expect(after?.share_token).toMatch(/^[0-9a-f]{32}$/)

    // Re-ticketing must not invalidate a link already sent.
    const token = after?.share_token
    await exec(db, sql`update bookings set status = 'held' where id = ${bookingId}`)
    await ticket(bookingId)
    expect((await row(bookingId))?.share_token).toBe(token)
  })

  it('ticket: an airline failure is a 502 and leaves the booking held', async () => {
    await hold()
    fake.ticket.mockRejectedValue(new AmadeusError('Amadeus Ticket failed: Queue busy', 'Q1'))
    const res = await ticket(bookingId)
    expect(res.status).toBe(502)
    expect((await row(bookingId))?.status).toBe('held')
  })
})
