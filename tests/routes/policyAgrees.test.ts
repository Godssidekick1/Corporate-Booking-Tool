import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { POST as searchPost } from '@/app/api/book/search/route'
import { POST as pricePost } from '@/app/api/book/price/route'
import { POST as addPassengerPost } from '@/app/api/book/add-passenger/route'
import { POST as previewPost } from '@/app/api/book/policy-preview/route'
import { GET as rulesGet, POST as rulesPost } from '@/app/api/tmc/policy-rules/route'
import { call } from '../harness/call'
import { actors, type Actors } from '../harness/actors'
import { resetDatabase } from '../harness/db'
import { db } from '@/app/lib/db'
import { sql, one } from '@/app/lib/db/sql'

// ── One fare, one verdict: the policy judges what the company pays ───────────
// The price page once judged each fare before discount and fee, while the
// details page and add-passenger judged the sell total: a well-discounted
// fare read "out of policy", then "within" one step later. Now search gives
// every fare its sell estimate, composed as the price route composes it, and
// every check judges that figure.
//
// A colleague (group d) is booked by the corporate admin. The client's
// commercials discount AI fares, so the sell price is below the fare; the cap
// is set between the two. Amadeus is faked.
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

// The search records carriers with after(), which needs a live request scope.
vi.mock('next/server', async orig => ({ ...(await orig<typeof import('next/server')>()), after: () => {} }))

const HAS_DB = Boolean(process.env.DATABASE_URL)
const d = HAS_DB ? describe : describe.skip

const place = (code: string, at: string) => ({ AirportCode: code, AirportName: code, CityName: code, DateTime: at })

const SEGMENT = {
  Conx: { ViaPoint: '', IsChangeOfPlane: '' },
  Origin: place('DEL', '2030-11-10T08:00:00'), Destination: place('BOM', '2030-11-10T10:10:00'),
  AirLine: { Code: 'AI', Name: 'AI', Identification: '101' },
  Baggage: { Allowance: { CheckInPiece: '', CheckInWeight: '15', CabinPiece: '', CabinWeight: '7' } },
  Leg: '1', Flight: '1', StopCount: '0-Stop', Duration: '02:10', AvailableSeats: '9',
  EquipmentType: '320', Cabin: 'Y', BookingCode: 'Y', Key: 'seg',
}

// One adult, AI, base 10000 + taxes 800.
const PRICING_INFO = {
  Currency: 'INR', Pricingkey: 'pk', Meal: 'NO', FareType: 'NRM',
  Total: { BaseFare: '10000', OtherTax: '800', Fare: '10800', FuelSurcharge: '0', NetFare: '10800', CommissionEarned: '0', ServiceFee: '0' },
  FareBreakDowns: { FareBreakDown: [{ PaxType: 'ADT', BaseFare: '10000', TotalTax: '800', TotalFare: '10800', Currency: 'INR', Refundable: 'Refundable' }] },
  FareInfos: { FareInfo: [{ Cabin: 'Y', BookingCode: 'Y', PaxType: 'ADT', PaxCabin: 'Economy', PaxFareBasis: 'Y1', PaxBookingClass: 'Y' }] },
  Penalties: { ChangePenalty: [], CancelPenalty: [] },
}

const RESULT = {
  IsLCC: 'false', Provider: 'test', FlightKey: 'ai', ItemNo: '1',
  TotalDuration: [{ flight: '1', text: '02:10' }],
  Itineraries: { Itinerary: [SEGMENT] },
  PricingInfos: { PricingInfo: [PRICING_INFO] },
}

const ITINERARY = {
  flightKey: 'ai', provider: 'test', isLcc: false, itemNo: '1', cabin: 'Economy',
  legs: [{ airlineCode: 'AI', flightNumber: '101', bookingCode: 'Y', cabin: 'Economy' }],
  journeys: [], origin: { code: 'DEL', name: 'Delhi', city: 'Delhi', dateTime: '2030-11-10T08:00:00' },
  destination: { code: 'BOM', name: 'Mumbai', city: 'Mumbai', dateTime: '2030-11-10T10:10:00' },
  airline: { code: 'AI', name: 'Air India' }, stopCount: 0, stops: [], fareOptions: [],
}

type Breach = { limit_key: string; severity: string }
const fareCap = (breaches: Breach[] | undefined) => (breaches ?? []).filter(b => b.limit_key === 'max_fare_domestic')

d('policy: one fare, one verdict', () => {
  let a: Actors
  let colleague: { id: string }
  let groupD: string

  // The group's domestic fare cap, saved as the editor does: every other rule
  // unchanged.
  async function setCap(cap: number) {
    const current = await call(rulesGet, { as: a.tmcAdmin, url: `/api/tmc/policy-rules?groupId=${groupD}` })
    const rows = (current.json as { rows: { travel_type: string; limit_key: string; limit_value: number | null; limit_bool: boolean | null; limit_list: string[] | null }[] }).rows
      .filter(r => r.limit_key !== 'max_fare_domestic' && r.limit_key !== 'fare_grace' && r.limit_key !== 'fare_grace_unit')
      .map(({ travel_type, limit_key, limit_value, limit_bool, limit_list }) =>
        limit_list !== null ? { travel_type, limit_key, limit_list } : { travel_type, limit_key, limit_value, limit_bool })
    const res = await call(rulesPost, { as: a.tmcAdmin, method: 'POST', url: '/api/tmc/policy-rules',
      body: { policyGroupId: groupD, rules: [...rows, { travel_type: 'flight', limit_key: 'max_fare_domestic', limit_value: cap }] } })
    expect(res.status).toBe(200)
  }

  const preview = (body: Record<string, unknown>) => call(previewPost, {
    as: a.corpAdmin, method: 'POST', url: '/api/book/policy-preview',
    body: { travellerId: colleague.id, isRefundable: true, ...body },
  }).then(r => r.json as { ok: boolean; verdict: string; breaches: Breach[]; reason: string })

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-19T12:00:00Z'))
    await resetDatabase()
    a = await actors()
    groupD = (await one<{ id: string }>(db, sql`
      select id from policy_groups where tmc_id = ${a.tmcAdmin.tmc_id} and name = 'd'`)).id
    // An L1 colleague: group d covers ranks 1-3 at this client.
    colleague = await one<{ id: string }>(db, sql`
      select id from employees where client_id = ${a.corpAdmin.client_id} and band_code = 'L1' and id <> ${a.corpAdmin.id}
        and status = 'active' order by id limit 1`)
  })
  afterAll(() => { vi.useRealTimers() })
  beforeEach(() => { for (const f of Object.values(fake)) f.mockReset() })

  it('search, price page, details page and add-passenger all judge the sell price, and agree', async () => {
    // Search: each fare carries what the company would pay for it.
    fake.searchFlights.mockResolvedValue({ Key: 'SEARCH-KEY', Availibilities: [{ Availibility: [RESULT] }] })
    const searched = await call(searchPost, {
      as: a.corpAdmin, method: 'POST', url: '/api/book/search',
      body: { origin: 'DEL', destination: 'BOM', departDate: '10/11/2030', tripType: 'oneway', travellerId: colleague.id },
    })
    expect(searched.status).toBe(200)
    const flight = (searched.json as { results: { fareOptions: { pricingKey: string; totalFare: number; sellEstimate: number }[] }[] }).results[0]
    const { totalFare: fare, sellEstimate: sell } = flight.fareOptions[0]
    // The client's AI discount puts the sell price below the fare.
    expect(sell).toBeLessThan(fare)

    // The cap sits between the two: within on the sell price, over on the fare.
    await setCap(sell)

    // The price page's preview, from the search row.
    const pricePage = await preview({ flight, sellTotal: sell, searchKey: 'SEARCH-KEY', pricingKey: 'pk' })
    expect(pricePage.ok).toBe(true)
    expect(fareCap(pricePage.breaches)).toEqual([])
    // What the price page used to judge (the fare before discount and fee) is
    // over the cap: the disagreement this test exists for.
    expect(fareCap((await preview({ flight, sellTotal: fare })).breaches)).toHaveLength(1)

    // Priced: the same figure the search estimated.
    fake.pricing.mockResolvedValue({ Key: 'PRICE-KEY', ReferenceNo: 'REF-AGREE', AirPricingResponse: [RESULT] })
    const priced = await call(pricePost, {
      as: a.corpAdmin, method: 'POST', url: '/api/book/price',
      body: { key: 'SEARCH-KEY', pricingKey: 'pk', provider: 'test', resultIndex: '1', itinerary: ITINERARY, travellerId: colleague.id },
    })
    expect(priced.status).toBe(200)
    const pricedSell = (priced.json as { sellTotal: number }).sellTotal
    expect(pricedSell).toBe(sell)

    // The details page's preview, on the priced figure.
    const details = await preview({ flight: ITINERARY, sellTotal: pricedSell, searchKey: 'SEARCH-KEY', pricingKey: 'pk' })
    expect(fareCap(details.breaches)).toEqual([])

    // add-passenger, the authoritative check, on the server-held quote.
    fake.addPassenger.mockResolvedValueOnce({ ReferenceNo: 'REF-AGREE' })
    const added = await call(addPassengerPost, {
      as: a.corpAdmin, method: 'POST', url: '/api/book/add-passenger',
      body: {
        key: 'PRICE-KEY', pricingKey: 'pk', provider: 'test', resultIndex: '1', referenceNo: 'REF-AGREE', totalFare: fare,
        currency: 'INR', isRefundable: true, fareType: 'NRM', passengerBreakup: [], searchKey: 'SEARCH-KEY',
        itinerary: ITINERARY, travellerId: colleague.id,
        customerInfo: { Email: 'c@example.test', Mobile: '9999999999', PassengerDetails: [{ FirstName: 'Ravi', LastName: 'Kumar' }] },
      },
    })
    expect(added.status).toBe(200)
    const booking = await one<{ policy_status: string; policy_verdict_detail: { breaches: Breach[] } }>(db, sql`
      select policy_status, policy_verdict_detail from bookings where provider_order_id = 'REF-AGREE'`)
    expect(booking.policy_status).toBe('evaluated')
    expect(fareCap(booking.policy_verdict_detail.breaches)).toEqual([])
  })

  it('preview: only the sell price is judged; a request without one is refused plainly', async () => {
    const res = await call(previewPost, {
      as: a.corpAdmin, method: 'POST', url: '/api/book/policy-preview',
      body: { travellerId: colleague.id, flight: ITINERARY, totalFare: 5000, isRefundable: true },
    })
    expect(res).toEqual({ status: 400, json: { error: 'flight and sellTotal (the price the company pays) are required' } })
  })

  it('a round trip priced together is held to the cap for each of its two flights', async () => {
    await setCap(6000)
    const out = { journeyNo: 1, origin: ITINERARY.origin, destination: ITINERARY.destination, stops: [], stopCount: 0, legs: ITINERARY.legs }
    const back = {
      journeyNo: 2, stops: [], stopCount: 0, legs: ITINERARY.legs,
      origin: { ...ITINERARY.destination, dateTime: '2030-11-12T18:00:00' },
      destination: { ...ITINERARY.origin, dateTime: '2030-11-12T20:10:00' },
    }
    const roundTrip = { ...ITINERARY, journeys: [out, back] }

    // ₹11,000 for two flights against ₹6,000 each: within.
    expect(fareCap((await preview({ flight: roundTrip, sellTotal: 11000 })).breaches)).toEqual([])
    // The same ₹11,000 for one flight is over.
    expect(fareCap((await preview({ flight: { ...ITINERARY, journeys: [out] }, sellTotal: 11000 })).breaches)).toHaveLength(1)

    // Over twice the cap: out of policy, and the reason says per flight.
    const over = await preview({ flight: roundTrip, sellTotal: 13000 })
    expect(fareCap(over.breaches)).toEqual([expect.objectContaining({ severity: 'red' })])
    expect(over.reason).toContain('₹13,000 for 2 flights against ₹12,000 (₹6,000 per flight)')
  })
})
