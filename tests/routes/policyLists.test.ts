import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import { POST as searchPost } from '@/app/api/book/search/route'
import { POST as pricePost } from '@/app/api/book/price/route'
import { POST as addPassengerPost } from '@/app/api/book/add-passenger/route'
import { GET as rulesGet, POST as rulesPost } from '@/app/api/tmc/policy-rules/route'
import { POST as previewPost } from '@/app/api/book/policy-preview/route'
import { call } from '../harness/call'
import { actors, type Actors } from '../harness/actors'
import { resetDatabase } from '../harness/db'
import { db } from '@/app/lib/db'
import { sql, one, maybeOne, exec } from '@/app/lib/db/sql'

// ── A traveller's blocked airlines and allowed fare types, through the routes ─
// Not a verdict: those fares are left out of the search, and price and
// add-passenger refuse one that arrives anyway. Always the TRAVELLER's policy:
// here a corporate admin books for a colleague whose group blocks SpiceJet and
// allows only retail and corporate fares.
//
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

// The search records carriers with after(), which needs a live request scope.
vi.mock('next/server', async orig => ({ ...(await orig<typeof import('next/server')>()), after: () => {} }))

const HAS_DB = Boolean(process.env.DATABASE_URL)
const d = HAS_DB ? describe : describe.skip

const place = (code: string, at: string) => ({ AirportCode: code, AirportName: code, CityName: code, DateTime: at })

function segment(airline: string) {
  return {
    Conx: { ViaPoint: '', IsChangeOfPlane: '' },
    Origin: place('DEL', '2030-11-10T08:00:00'), Destination: place('BOM', '2030-11-10T10:10:00'),
    AirLine: { Code: airline, Name: airline, Identification: '101' },
    Baggage: { Allowance: { CheckInPiece: '', CheckInWeight: '15', CabinPiece: '', CabinWeight: '7' } },
    Leg: '1', Flight: '1', StopCount: '0-Stop', Duration: '02:10', AvailableSeats: '9',
    EquipmentType: '320', Cabin: 'Y', BookingCode: 'Y', Key: 'seg',
  }
}

function pricingInfo(key: string, fareType: string, total: number) {
  return {
    Currency: 'INR', Pricingkey: key, Meal: 'NO', FareType: fareType,
    Total: { BaseFare: String(total - 800), OtherTax: '800', Fare: String(total), FuelSurcharge: '0', NetFare: String(total), CommissionEarned: '0', ServiceFee: '0' },
    FareBreakDowns: { FareBreakDown: [{ PaxType: 'ADT', BaseFare: String(total - 800), TotalTax: '800', TotalFare: String(total), Currency: 'INR', Refundable: 'Refundable' }] },
    FareInfos: { FareInfo: [{ Cabin: 'Y', BookingCode: 'Y', PaxType: 'ADT', PaxCabin: 'Economy', PaxFareBasis: 'Y1', PaxBookingClass: 'Y' }] },
    Penalties: { ChangePenalty: [], CancelPenalty: [] },
  }
}

function result(key: string, airline: string, fares: [string, string, number][]) {
  return {
    IsLCC: 'false', Provider: 'test', FlightKey: key, ItemNo: '1',
    TotalDuration: [{ flight: '1', text: '02:10' }],
    Itineraries: { Itinerary: [segment(airline)] },
    PricingInfos: { PricingInfo: fares.map(([k, type, total]) => pricingInfo(k, type, total)) },
  }
}

const AVAILABILITY = {
  Key: 'SEARCH-KEY',
  Availibilities: [{ Availibility: [
    // Kept, but its tactical fare is not.
    result('ai', 'AI', [['ai-tact', 'TACTICAL', 4000], ['ai-retail', 'NRM', 5000], ['ai-corp', 'CRP', 5200]]),
    // Blocked airline: gone.
    result('sg', 'SG', [['sg-retail', 'NRM', 3000]]),
    // Only an SME fare, which the policy does not allow: gone.
    result('6e', '6E', [['6e-sme', 'SME', 3500]]),
  ] }],
}

function priced(airline: string, fareType: string, ref: string) {
  return { Key: 'PRICE-KEY', ReferenceNo: ref, AirPricingResponse: [result('p', airline, [['pk', fareType, 5000]])] }
}

const ITINERARY = {
  flightKey: 'ai', provider: 'test', isLcc: false, itemNo: '1', cabin: 'Economy',
  legs: [{ airlineCode: 'AI', flightNumber: '101', bookingCode: 'Y', cabin: 'Economy' }],
  journeys: [], origin: { code: 'DEL', name: 'Delhi', city: 'Delhi', dateTime: '2030-11-10T08:00:00' },
  destination: { code: 'BOM', name: 'Mumbai', city: 'Mumbai', dateTime: '2030-11-10T10:10:00' },
  airline: { code: 'AI', name: 'Air India' }, stopCount: 0, stops: [], fareOptions: [],
}

d('policy lists: blocked airlines and allowed fare types', () => {
  let a: Actors
  let clientId: string
  let colleague: { id: string }
  let groupD: string

  // Saves a new version of the colleague's group: today's rules plus `lists`.
  async function setLists(lists: Record<string, string[]>) {
    const current = await call(rulesGet, { as: a.tmcAdmin, url: `/api/tmc/policy-rules?groupId=${groupD}` })
    const rows = (current.json as { rows: { travel_type: string; limit_key: string; limit_value: number | null; limit_bool: boolean | null; limit_list: string[] | null }[] }).rows
      .filter(r => !(r.limit_key in lists) && r.limit_list === null)
      .map(({ travel_type, limit_key, limit_value, limit_bool }) => ({ travel_type, limit_key, limit_value, limit_bool }))
    const listRows = Object.entries(lists).filter(([, v]) => v.length > 0)
      .map(([limit_key, limit_list]) => ({ travel_type: 'flight', limit_key, limit_list }))
    const res = await call(rulesPost, { as: a.tmcAdmin, method: 'POST', url: '/api/tmc/policy-rules', body: { policyGroupId: groupD, rules: [...rows, ...listRows] } })
    expect(res.status).toBe(200)
  }

  const search = () => call(searchPost, {
    as: a.corpAdmin, method: 'POST', url: '/api/book/search',
    body: { origin: 'DEL', destination: 'BOM', departDate: '10/11/2030', tripType: 'oneway', travellerId: colleague.id },
  })
  const price = (ref: string) => call(pricePost, {
    as: a.corpAdmin, method: 'POST', url: '/api/book/price',
    body: { key: 'SEARCH-KEY', pricingKey: 'pk', provider: 'test', resultIndex: '1', itinerary: ITINERARY, travellerId: colleague.id },
  }).then(res => ({ res, quote: maybeOne(db, sql`select 1 as held from price_quotes where reference_no = ${ref}`) }))

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-19T12:00:00Z'))
    await resetDatabase()
    a = await actors()
    clientId = a.corpAdmin.client_id!
    groupD = (await one<{ id: string }>(db, sql`
      select id from policy_groups where tmc_id = ${a.tmcAdmin.tmc_id} and name = 'd'`)).id
    // An L1 colleague: group d covers ranks 1-3 at this client.
    colleague = await one<{ id: string }>(db, sql`
      select id from employees where client_id = ${clientId} and band_code = 'L1' and id <> ${a.corpAdmin.id}
        and status = 'active' order by id limit 1`)
    await setLists({ blocked_airlines: ['SG'], preferred_airlines: ['AI'], allowed_fare_types: ['RETAIL', 'CORPORATE'] })
  })
  afterAll(() => { vi.useRealTimers() })
  beforeEach(() => { for (const f of Object.values(fake)) f.mockReset() })

  it('search: blocked airlines and other fare types are not shown; preferred is marked', async () => {
    fake.searchFlights.mockResolvedValue(AVAILABILITY)
    const res = await search()
    expect(res.status).toBe(200)
    const results = (res.json as { results: { flightKey: string; preferred?: boolean; pricingKey: string; fareOptions: { pricingKey: string }[] }[] }).results
    expect(results.map(r => r.flightKey)).toEqual(['ai'])
    expect(results[0].fareOptions.map(f => f.pricingKey)).toEqual(['ai-retail', 'ai-corp'])
    // The headline price follows the first fare left, not the removed one.
    expect(results[0]).toMatchObject({ pricingKey: 'ai-retail', preferred: true })
  })

  it('search: nothing is hidden when the client has policy control off', async () => {
    await exec(db, sql`update clients set policy_controlling = false where id = ${clientId}`)
    try {
      fake.searchFlights.mockResolvedValue(AVAILABILITY)
      const results = ((await search()).json as { results: { flightKey: string }[] }).results
      expect(results.map(r => r.flightKey)).toEqual(['ai', 'sg', '6e'])
    } finally {
      await exec(db, sql`update clients set policy_controlling = true where id = ${clientId}`)
    }
  })

  it('price: a blocked airline or a disallowed fare type is refused, and no quote is held', async () => {
    fake.pricing.mockResolvedValue(priced('SG', 'NRM', 'REF-SG'))
    const blocked = await price('REF-SG')
    expect(blocked.res).toEqual({ status: 422, json: { ok: false, error: "The traveller's travel policy does not allow SG flights.", code: 'POLICY_DISALLOWED' } })
    expect(await blocked.quote).toBeNull()

    fake.pricing.mockResolvedValue(priced('AI', 'SME', 'REF-SME'))
    const sme = await price('REF-SME')
    expect(sme.res.status).toBe(422)
    expect(await sme.quote).toBeNull()

    fake.pricing.mockResolvedValue(priced('AI', 'CRP', 'REF-OK'))
    const ok = await price('REF-OK')
    expect(ok.res.status).toBe(200)
    expect(await ok.quote).toEqual({ held: 1 })
  })

  it('add-passenger: a policy changed since pricing is still applied, before the airline is asked', async () => {
    fake.pricing.mockResolvedValue(priced('AI', 'NRM', 'REF-AP'))
    expect((await price('REF-AP')).res.status).toBe(200)
    await setLists({ blocked_airlines: ['AI'] })

    const res = await call(addPassengerPost, {
      as: a.corpAdmin, method: 'POST', url: '/api/book/add-passenger',
      body: {
        key: 'PRICE-KEY', pricingKey: 'pk', provider: 'test', resultIndex: '1', referenceNo: 'REF-AP', totalFare: 5000,
        currency: 'INR', isRefundable: true, fareType: 'NRM', passengerBreakup: [], searchKey: 'SK',
        itinerary: ITINERARY, travellerId: colleague.id,
        customerInfo: { Email: 'c@example.test', Mobile: '9999999999', PassengerDetails: [{ FirstName: 'C', LastName: 'Olleague' }] },
      },
    })
    expect(res).toEqual({ status: 422, json: { error: "The traveller's travel policy does not allow AI flights.", code: 'POLICY_DISALLOWED' } })
    expect(fake.addPassenger).not.toHaveBeenCalled()
  })

  // ── Lowest logical fare: what the search showed is kept, and judged ────────
  it('lowest logical fare: a cheaper flight within the window needs approval; outside it, nothing', async () => {
    await setLists({})
    // The group's window, saved as the editor does: every other rule unchanged.
    async function setWindow(minutes: number) {
      const current = await call(rulesGet, { as: a.tmcAdmin, url: `/api/tmc/policy-rules?groupId=${groupD}` })
      const rows = (current.json as { rows: { travel_type: string; limit_key: string; limit_value: number | null; limit_bool: boolean | null; limit_list: string[] | null }[] }).rows
        .filter(r => r.limit_key !== 'lowest_fare_window_minutes' && r.limit_list === null)
        .map(({ travel_type, limit_key, limit_value, limit_bool }) => ({ travel_type, limit_key, limit_value, limit_bool }))
      expect((await call(rulesPost, { as: a.tmcAdmin, method: 'POST', url: '/api/tmc/policy-rules',
        body: { policyGroupId: groupD, rules: [...rows, { travel_type: 'flight', limit_key: 'lowest_fare_window_minutes', limit_value: minutes }] } })).status).toBe(200)
    }
    const at = (key: string, airline: string, dep: string, fares: [string, string, number][]) => {
      const r = result(key, airline, fares)
      const seg = { ...segment(airline), Origin: place('DEL', dep) }
      return { ...r, Itineraries: { Itinerary: [seg] } }
    }
    fake.searchFlights.mockResolvedValue({ Key: 'LLF-KEY', Availibilities: [{ Availibility: [
      at('ai-0800', 'AI', '2030-11-10T08:00:00', [['c-0800', 'NRM', 6000]]),
      at('uk-0840', 'UK', '2030-11-10T08:40:00', [['c-0840', 'NRM', 5200]]),
      at('sg-0900', 'SG', '2030-11-10T09:00:00', [['c-0900', 'NRM', 4000]]),
    ] }] })
    expect((await search()).status).toBe(200)
    // Kept as shown: each flight, its departure and its fares.
    const kept = await one<{ flights: { flightKey: string; departure: string; fares: { pricingKey: string; total: number }[] }[] }>(db, sql`
      select flights from search_fares where search_key = 'LLF-KEY' and traveller_id = ${colleague.id}`)
    expect(kept.flights.map(f => [f.flightKey, f.departure, f.fares.map(x => x.pricingKey)])).toEqual([
      ['ai-0800', '2030-11-10T08:00:00', ['c-0800']],
      ['uk-0840', '2030-11-10T08:40:00', ['c-0840']],
      ['sg-0900', '2030-11-10T09:00:00', ['c-0900']],
    ])

    const preview = () => call(previewPost, {
      as: a.corpAdmin, method: 'POST', url: '/api/book/policy-preview',
      body: { travellerId: colleague.id, flight: { ...ITINERARY, flightKey: 'ai-0800' }, totalFare: 6000, isRefundable: true,
        searchKey: 'LLF-KEY', pricingKey: 'c-0800' },
    }).then(r => r.json as { verdict: string; breaches: { limit_key: string; severity: string; alternative?: unknown }[]; reason: string })

    // Group d's other rules (a budget-only carrier tier) judge this fare too;
    // only the lowest-fare line is this test's.
    const lowest = (p: Awaited<ReturnType<typeof preview>>) => p.breaches.filter(b => b.limit_key === 'lowest_fare_window_minutes')

    // 45 minutes: the 08:40 flight at 5,200 is the cheaper one in reach.
    await setWindow(45)
    const within = await preview()
    expect(lowest(within)).toEqual([expect.objectContaining({ severity: 'amber' })])
    expect(within.reason).toContain('UK 101 at 08:40 was ₹5,200')

    // 30 minutes: nothing cheaper close enough.
    await setWindow(30)
    expect(lowest(await preview())).toEqual([])
  })
})
