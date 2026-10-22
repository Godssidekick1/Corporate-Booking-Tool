import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { POST as searchPost } from '@/app/api/book/search/route'
import { POST as pricePost } from '@/app/api/book/price/route'
import { AmadeusError } from '@/app/lib/amadeus/client'
import { call } from '../harness/call'
import { actors, type Actors } from '../harness/actors'
import { resetDatabase } from '../harness/db'

// ── What a traveller sees when the airline system fails ─────────────────────
// Through the real routes, the airline faked: a search with no flights is the
// page's "No flights found"; any other failure is a plain sentence and a
// reference, never the provider's name, text, request id or payload.
// ─────────────────────────────────────────────────────────────────────────────

const fake = { searchFlights: vi.fn(), pricing: vi.fn() }

vi.mock('@/app/lib/amadeus/client', async orig => {
  const actual = await orig<typeof import('@/app/lib/amadeus/client')>()
  return {
    ...actual,
    amadeus: {
      ...actual.amadeus,
      searchFlights: (...a: unknown[]) => fake.searchFlights(...a),
      pricing: (...a: unknown[]) => fake.pricing(...a),
    },
  }
})

const HAS_DB = Boolean(process.env.DATABASE_URL)
const d = HAS_DB ? describe : describe.skip

const failure = (message: string) => new AmadeusError(message, 'E9', 'Provider',
  { Status: 'Failure', Error: { Description: message.replace(/^.*failed: /, '') } },
  'a1b2c3d4-1111-4111-8111-111111111111', { Authentication: { secret: 'x' } })

const LEAKS = /amadeus|flightavailability|requestId|details|a1b2c3d4-1111|Authentication|E9/i

const ITINERARY = {
  flightKey: 'k', provider: 'test', isLcc: false, itemNo: '1', cabin: 'Economy',
  legs: [{ airlineCode: 'AI', flightNumber: '101', bookingCode: 'Y', cabin: 'Economy' }],
  journeys: [], origin: { code: 'DEL', name: 'Delhi', city: 'Delhi', dateTime: '2030-11-10T08:00:00' },
  destination: { code: 'BOM', name: 'Mumbai', city: 'Mumbai', dateTime: '2030-11-10T10:10:00' },
  airline: { code: 'AI', name: 'Air India' }, stopCount: 0, stops: [], fareOptions: [],
}

d('provider errors reaching the booking screens', () => {
  let a: Actors
  const search = () => call(searchPost, {
    as: a.corpAdmin, method: 'POST', url: '/api/book/search',
    body: { origin: 'DEL', destination: 'BOM', departDate: '10/11/2030', tripType: 'oneway' },
  })
  const price = () => call(pricePost, {
    as: a.corpAdmin, method: 'POST', url: '/api/book/price',
    body: { key: 'SEARCH-KEY', pricingKey: 'PK', provider: 'test', resultIndex: '1', itinerary: ITINERARY },
  })

  beforeAll(async () => {
    await resetDatabase()
    a = await actors()
  })
  beforeEach(() => {
    for (const f of Object.values(fake)) f.mockReset()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'info').mockImplementation(() => {})
  })

  it('search: "Result Not Found" is no flights, not an error', async () => {
    fake.searchFlights.mockRejectedValue(failure('Amadeus FlightAvailability failed: Result Not Found'))
    expect(await search()).toEqual({ status: 200, json: { ok: true, results: [], availabilityKey: null } })
  })

  it('search: any other failure is a plain sentence and a reference', async () => {
    fake.searchFlights.mockRejectedValue(failure('Amadeus FlightAvailability failed: Queue busy'))
    const res = await search()
    expect(res).toEqual({ status: 502, json: {
      error: 'We couldn’t get flights from the airline just now. Please try again in a moment. (Reference A1B2C3D4)',
      code: 'PROVIDER_FAILED', reference: 'A1B2C3D4',
    } })
    expect(JSON.stringify(res.json)).not.toMatch(LEAKS)
  })

  it('price: a fare gone is a clean choose-again; anything else plain', async () => {
    fake.pricing.mockRejectedValue(failure('Amadeus Pricing failed: Fare Not Found'))
    expect(await price()).toEqual({ status: 200, json: {
      ok: false, reason: 'fare_not_found',
      error: 'This fare is no longer available. Please search again or select a different flight.',
    } })

    fake.pricing.mockRejectedValue(failure('Amadeus Pricing failed: Queue busy'))
    const res = await price()
    expect(res.status).toBe(502)
    expect(res.json).toMatchObject({ ok: false, code: 'PROVIDER_FAILED', reference: 'A1B2C3D4' })
    expect(JSON.stringify(res.json)).not.toMatch(LEAKS)
  })
})
