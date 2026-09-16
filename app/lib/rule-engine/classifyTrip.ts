import { AIRPORTS } from '@/app/lib/data/locations'

// ── Trip classification for the rule engine ──────────────────────────────────
// Amadeus airport objects only carry AirportCode/AirportName/CityName -- no
// country code -- so domestic vs. international has to be inferred from the
// airport codes themselves. AIRPORTS is curated rather than exhaustive, so an
// airport it has never heard of reads as international — the safe direction to
// be wrong in, since it asks for a passport that is not needed rather than
// skipping one that is.
//
// DERIVED from AIRPORTS, not a second hand-maintained list.
//
// It used to be a literal set of 30 codes sitting beside a separate list of 30
// in locations.ts, and the two had to be extended in step. They would not have
// been: adding Coimbatore to the dropdown alone would have made every DEL-CJB
// booking read as INTERNATIONAL — demanding passports, evaluating against
// max_fare_intl instead of max_fare_domestic, gating on intl_ticketing, and
// resolving deal codes and commercial rules against INTAIRBSP. All of that from
// an airport being added to one file and not the other.
//
// One list, one truth. Adding an airport to AIRPORTS is now the whole job.
const INDIAN_AIRPORT_CODES = new Set(
  AIRPORTS.filter(a => a.country === 'India').map(a => a.code)
)

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

// ── classifyFlight ───────────────────────────────────────────────────────────
// classifyTrip for a whole FlatFlightResult, rebuilding the leg list from the
// origin, the stops and the final destination.
//
// FlightLeg carries no airports — only carrier, flight number, RBD and cabin —
// so the route has to be reassembled from `stops`. That reassembly lived inline
// in buildPolicyInputs and is now needed again by the ticketing gate, which is
// exactly the point at which a copy would start to drift: a subtle difference in
// how the two count a connection would mean a booking that is domestic for
// policy and international for ticketing.
// ─────────────────────────────────────────────────────────────────────────────
export function classifyFlight(flight: {
  origin?: { code: string }
  destination?: { code: string }
  stops?: { code: string }[]
  journeys?: { origin?: { code: string }; destination?: { code: string }; stops?: { code: string }[] }[]
}): 'domestic' | 'international' {
  // Prefer the journeys, which state the route rather than implying it.
  //
  // The reassembly below was accidentally robust: for DEL→DXB→DEL it built a
  // bogus DEL→DEL leg alongside a real one, and `every()` still caught DXB, so
  // the ANSWER came out right for the wrong reason. It stops being robust the
  // moment `stops` stops meaning "every intermediate point in order" — which is
  // exactly what per-journey stops did, since a round trip's turnaround is no
  // longer in there. Read the legs where they are actually recorded.
  const journeys = flight.journeys ?? []
  if (journeys.length > 0) {
    const legs = journeys.flatMap(journey => {
      const points = [
        journey.origin?.code,
        ...(journey.stops ?? []).map(s => s.code),
        journey.destination?.code,
      ].filter((code): code is string => Boolean(code))

      return points.slice(0, -1).map((origin, i) => ({ origin, destination: points[i + 1] }))
    })

    if (legs.length > 0) return classifyTrip(legs)
  }

  const originCode = flight.origin?.code ?? ''
  const destinationCode = flight.destination?.code ?? ''
  const stops = flight.stops ?? []

  const legs = [
    { origin: originCode, destination: destinationCode },
    ...stops.map((s, i) => ({
      origin: i === 0 ? originCode : stops[i - 1].code,
      destination: s.code,
    })),
  ].filter(l => l.origin && l.destination)

  return classifyTrip(legs.length > 0 ? legs : [{ origin: originCode, destination: destinationCode }])
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