import { describe, it, expect } from 'vitest'
import { choiceContext, shownFlights, CHEAPER_SHOWN, type ShownFlight } from './lowestLogicalFare'
import type { FlatFlightResult } from '@/app/lib/book/types'

// ── What the chosen fare was picked from, for the approver ───────────────────

const flight = (flightKey: string, label: string, departure: string, totals: number[], route = ['DEL', 'BOM']): ShownFlight => ({
  flightKey, label, departure, origin: route[0], destination: route[1], journeys: 1,
  fares: totals.map((total, i) => ({ pricingKey: `${flightKey}-${i}`, total })),
})

const NOW = new Date('2030-11-01T10:00:00Z')

describe('choiceContext', () => {
  const shown = [
    flight('ai', 'AI 101', '2030-11-10T08:00:00', [10500, 9000]),
    flight('6e', '6E 201', '2030-11-10T06:00:00', [7000, 8200]),
    flight('uk', 'UK 955', '2030-11-10T19:00:00', [12000]),
    flight('blr', '6E 9', '2030-11-10T07:00:00', [3000], ['DEL', 'BLR']),   // another route: never compared
  ]

  it('the cheaper fare on the same flight, the cheapest flight that day, and every cheaper option passed over', () => {
    expect(choiceContext(shown, 'ai', 'ai-0', { name: 'Flex', refundable: true }, NOW)).toEqual({
      chosen: { total: 10500, name: 'Flex', refundable: true, label: 'AI 101', departure: '2030-11-10T08:00:00' },
      flightsShown: 3,
      cheaperOnFlight: { total: 9000, fares: 2 },
      cheapestFlight: { total: 7000, label: '6E 201', departure: '2030-11-10T06:00:00' },
      // 6E 201 once, at its cheapest (one row per other flight); AI 101's
      // other fare; never UK 955 (dearer) or the other route.
      cheaper: [
        { sameFlight: false, label: '6E 201', departure: '2030-11-10T06:00:00', total: 7000, saving: 3500 },
        { sameFlight: true, label: 'AI 101', departure: '2030-11-10T08:00:00', total: 9000, saving: 1500 },
      ],
      cheaperCount: 2,
      savedAt: '2030-11-01T10:00:00.000Z',
    })
  })

  it('nothing cheaper: both comparisons are null and the list is empty', () => {
    const c = choiceContext(shown, '6e', '6e-0', {}, NOW)
    expect(c).toMatchObject({ cheaperOnFlight: null, cheapestFlight: null, cheaper: [], cheaperCount: 0, chosen: { name: null, refundable: null } })
  })

  it('the dearer fare on the cheapest flight: only the fare comparison', () => {
    expect(choiceContext(shown, '6e', '6e-1', {}, NOW)).toMatchObject({
      cheaperOnFlight: { total: 7000 }, cheapestFlight: null,
      cheaper: [{ sameFlight: true, label: '6E 201', total: 7000, saving: 1200 }],
    })
  })

  it('a rupee of rounding is not "cheaper"', () => {
    const near = [flight('a', 'AI 1', '2030-11-10T08:00:00', [5000.4, 5000]), flight('b', 'AI 2', '2030-11-10T09:00:00', [4999.6])]
    expect(choiceContext(near, 'a', 'a-0', {}, NOW)).toMatchObject({ cheaperOnFlight: null, cheapestFlight: null, cheaper: [] })
  })

  it('many cheaper flights: the cheapest few are kept, and the count says how many there were', () => {
    const many = [flight('x', 'AI 9', '2030-11-10T12:00:00', [9000]),
      ...Array.from({ length: 8 }, (_, i) => flight(`f${i}`, `6E ${i}`, `2030-11-10T0${i}:00:00`, [8000 - i * 100]))]
    const c = choiceContext(many, 'x', 'x-0', {}, NOW)!
    expect(c.cheaper).toHaveLength(CHEAPER_SHOWN)
    expect(c.cheaperCount).toBe(8)
    expect(c.cheaper!.map(o => o.total)).toEqual([7300, 7400, 7500, 7600, 7700])
  })

  it('carries what the approver weighs: arrival, stops, duration, fare name, refundability, policy', () => {
    const rich: ShownFlight[] = [
      flight('ai', 'AI 101', '2030-11-10T08:00:00', [10500]),
      { ...flight('6e', '6E 201', '2030-11-10T06:00:00', []), arrival: '2030-11-10T08:15:00', stops: 0, duration: '02:15',
        fares: [{ pricingKey: 's', total: 7000, name: 'Saver', refundable: false, policy: 'green' }] },
    ]
    expect(choiceContext(rich, 'ai', 'ai-0', {}, NOW)!.cheaper).toEqual([{
      sameFlight: false, label: '6E 201', departure: '2030-11-10T06:00:00', arrival: '2030-11-10T08:15:00', stops: 0,
      duration: '02:15', total: 7000, saving: 3500, fare: 'Saver', refundable: false, policy: 'green',
    }])
  })

  it('the chosen fare not among what was shown: no context rather than a wrong one', () => {
    expect(choiceContext(shown, 'ai', 'nope', {}, NOW)).toBeNull()
    expect(choiceContext(shown, 'gone', 'gone-0', {}, NOW)).toBeNull()
  })
})

describe('shownFlights', () => {
  it('keeps each fare\'s name, refundability and verdict, and the flight\'s arrival, stops and duration', () => {
    const result = {
      flightKey: 'k', provider: 't', isLcc: false, itemNo: '1', legs: [{ airlineCode: '6E', flightNumber: '201' }],
      journeys: [{ journeyNo: 1, stops: [], stopCount: 0, legs: [], totalDuration: '02:15',
        origin: { code: 'DEL', name: 'D', city: 'Delhi', dateTime: '2030-11-10T06:00:00' },
        destination: { code: 'BOM', name: 'B', city: 'Mumbai', dateTime: '2030-11-10T08:15:00' } }],
      fareOptions: [
        { pricingKey: 'p1', totalFare: 7200, sellEstimate: 7000, brandedFareName: 'SAVER', refundable: false, policy: 'green' },
        { pricingKey: 'p2', totalFare: 9000, fareType: 'Retail' },
      ],
    } as unknown as FlatFlightResult
    expect(shownFlights([result])).toEqual([{
      flightKey: 'k', departure: '2030-11-10T06:00:00', origin: 'DEL', destination: 'BOM', journeys: 1, label: '6E 201',
      arrival: '2030-11-10T08:15:00', stops: 0, duration: '02:15',
      fares: [
        { pricingKey: 'p1', total: 7000, name: 'SAVER', refundable: false, policy: 'green' },
        { pricingKey: 'p2', total: 9000, name: 'Retail' },
      ],
    }])
  })
})
