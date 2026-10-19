// ── What a traveller's policy lets them see ──────────────────────────────────
// Blocked airlines and fare types outside the allowed list are not a breach to
// approve: those fares are simply not offered. They are taken out of the search
// results on the server (so no screen can show them by mistake), and price and
// add-passenger refuse them, for a fare that reaches those steps another way
// (a stale tab, a shared link, a request built by hand).
//
// Preferred airlines are only marked, never favoured in price or order: the
// traveller still sees the cheapest fare first, with "Preferred" beside it.
//
// Pure. The traveller's lists come from policyListsFor
// (app/lib/rule-engine/policyLists.ts).
// ─────────────────────────────────────────────────────────────────────────────

import type { FareOption, FlatFlightResult } from '@/app/lib/book/types'
import { fareTypeOf, FARE_TYPE_LABEL } from './fareTypes'

export interface PolicyLists {
  blockedAirlines: string[]
  preferredAirlines: string[]
  // Empty: every fare type is allowed.
  allowedFareTypes: string[]
}

export const NO_LISTS: PolicyLists = { blockedAirlines: [], preferredAirlines: [], allowedFareTypes: [] }

export function hasLists(lists: PolicyLists): boolean {
  return lists.blockedAirlines.length > 0 || lists.preferredAirlines.length > 0 || lists.allowedFareTypes.length > 0
}

// Every carrier that flies any part of the trip: each flown leg, and each
// direction's own airline for an itinerary without leg detail. A codeshare leg
// flown by a blocked carrier is still that carrier's seat.
export function airlinesOf(flight: Pick<FlatFlightResult, 'journeys' | 'legs' | 'airline'>): string[] {
  const codes = new Set<string>()
  for (const leg of flight.legs ?? []) if (leg.airlineCode) codes.add(leg.airlineCode.toUpperCase())
  for (const j of flight.journeys ?? []) {
    if (j.airline?.code) codes.add(j.airline.code.toUpperCase())
    for (const leg of j.legs ?? []) if (leg.airlineCode) codes.add(leg.airlineCode.toUpperCase())
  }
  if (flight.airline?.code) codes.add(flight.airline.code.toUpperCase())
  return [...codes]
}

export function blockedAirline(flight: Pick<FlatFlightResult, 'journeys' | 'legs' | 'airline'>, lists: PolicyLists): string | null {
  if (lists.blockedAirlines.length === 0) return null
  return airlinesOf(flight).find(code => lists.blockedAirlines.includes(code)) ?? null
}

export function fareAllowed(fare: Pick<FareOption, 'fareType' | 'brandedFareName' | 'isNdc'>, lists: PolicyLists): boolean {
  return lists.allowedFareTypes.length === 0 || lists.allowedFareTypes.includes(fareTypeOf(fare))
}

// ── filterResults ────────────────────────────────────────────────────────────
// Drops flights on a blocked airline and fare options of a disallowed type,
// then drops flights left with no fare. The flight-level price fields mirror
// fareOptions[0], so they are re-pointed at the first fare that survived:
// otherwise the result card would show the price of a fare that was removed.
// ─────────────────────────────────────────────────────────────────────────────
export function filterResults(flights: FlatFlightResult[], lists: PolicyLists): FlatFlightResult[] {
  if (!hasLists(lists)) return flights
  const out: FlatFlightResult[] = []
  for (const flight of flights) {
    if (blockedAirline(flight, lists)) continue
    const fares = flight.fareOptions.filter(f => fareAllowed(f, lists))
    if (fares.length === 0) continue
    const first = fares[0]
    const preferred = airlinesOf(flight).some(code => lists.preferredAirlines.includes(code))
    out.push({
      ...flight,
      fareOptions: fares,
      pricingKey: first.pricingKey,
      currency: first.currency,
      totalFare: first.totalFare,
      baseFare: first.baseFare,
      isNdc: first.isNdc,
      refundable: first.refundable,
      ...(preferred ? { preferred: true } : {}),
    })
  }
  return out
}

// ── refusalFor ───────────────────────────────────────────────────────────────
// The reason a fare cannot be priced or booked for this traveller, or null.
// `fare` is the option being priced; when it is not known, every option the
// flight carries must be disallowed for the fare-type rule to refuse.
// ─────────────────────────────────────────────────────────────────────────────
export function refusalFor(
  flight: Pick<FlatFlightResult, 'journeys' | 'legs' | 'airline' | 'fareOptions'>,
  fare: Pick<FareOption, 'fareType' | 'brandedFareName' | 'isNdc'> | null,
  lists: PolicyLists,
): string | null {
  const airline = blockedAirline(flight, lists)
  if (airline) return `The traveller's travel policy does not allow ${airline} flights.`
  if (lists.allowedFareTypes.length === 0) return null
  const options = fare ? [fare] : flight.fareOptions ?? []
  if (options.length > 0 && !options.some(f => fareAllowed(f, lists))) {
    const type = FARE_TYPE_LABEL[fareTypeOf(options[0])] ?? 'this'
    return `The traveller's travel policy does not allow ${type} fares.`
  }
  return null
}
