import { describe, it, expect } from 'vitest'
import { choiceContext, type ShownFlight } from './lowestLogicalFare'

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

  it('the cheaper fare on the same flight, and the cheapest flight on the route that day', () => {
    expect(choiceContext(shown, 'ai', 'ai-0', { name: 'Flex', refundable: true }, NOW)).toEqual({
      chosen: { total: 10500, name: 'Flex', refundable: true, label: 'AI 101', departure: '2030-11-10T08:00:00' },
      flightsShown: 3,
      cheaperOnFlight: { total: 9000, fares: 2 },
      cheapestFlight: { total: 7000, label: '6E 201', departure: '2030-11-10T06:00:00' },
      savedAt: '2030-11-01T10:00:00.000Z',
    })
  })

  it('nothing cheaper: both comparisons are null', () => {
    const c = choiceContext(shown, '6e', '6e-0', {}, NOW)
    expect(c).toMatchObject({ cheaperOnFlight: null, cheapestFlight: null, chosen: { name: null, refundable: null } })
  })

  it('the dearer fare on the cheapest flight: only the fare comparison', () => {
    expect(choiceContext(shown, '6e', '6e-1', {}, NOW)).toMatchObject({ cheaperOnFlight: { total: 7000 }, cheapestFlight: null })
  })

  it('a rupee of rounding is not "cheaper"', () => {
    const near = [flight('a', 'AI 1', '2030-11-10T08:00:00', [5000.4, 5000]), flight('b', 'AI 2', '2030-11-10T09:00:00', [4999.6])]
    expect(choiceContext(near, 'a', 'a-0', {}, NOW)).toMatchObject({ cheaperOnFlight: null, cheapestFlight: null })
  })

  it('the chosen fare not among what was shown: no context rather than a wrong one', () => {
    expect(choiceContext(shown, 'ai', 'nope', {}, NOW)).toBeNull()
    expect(choiceContext(shown, 'gone', 'gone-0', {}, NOW)).toBeNull()
  })
})
