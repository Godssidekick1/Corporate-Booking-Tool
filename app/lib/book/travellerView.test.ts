import { describe, it, expect } from 'vitest'
import { travellerItinerary, travellerFareBreakdown } from './travellerView'

describe('travellerItinerary', () => {
  const stored = {
    provider: 'Amadeus', airline: { code: 'AI', name: 'Air India' },
    origin: { code: 'DEL' }, destination: { code: 'BOM' }, journeys: [{ journeyNo: 1 }],
    stopCount: 0, cabin: 'Economy', checkInBaggageKg: '15', currency: 'INR',
    totalFare: 4961, baseFare: 4000, pricingKey: 'secret',
    fareOptions: [{ pricingKey: 'secret', totalFare: 4961 }],
    flightKey: 'k', itemNo: '1', availableSeats: 9,
  }

  it('keeps the route, drops every airline figure and provider key', () => {
    expect(travellerItinerary(stored)).toEqual({
      provider: 'Amadeus', airline: { code: 'AI', name: 'Air India' },
      origin: { code: 'DEL' }, destination: { code: 'BOM' }, journeys: [{ journeyNo: 1 }],
      stopCount: 0, cabin: 'Economy', checkInBaggageKg: '15', currency: 'INR',
    })
  })

  it('hides a field it has never heard of', () => {
    expect(travellerItinerary({ origin: { code: 'DEL' }, netFare: 100 })).toEqual({ origin: { code: 'DEL' } })
  })

  it('passes null through, and is not fooled by an array', () => {
    expect(travellerItinerary(null)).toBeNull()
    expect(travellerItinerary([{ totalFare: 1 }])).toBeNull()
  })
})

describe('travellerFareBreakdown', () => {
  it('drops the airline per-passenger split', () => {
    expect(travellerFareBreakdown({
      currency: 'INR', fareType: 'corporate', isRefundable: false, seatFees: 400,
      passengerBreakup: [{ PaxType: 'ADT', TotalFare: 4961 }],
    })).toEqual({ currency: 'INR', fareType: 'corporate', isRefundable: false, seatFees: 400 })
  })
})
