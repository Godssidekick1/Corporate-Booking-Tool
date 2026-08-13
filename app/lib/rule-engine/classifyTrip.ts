// ── Trip classification for the rule engine ──────────────────────────────────
// Amadeus airport objects only carry AirportCode/AirportName/CityName -- no
// country code -- so domestic vs. international has to be inferred from the
// airport codes themselves. This list is a real starting point covering every
// Indian airport seen in testing so far, NOT an exhaustive IATA database.
// Extend it directly as new airports show up in real search results, the
// same way locations.ts was flagged as incomplete-by-design rather than
// silently wrong.
const INDIAN_AIRPORT_CODES = new Set([
  'DEL', 'BOM', 'BLR', 'MAA', 'CCU', 'HYD', 'AMD', 'COK', 'TRV', 'GOI',
  'PNQ', 'JAI', 'ATQ', 'IXC', 'LKO', 'PAT', 'GAU', 'IXR', 'VNS', 'IDR',
  'NAG', 'RPR', 'BBI', 'IXB', 'SXR', 'IXJ', 'IXA', 'BHO', 'STV', 'UDR',
])

export function isIndianAirport(code: string): boolean {
  return INDIAN_AIRPORT_CODES.has(code.toUpperCase())
}

// A leg is domestic only if BOTH ends are Indian airports. A single
// international leg anywhere in the itinerary makes the whole trip
// international for policy purposes (matches how max_fare_intl/cabin_class_
// long_haul are meant to apply -- one long leg is enough to trigger them).
export function classifyTrip(legs: Array<{ origin: string; destination: string }>): 'domestic' | 'international' {
  const allDomestic = legs.every(
    leg => isIndianAirport(leg.origin) && isIndianAirport(leg.destination)
  )
  return allDomestic ? 'domestic' : 'international'
}

// departDate: dd/MM/yyyy (Amadeus's own format, as sent in the search request)
export function advanceBookingDays(departDate: string, now: Date = new Date()): number {
  const [day, month, year] = departDate.split('/').map(Number)
  const depart = new Date(year, month - 1, day)
  const diffMs = depart.getTime() - now.getTime()
  return Math.max(0, Math.floor(diffMs / (1000 * 60 * 60 * 24)))
}

// Longest single leg duration, in hours. NOT currently used for the
// short-haul/long-haul cabin policy check — that's now
// buildPolicyInputs.ts's journeyHours(flight.totalDuration), which
// deliberately includes layover time (per explicit product/mentor
// guidance: a long layover makes it a "long" trip even if no single
// airborne segment exceeds 8 hours). Kept here in case a future policy
// field genuinely wants "longest single flight segment" as a distinct
// concept from "total journey time" — don't wire this back into the cabin
// check without re-confirming that's actually wanted, since the two
// definitions now disagree by design.
export function longestLegHours(durations: string[]): number {
  let max = 0
  for (const d of durations) {
    const [h, m] = d.split(':').map(Number)
    const hours = (h ?? 0) + (m ?? 0) / 60
    if (hours > max) max = hours
  }
  return max
}