import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { POST as pricePost } from '@/app/api/book/price/route'
import { POST as addPassengerPost } from '@/app/api/book/add-passenger/route'
import { POST as fareRulesPost } from '@/app/api/book/fare-rules/route'
import { GET as bookingGet } from '@/app/api/book/[bookingId]/route'
import { GET as tmcBookingGet } from '@/app/api/tmc/bookings/[id]/route'
import { GET as refundGet } from '@/app/api/tmc/queues/refunds/[id]/route'
import { call } from '../harness/call'
import { actors, type Actors } from '../harness/actors'
import { resetDatabase } from '../harness/db'
import { db } from '@/app/lib/db'
import { sql, one, exec } from '@/app/lib/db/sql'
import { FARE_RULE_AI_ECOVALU } from '../fixtures/amadeus/fareRule'
import type { FareRules } from '@/app/lib/book/fareRules'

// ── The airline's fare rules: their own request, kept with the booking ───────
// The price route no longer waits for them (7-12 s on the test system); it
// keeps the search key on the quote. /api/book/fare-rules then asks the
// airline with the quote's own keys, keeps the rules on the quote and shows
// them (never the TMC's deal code); add-passenger copies them onto the booking,
// asking once more if the quote has none. A provider that gives none never
// stops a fare being priced or booked.
// ─────────────────────────────────────────────────────────────────────────────

const fake = { pricing: vi.fn(), addPassenger: vi.fn(), fareRule: vi.fn() }

vi.mock('@/app/lib/amadeus/client', async orig => {
  const actual = await orig<typeof import('@/app/lib/amadeus/client')>()
  return {
    ...actual,
    amadeus: {
      ...actual.amadeus,
      pricing: (...a: unknown[]) => fake.pricing(...a),
      addPassenger: (...a: unknown[]) => fake.addPassenger(...a),
      fareRule: (...a: unknown[]) => fake.fareRule(...a),
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

const origin = { code: 'DEL', name: 'Delhi', city: 'Delhi', dateTime: '2030-12-07T07:30:00' }
const destination = { code: 'BOM', name: 'Mumbai', city: 'Mumbai', dateTime: '2030-12-07T09:40:00' }
const LEG = { airlineCode: 'AI', flightNumber: '2943', bookingCode: 'T', cabin: 'Economy' }
const ITINERARY = {
  flightKey: 'DEL-2943', provider: '1A', isLcc: false, itemNo: '1', cabin: 'Economy', legs: [LEG],
  journeys: [{ journeyNo: 1, stops: [], stopCount: 0, legs: [LEG], origin, destination }],
  origin, destination, airline: { code: 'AI', name: 'Air India' }, stopCount: 0, stops: [], fareOptions: [],
}

// The probe's rules, with a deal code the traveller must never see.
const WITH_DEAL = {
  ...FARE_RULE_AI_ECOVALU,
  FareRulesFlight: [{ Remarks: FARE_RULE_AI_ECOVALU.FareRulesFlight[0].Remarks.replace('"dealCode":""', '"dealCode":"CORPDEAL7"') }],
}

d('fare rules', () => {
  let a: Actors
  let bookingId: string

  const price = (ref: string) => {
    fake.pricing.mockResolvedValueOnce(pricing(ref))
    return call(pricePost, {
      as: a.corpAdmin, method: 'POST', url: '/api/book/price',
      body: { key: 'SEARCH-KEY', pricingKey: 'PK', provider: '1A', resultIndex: '1', itinerary: ITINERARY },
    })
  }
  const quoteRules = async (ref: string) => (await one<{ fare_rules: FareRules | null }>(db, sql`
    select fare_rules from price_quotes where amadeus_key = ${`KEY-${ref}`} and reference_no = ${ref}`)).fare_rules
  const rulesFor = (ref: string, as: { id: string } = a.corpAdmin) => call(fareRulesPost, {
    as, method: 'POST', url: '/api/book/fare-rules', body: { key: `KEY-${ref}`, referenceNo: ref },
  })

  beforeAll(async () => {
    await resetDatabase()
    a = await actors()
  })
  beforeEach(() => { for (const f of Object.values(fake)) f.mockReset() })

  it('pricing does not wait for the rules; their own request asks with the quote’s keys and keeps them', async () => {
    fake.fareRule.mockResolvedValue(WITH_DEAL)
    const res = await price('REF-FR-1')
    expect(res.status).toBe(200)
    expect(fake.fareRule).not.toHaveBeenCalled()
    expect(res.json).toMatchObject({ ok: true, fareRules: null })

    const rules = await rulesFor('REF-FR-1')
    expect(rules.status).toBe(200)
    // The search's key, kept on the quote at pricing: never the browser's.
    expect(fake.fareRule).toHaveBeenCalledWith({ key: 'SEARCH-KEY', pricingKey: 'PK', resultIndex: '1', provider: '1A' })
    const shown = (rules.json as { fareRules: FareRules }).fareRules
    expect(shown.sectors[0]).toMatchObject({ origin: 'DEL', destination: 'BOM', carrier: 'AI', dealCode: null })
    expect(shown.sectors[0].pax[0].cancel.find(w => w.kind === 'before_departure')).toMatchObject({ amount: 5000, currency: 'INR' })
    expect(JSON.stringify(rules.json)).not.toContain('CORPDEAL7')

    // The quote keeps the whole answer, deal code included, for the TMC.
    expect((await quoteRules('REF-FR-1'))?.sectors[0].dealCode).toBe('CORPDEAL7')

    // Asked again: the kept rules, without the airline.
    fake.fareRule.mockClear()
    expect(((await rulesFor('REF-FR-1')).json as { fareRules: FareRules }).fareRules.sectors).toHaveLength(1)
    expect(fake.fareRule).not.toHaveBeenCalled()

    // Pricing the same fare again keeps the rules already fetched.
    expect((await price('REF-FR-1')).status).toBe(200)
    expect((await quoteRules('REF-FR-1'))?.sectors[0].dealCode).toBe('CORPDEAL7')
  })

  it('only whoever priced the fare may ask; a missing quote is refused', async () => {
    expect((await price('REF-FR-4')).status).toBe(200)
    const stranger = await one<{ id: string }>(db, sql`
      select id from employees where client_id = (select client_id from employees where id = ${a.corpAdmin.id})
        and id <> ${a.corpAdmin.id} and status = 'active' order by id limit 1`)
    expect((await rulesFor('REF-FR-4', stranger)).status).toBe(404)
    expect((await rulesFor('REF-NOPE')).status).toBe(404)
    expect((await call(fareRulesPost, { as: a.corpAdmin, method: 'POST', url: '/api/book/fare-rules', body: {} })).status).toBe(400)
    expect(fake.fareRule).not.toHaveBeenCalled()
  })

  it('no rules from the airline still prices the fare', async () => {
    fake.fareRule.mockRejectedValue(new Error('provider down'))
    const res = await price('REF-FR-2')
    expect(res.status).toBe(200)
    expect(res.json).toMatchObject({ ok: true, fareRules: null })
    expect(((await rulesFor('REF-FR-2')).json)).toEqual({ ok: true, fareRules: null })
    expect(await quoteRules('REF-FR-2')).toBeNull()
  })

  it('add-passenger asks once more when the quote has no rules, and copies them onto the booking', async () => {
    // The fare page never got them: the quote has none.
    expect((await price('REF-FR-3')).status).toBe(200)
    expect(await quoteRules('REF-FR-3')).toBeNull()
    fake.fareRule.mockResolvedValue(WITH_DEAL)
    fake.addPassenger.mockResolvedValueOnce({ ReferenceNo: 'REF-FR-3' })
    const res = await call(addPassengerPost, {
      as: a.corpAdmin, method: 'POST', url: '/api/book/add-passenger',
      body: {
        key: 'KEY-REF-FR-3', pricingKey: 'PK', provider: '1A', resultIndex: '1', referenceNo: 'REF-FR-3', totalFare: 6000,
        currency: 'INR', isRefundable: true, fareType: 'NRM', passengerBreakup: [], searchKey: 'SK', itinerary: ITINERARY,
        customerInfo: { Email: 'c@example.test', Mobile: '9999999999', PassengerDetails: [{ FirstName: 'Ravi', LastName: 'Kumar' }] },
      },
    })
    expect(res.status).toBe(200)
    bookingId = (res.json as { bookingId: string }).bookingId
    const stored = await one<{ fare_rules: FareRules | null }>(db, sql`select fare_rules from bookings where id = ${bookingId}`)
    expect(stored.fare_rules?.sectors[0].pax[0].change.find(w => w.kind === 'before_departure')?.amount).toBe(3500)
  })

  it('the traveller’s booking shows the rules without the deal code; the TMC’s shows it', async () => {
    const mine = await call(bookingGet, { as: a.corpAdmin, url: `/api/book/${bookingId}`, params: { bookingId } })
    expect(mine.status).toBe(200)
    const shown = (mine.json as { booking: { fare_rules: FareRules } }).booking.fare_rules
    expect(shown.sectors[0].pax[0].cancel.length).toBe(3)
    expect(JSON.stringify(mine.json)).not.toContain('CORPDEAL7')

    const desk = await call(tmcBookingGet, { as: a.tmcAdmin, url: `/api/tmc/bookings/${bookingId}`, params: { id: bookingId } })
    expect(desk.status).toBe(200)
    expect((desk.json as { booking: { fareRules: FareRules } }).booking.fareRules.sectors[0].dealCode).toBe('CORPDEAL7')
  })

  it('the refund panel prefills the airline penalty from the rules, unless the airline already charged', async () => {
    // Cancelled 290 hours before the rules' departure (7 Dec 2026, 07:30 India time).
    const cancel = async (charge: number) => {
      await exec(db, sql`
        update bookings set status = 'cancelled', ticket_numbers = ${['TKT-FR-1']}, cancelled_at = '2026-11-25T00:00:00Z',
          cancellation = ${JSON.stringify({ cancelStatus: 'cancelled', wasTicketed: true, cancellationCharge: charge, serviceTaxOnRaf: 0, refundedAmount: 0 })}::jsonb
        where id = ${bookingId}`)
      await exec(db, sql`delete from refunds where booking_id = ${bookingId}`)
      return (await one<{ id: string }>(db, sql`
        insert into refunds (client_id, booking_id, passenger_index, ticket_number)
        select client_id, id, 0, 'TKT-FR-1' from bookings where id = ${bookingId} returning id`)).id
    }
    type Panel = {
      computation: { deductions: { key: string; amount: number; source: string }[] }
      penaltyFromRules: { amount: number | null; basis: string[]; warnings: string[] }
      fareRules: FareRules
    }
    const panel = async (id: string) => {
      const res = await call(refundGet, { as: a.tmcAdmin, url: `/api/tmc/queues/refunds/${id}`, params: { id } })
      expect(res.status).toBe(200)
      return res.json as Panel
    }
    const penaltyLine = (p: Panel) => p.computation.deductions.find(d => d.key === 'airline_penalty')

    const free = await panel(await cancel(0))
    expect(penaltyLine(free)).toMatchObject({ amount: 5000, source: 'fare_rules' })
    expect(free.penaltyFromRules.basis[0]).toMatch(/^DEL → BOM: ₹5,000/)
    expect(free.fareRules.sectors[0].dealCode).toBe('CORPDEAL7')

    const charged = await panel(await cancel(5000))
    expect(penaltyLine(charged)).toMatchObject({ amount: 0, source: 'airline' })
    expect(charged.penaltyFromRules.amount).toBeNull()
    expect(charged.penaltyFromRules.warnings[0]).toMatch(/already charged ₹5,000/)
  })

  it('a provider method a test forgot to mock is refused, never sent', async () => {
    const real = await vi.importActual<typeof import('@/app/lib/amadeus/client')>('@/app/lib/amadeus/client')
    await expect(real.amadeus.fareRule({ key: 'K', pricingKey: 'P', resultIndex: '1', provider: '1A' }))
      .rejects.toThrow(/called for real/)
  })
})
