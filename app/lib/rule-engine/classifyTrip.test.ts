import { describe, it, expect } from 'vitest'
import {
  isIndianAirport,
  classifyTrip,
  classifyFlight,
  advanceBookingDays,
  longestLegHours,
} from './classifyTrip'

// ── classifyTrip ─────────────────────────────────────────────────────────────
// Domestic vs international drives four separate things: whether a passport is
// demanded, which fare cap applies (max_fare_domestic vs max_fare_intl),
// whether the dom_ticketing or intl_ticketing gate is consulted, and which
// category deal codes and commercial rules resolve against (DOMAIRBSP vs
// INTAIRBSP). Getting it wrong is wrong four times over.
//
// The provider gives no country code -- Amadeus airport objects carry only
// AirportCode/AirportName/CityName -- so this is inferred from a curated list.
// That list being incomplete is expected, and the failure direction is
// deliberate: an unknown airport reads as INTERNATIONAL, which asks for a
// passport that is not needed rather than skipping one that is.
// ─────────────────────────────────────────────────────────────────────────────

describe('isIndianAirport', () => {
  it('recognises Indian airports', () => {
    expect(isIndianAirport('DEL')).toBe(true)
    expect(isIndianAirport('BOM')).toBe(true)
    expect(isIndianAirport('BLR')).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(isIndianAirport('del')).toBe(true)
    expect(isIndianAirport('DeL')).toBe(true)
  })

  it('does not recognise foreign airports', () => {
    expect(isIndianAirport('DXB')).toBe(false)
    expect(isIndianAirport('LHR')).toBe(false)
    expect(isIndianAirport('SIN')).toBe(false)
  })

  it('treats an unknown code as NOT Indian, so the trip reads international', () => {
    // The safe direction to be wrong in.
    expect(isIndianAirport('ZZZ')).toBe(false)
    expect(isIndianAirport('')).toBe(false)
  })
})

describe('classifyTrip', () => {
  it('is domestic only when BOTH ends of every leg are Indian', () => {
    expect(classifyTrip([{ origin: 'DEL', destination: 'BOM' }])).toBe('domestic')
    expect(classifyTrip([
      { origin: 'DEL', destination: 'BOM' },
      { origin: 'BOM', destination: 'BLR' },
    ])).toBe('domestic')
  })

  it('one international leg makes the WHOLE trip international', () => {
    // Matches how max_fare_intl and the long-haul cabin policy are meant to
    // apply: one long leg is enough to trigger them.
    expect(classifyTrip([
      { origin: 'DEL', destination: 'BOM' },
      { origin: 'BOM', destination: 'DXB' },
    ])).toBe('international')
  })

  it('treats a trip touching an unknown airport as international', () => {
    expect(classifyTrip([{ origin: 'DEL', destination: 'ZZZ' }])).toBe('international')
  })
})

describe('classifyFlight', () => {
  it('reads the route off journeys when present', () => {
    expect(classifyFlight({
      journeys: [{ origin: { code: 'DEL' }, destination: { code: 'BOM' }, stops: [] }],
    })).toBe('domestic')
  })

  it('catches an international stop inside a journey', () => {
    // DEL -> DXB -> FCO: both hops international.
    expect(classifyFlight({
      journeys: [{
        origin: { code: 'DEL' },
        destination: { code: 'FCO' },
        stops: [{ code: 'DXB' }],
      }],
    })).toBe('international')
  })

  it('handles a round trip, where the turnaround is NOT in stops', () => {
    // Per-journey stops broke the old inline reassembly: a round trip's
    // turnaround is the boundary between two journeys, not a stop within one.
    expect(classifyFlight({
      journeys: [
        { origin: { code: 'DEL' }, destination: { code: 'DXB' }, stops: [] },
        { origin: { code: 'DXB' }, destination: { code: 'DEL' }, stops: [] },
      ],
    })).toBe('international')
  })

  it('a domestic round trip stays domestic', () => {
    expect(classifyFlight({
      journeys: [
        { origin: { code: 'DEL' }, destination: { code: 'BOM' }, stops: [] },
        { origin: { code: 'BOM' }, destination: { code: 'DEL' }, stops: [] },
      ],
    })).toBe('domestic')
  })

  it('falls back to the flat fields for bookings frozen before journeys existed', () => {
    // An e-ticket is a permanent record; old bookings still have to classify.
    expect(classifyFlight({
      origin: { code: 'DEL' },
      destination: { code: 'BOM' },
      stops: [],
    })).toBe('domestic')

    expect(classifyFlight({
      origin: { code: 'DEL' },
      destination: { code: 'DXB' },
      stops: [],
    })).toBe('international')
  })

  it('classifies as international when the route is unknown entirely', () => {
    expect(classifyFlight({})).toBe('international')
  })
})

describe('advanceBookingDays', () => {
  it('counts whole days from now to departure', () => {
    const now = new Date(2026, 0, 1)
    expect(advanceBookingDays('11/01/2026', now)).toBe(10)
  })

  it('returns 0 for today', () => {
    const now = new Date(2026, 0, 1)
    expect(advanceBookingDays('01/01/2026', now)).toBe(0)
  })

  it('never returns a negative for a past date', () => {
    // A past departure is 0 days of advance booking, not -5.
    const now = new Date(2026, 0, 10)
    expect(advanceBookingDays('05/01/2026', now)).toBe(0)
  })

  it('reads DD/MM/YYYY, not MM/DD/YYYY', () => {
    // The provider's own format. Reading it the American way would put this
    // date in December.
    const now = new Date(2026, 0, 1)
    expect(advanceBookingDays('02/03/2026', now)).toBe(60)
  })
})

describe('longestLegHours', () => {
  it('returns the longest single duration in hours', () => {
    expect(longestLegHours(['02:30', '04:15', '01:00'])).toBeCloseTo(4.25, 2)
  })

  it('returns 0 for no durations', () => {
    expect(longestLegHours([])).toBe(0)
  })
})
