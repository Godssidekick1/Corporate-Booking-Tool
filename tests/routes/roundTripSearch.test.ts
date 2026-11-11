import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { POST as searchPost } from '@/app/api/book/search/route'
import { AmadeusError } from '@/app/lib/amadeus/client'
import { call } from '../harness/call'
import { actors, type Actors } from '../harness/actors'
import { resetDatabase } from '../harness/db'
import { db } from '@/app/lib/db'
import { sql, many } from '@/app/lib/db/sql'

// ── Round trips at search ────────────────────────────────────────────────────
// Domestic: two one-way searches (the two columns) and one RTF search (the
// airlines' special return fares), at once, each with its own availability key
// and its own kept search. International: one combined RTF search, as before.
// One of the three failing leaves the others on screen. Amadeus is faked.
// ─────────────────────────────────────────────────────────────────────────────

const fake = { searchFlights: vi.fn() }

vi.mock('@/app/lib/amadeus/client', async orig => {
  const actual = await orig<typeof import('@/app/lib/amadeus/client')>()
  return { ...actual, amadeus: { ...actual.amadeus, searchFlights: (...a: unknown[]) => fake.searchFlights(...a) } }
})
vi.mock('next/server', async orig => ({ ...(await orig<typeof import('next/server')>()), after: () => {} }))

const HAS_DB = Boolean(process.env.DATABASE_URL)
const d = HAS_DB ? describe : describe.skip

const place = (code: string, at: string) => ({ AirportCode: code, AirportName: code, CityName: code, DateTime: at })
function segment(from: string, to: string, dep: string, arr: string, journey: number, no: string) {
  return {
    Conx: { ViaPoint: '', IsChangeOfPlane: '' },
    Origin: place(from, dep), Destination: place(to, arr),
    AirLine: { Code: 'AI', Name: 'Air India', Identification: no },
    Baggage: { Allowance: { CheckInPiece: '', CheckInWeight: '15', CabinPiece: '', CabinWeight: '7' } },
    Leg: '1', Flight: String(journey), StopCount: '0-Stop', Duration: '02:10', AvailableSeats: '9',
    EquipmentType: '320', Cabin: 'Y', BookingCode: 'Y', Key: `seg-${no}`,
  }
}
function result(key: string, segments: ReturnType<typeof segment>[], total: number) {
  return {
    IsLCC: 'false', Provider: 'test', FlightKey: key, ItemNo: '1',
    TotalDuration: segments.map(s => ({ flight: s.Flight, text: '02:10' })),
    Itineraries: { Itinerary: segments },
    PricingInfos: { PricingInfo: [{
      Currency: 'INR', Pricingkey: `pk-${key}`, Meal: 'NO', FareType: 'NRM',
      Total: { BaseFare: String(total - 800), OtherTax: '800', Fare: String(total), FuelSurcharge: '0', NetFare: String(total), CommissionEarned: '0', ServiceFee: '0' },
      FareBreakDowns: { FareBreakDown: [{ PaxType: 'ADT', BaseFare: String(total - 800), TotalTax: '800', TotalFare: String(total), Currency: 'INR', Refundable: 'Refundable' }] },
      FareInfos: { FareInfo: [{ Cabin: 'Y', BookingCode: 'Y', PaxType: 'ADT', PaxCabin: 'Economy', PaxFareBasis: 'Y1', PaxBookingClass: 'Y' }] },
      Penalties: { ChangePenalty: [], CancelPenalty: [] },
    }] },
  }
}
const availability = (key: string, results: unknown[]) => ({ Key: key, Availibilities: [{ Availibility: results }] })

const OUT = segment('DEL', 'BOM', '2030-11-17T06:00:00', '2030-11-17T08:10:00', 1, '2993')
const BACK = segment('BOM', 'DEL', '2030-11-20T07:30:00', '2030-11-20T09:45:00', 1, '2994')
const ONWARD = availability('ON-KEY', [result('on-1', [OUT], 6240)])
const RETURN = availability('RET-KEY', [result('ret-1', [BACK], 6410)])
const SPECIAL = availability('RTF-KEY', [result('rtf-1', [OUT, { ...BACK, Flight: '2' }], 11480)])

// Answers by what was asked: an RTF search, or a one-way by its origin.
function provider(over: { onward?: unknown; return?: unknown; special?: unknown } = {}) {
  return async (params: { segments: { Origin: string }[]; rtf?: boolean }) => {
    const pick = params.rtf ? over.special ?? SPECIAL : params.segments[0].Origin === 'DEL' ? over.onward ?? ONWARD : over.return ?? RETURN
    if (pick instanceof Error) throw pick
    return pick
  }
}
const failure = (message: string) => new AmadeusError(message, 'E9', 'Provider', { Status: 'Failure' }, 'req-1')

d('round trips at search', () => {
  let a: Actors
  const search = (body: Record<string, unknown>) => call(searchPost, {
    as: a.corpAdmin, method: 'POST', url: '/api/book/search',
    body: { origin: 'DEL', destination: 'BOM', departDate: '17/11/2030', returnDate: '20/11/2030', tripType: 'return', ...body },
  })
  type Found = { results: { flightKey: string; journeys: unknown[]; fareOptions: { sellEstimate?: number }[] }[]; availabilityKey: string | null }

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-11T08:00:00Z'))
    await resetDatabase()
    a = await actors()
  })
  beforeEach(() => { fake.searchFlights.mockReset() })

  it('domestic: two one-way columns and the special return fares, three searches at once', async () => {
    fake.searchFlights.mockImplementation(provider())
    const res = await search({})
    expect(res.status).toBe(200)
    const json = res.json as { kind: string; onward: Found; return: Found; specialReturn: Found; notes: string[] }
    expect(json.kind).toBe('split')
    expect(json.notes).toEqual([])

    // Each column is one-way fares from its own search, with its own key.
    expect(json.onward).toMatchObject({ availabilityKey: 'ON-KEY', results: [{ flightKey: 'on:on-1' }] })
    expect(json.return).toMatchObject({ availabilityKey: 'RET-KEY', results: [{ flightKey: 'ret:ret-1' }] })
    expect(json.onward.results[0].journeys).toHaveLength(1)
    // The special return fare covers both directions at one price.
    expect(json.specialReturn).toMatchObject({ availabilityKey: 'RTF-KEY', results: [{ flightKey: 'rtf:rtf-1' }] })
    expect(json.specialReturn.results[0].journeys).toHaveLength(2)
    expect(typeof json.onward.results[0].fareOptions[0].sellEstimate).toBe('number')

    // What was asked of the provider.
    const asked = fake.searchFlights.mock.calls.map(([p]) => ({ rtf: p.rtf, route: p.segments.map((s: { Origin: string; Destination: string }) => `${s.Origin}-${s.Destination}`) }))
    expect(asked).toHaveLength(3)
    expect(asked).toEqual(expect.arrayContaining([
      { rtf: false, route: ['DEL-BOM'] },
      { rtf: false, route: ['BOM-DEL'] },
      { rtf: true, route: ['DEL-BOM', 'BOM-DEL'] },
    ]))

    // Each search kept on its own, so the lowest-fare check judges a column
    // against itself.
    const kept = await many<{ search_key: string }>(db, sql`
      select search_key from search_fares where search_key in ('ON-KEY', 'RET-KEY', 'RTF-KEY') order by search_key`)
    expect(kept.map(k => k.search_key)).toEqual(['ON-KEY', 'RET-KEY', 'RTF-KEY'])
  })

  it('international: one combined search, as before', async () => {
    fake.searchFlights.mockResolvedValue(availability('INTL-KEY', [result('intl-1', [
      segment('DEL', 'LHR', '2030-11-17T13:50:00', '2030-11-17T18:20:00', 1, '161'),
      segment('LHR', 'DEL', '2030-11-29T21:15:00', '2030-11-30T11:05:00', 2, '162'),
    ], 71200)]))
    const res = await search({ destination: 'LHR', returnDate: '29/11/2030' })
    expect(res.status).toBe(200)
    expect(res.json).toMatchObject({ kind: 'combined', availabilityKey: 'INTL-KEY', results: [{ flightKey: 'intl-1' }] })
    expect(fake.searchFlights).toHaveBeenCalledTimes(1)
    expect(fake.searchFlights.mock.calls[0][0]).toMatchObject({ rtf: true })
  })

  it('one search failing leaves the others on screen, with a note', async () => {
    fake.searchFlights.mockImplementation(provider({ return: failure('Amadeus FlightAvailability failed: timeout') }))
    const res = await search({})
    expect(res.status).toBe(200)
    expect(res.json).toMatchObject({
      kind: 'split', return: null,
      onward: { availabilityKey: 'ON-KEY' }, specialReturn: { availabilityKey: 'RTF-KEY' },
      notes: ['The return flights could not be loaded just now. Search again to try once more.'],
    })
  })

  it('no return fares from the airline: an empty list, not a failure', async () => {
    fake.searchFlights.mockImplementation(provider({ special: failure('Amadeus FlightAvailability failed: Result Not Found') }))
    const res = await search({})
    expect(res.status).toBe(200)
    expect(res.json).toMatchObject({ kind: 'split', specialReturn: { results: [], availabilityKey: null }, notes: [] })
  })

  it('all three failing is the provider failure a one-way search gives', async () => {
    fake.searchFlights.mockImplementation(async () => { throw failure('Amadeus FlightAvailability failed: timeout') })
    const res = await search({})
    expect(res.status).toBe(502)
  })
})
