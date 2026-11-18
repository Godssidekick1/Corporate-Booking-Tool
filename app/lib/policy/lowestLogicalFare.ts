import type { FlatFlightResult } from '@/app/lib/book/types'

// ── Lowest logical fare ──────────────────────────────────────────────────────
// A fare costs more than one the traveller was also shown, on the same route,
// departing within N minutes of it (the group's lowest_fare_window_minutes).
// That fare needs approval: it is not out of policy, but someone should see
// that a cheaper, equally convenient one was there.
//
// A round trip is compared in both directions: a cheaper one counts only
// when its return also leaves within the window of the chosen return, so a
// fare that is cheaper because it flies back at a worse time is not "the
// same trip for less".
//
// Both prices come from the SAME search response, as the traveller saw them
// (airline fare plus markup), so they are compared on one basis. The quote's
// sell total also carries discount and fee, which search rows do not.
// Departures are the provider's local times at the same origin, so they
// subtract directly.
// ─────────────────────────────────────────────────────────────────────────────

export interface ShownFlight {
  flightKey: string
  departure: string        // outbound, local to the origin
  returnDeparture?: string // the return's, on a round trip
  origin: string
  destination: string
  journeys: number         // one-way 1, round trip 2
  label: string            // "AI 101", for the reason line
  fares: ShownFare[]
  // For the approver's list of cheaper options (choiceContext). Optional:
  // searches saved before these existed carry none of them.
  arrival?: string         // the outbound's, local to the destination
  stops?: number           // the outbound's
  duration?: string        // the outbound's, as the airline gives it ("02:10")
}

export interface ShownFare {
  pricingKey: string
  total: number
  name?: string            // the brand (ECO VALUE), else the fare type
  refundable?: boolean
  policy?: 'green' | 'amber' | 'red'   // the traveller's verdict, as search judged it
}

export interface CheaperNearby {
  chosenTotal: number
  total: number
  departure: string
  label: string
}

// What a search showed, compact enough to keep (search_fares.flights).
export function shownFlights(results: FlatFlightResult[]): ShownFlight[] {
  return results.flatMap(r => {
    const out = r.journeys?.[0]
    const departure = out?.origin?.dateTime ?? r.origin?.dateTime
    const origin = out?.origin?.code ?? r.origin?.code
    const destination = out?.destination?.code ?? r.destination?.code
    if (!departure || !origin || !destination) return []
    // What the company would pay for each (the sell estimate), so "cheaper"
    // means cheaper to the company: a fare with a bigger discount can be the
    // cheaper one at the same airline price.
    const fares = r.fareOptions
      .map(f => ({
        pricingKey: f.pricingKey, total: f.sellEstimate ?? f.totalFare,
        ...(f.brandedFareName || f.brandedFareDescription || f.fareType ? { name: f.brandedFareName || f.brandedFareDescription || f.fareType } : {}),
        ...(typeof f.refundable === 'boolean' ? { refundable: f.refundable } : {}),
        ...(f.policy ? { policy: f.policy } : {}),
      }))
      .filter((f): f is ShownFare => typeof f.total === 'number' && Boolean(f.pricingKey))
    if (fares.length === 0) return []
    const leg = r.legs?.[0]
    const label = [leg?.airlineCode ?? r.airline?.code, leg?.flightNumber].filter(Boolean).join(' ')
    const returnDeparture = r.journeys?.[1]?.origin?.dateTime
    const arrival = out?.destination?.dateTime ?? r.destination?.dateTime
    const duration = out?.totalDuration ?? out?.duration
    return [{
      flightKey: r.flightKey, departure, origin, destination, journeys: r.journeys?.length || 1, label, fares,
      ...(returnDeparture ? { returnDeparture } : {}),
      ...(arrival ? { arrival } : {}),
      ...(typeof out?.stopCount === 'number' ? { stops: out.stopCount } : {}),
      ...(duration ? { duration } : {}),
    }]
  })
}

// The cheapest fare on another flight, same route and shape, departing within
// windowMinutes of the chosen one and cheaper than the chosen fare. Null when
// there is none, or the chosen fare is not in what was shown.
export function cheaperNearby(
  shown: ShownFlight[],
  flightKey: string,
  pricingKey: string,
  windowMinutes: number,
): CheaperNearby | null {
  const chosen = shown.find(f => f.flightKey === flightKey)
  const chosenFare = chosen?.fares.find(f => f.pricingKey === pricingKey)
  if (!chosen || !chosenFare || !(windowMinutes > 0)) return null
  const at = Date.parse(chosen.departure)
  if (!Number.isFinite(at)) return null
  const window = windowMinutes * 60_000
  const backAt = chosen.returnDeparture ? Date.parse(chosen.returnDeparture) : NaN

  let best: CheaperNearby | null = null
  for (const f of shown) {
    if (f.flightKey === chosen.flightKey) continue
    if (f.origin !== chosen.origin || f.destination !== chosen.destination || f.journeys !== chosen.journeys) continue
    const dep = Date.parse(f.departure)
    if (!Number.isFinite(dep) || Math.abs(dep - at) > window) continue
    // A round trip: the return within the window too, when both carry one.
    if (Number.isFinite(backAt)) {
      const back = f.returnDeparture ? Date.parse(f.returnDeparture) : NaN
      if (!Number.isFinite(back) || Math.abs(back - backAt) > window) continue
    }
    const cheapest = Math.min(...f.fares.map(x => x.total))
    // At least a rupee: rounding is not a cheaper fare.
    if (cheapest > chosenFare.total - 1) continue
    if (!best || cheapest < best.total) {
      best = { chosenTotal: chosenFare.total, total: cheapest, departure: f.departure, label: f.label }
    }
  }
  return best
}

// ── What the chosen fare was picked from (bookings.choice_context) ───────────
// For the approver: was there a cheaper sensible option? Not the whole search
// (the approver is not redoing it), just the two comparisons that answer it:
// the cheapest fare on the same flight, and the cheapest flight on the same
// route and shape. All figures are the search's sell estimates, so the
// comparison is like with like, and never the airline's figure.

export interface ChoiceContext {
  chosen: { total: number; name: string | null; refundable: boolean | null; label: string; departure: string }
  flightsShown: number
  // Null when the chosen fare is already the cheapest on its flight.
  cheaperOnFlight: { total: number; fares: number } | null
  // Null when the chosen flight already carries the cheapest fare.
  cheapestFlight: { total: number; label: string; departure: string } | null
  // The cheaper options the traveller passed over, cheapest first: other
  // fares on the same flight, and each other flight's cheapest fare below the
  // chosen one. At most CHEAPER_SHOWN; cheaperCount says how many there were.
  // Absent on bookings saved before this existed.
  cheaper?: CheaperOption[]
  cheaperCount?: number
  savedAt: string
}

export interface CheaperOption {
  sameFlight: boolean
  label: string
  departure: string
  arrival?: string
  stops?: number
  duration?: string
  total: number
  saving: number
  fare?: string
  refundable?: boolean
  policy?: 'green' | 'amber' | 'red'
}

export const CHEAPER_SHOWN = 5

export function choiceContext(
  shown: ShownFlight[],
  flightKey: string,
  pricingKey: string,
  fare: { name?: string | null; refundable?: boolean | null },
  now: Date = new Date(),
): ChoiceContext | null {
  const chosen = shown.find(f => f.flightKey === flightKey)
  const chosenFare = chosen?.fares.find(f => f.pricingKey === pricingKey)
  if (!chosen || !chosenFare) return null
  const comparable = shown.filter(f =>
    f.origin === chosen.origin && f.destination === chosen.destination && f.journeys === chosen.journeys && f.fares.length > 0)
  const cheapestOf = (f: ShownFlight) => Math.min(...f.fares.map(x => x.total))

  const flightLow = cheapestOf(chosen)
  let best: ShownFlight | null = null
  for (const f of comparable) if (!best || cheapestOf(f) < cheapestOf(best)) best = f
  const bestTotal = best ? cheapestOf(best) : chosenFare.total

  // Every cheaper option, by at least a rupee (rounding is not cheaper): the
  // same flight's other fares one by one (Saver vs Flex is the choice there),
  // and from each other flight only its cheapest fare (one row per flight).
  const option = (f: ShownFlight, x: ShownFare): CheaperOption => ({
    sameFlight: f.flightKey === chosen.flightKey, label: f.label, departure: f.departure,
    ...(f.arrival ? { arrival: f.arrival } : {}),
    ...(typeof f.stops === 'number' ? { stops: f.stops } : {}),
    ...(f.duration ? { duration: f.duration } : {}),
    total: x.total, saving: Math.round((chosenFare.total - x.total) * 100) / 100,
    ...(x.name ? { fare: x.name } : {}),
    ...(typeof x.refundable === 'boolean' ? { refundable: x.refundable } : {}),
    ...(x.policy ? { policy: x.policy } : {}),
  })
  const cheaperAll: CheaperOption[] = []
  for (const f of comparable) {
    if (f.flightKey === chosen.flightKey) {
      for (const x of f.fares) if (x.pricingKey !== chosenFare.pricingKey && x.total < chosenFare.total - 1) cheaperAll.push(option(f, x))
    } else {
      const low = f.fares.reduce((m, x) => (x.total < m.total ? x : m))
      if (low.total < chosenFare.total - 1) cheaperAll.push(option(f, low))
    }
  }
  cheaperAll.sort((x, y) => x.total - y.total || x.departure.localeCompare(y.departure))

  return {
    chosen: {
      total: chosenFare.total, name: fare.name ?? null, refundable: fare.refundable ?? null,
      label: chosen.label, departure: chosen.departure,
    },
    cheaper: cheaperAll.slice(0, CHEAPER_SHOWN),
    cheaperCount: cheaperAll.length,
    flightsShown: comparable.length,
    // At least a rupee: rounding is not a cheaper fare.
    cheaperOnFlight: flightLow < chosenFare.total - 1 ? { total: flightLow, fares: chosen.fares.length } : null,
    cheapestFlight: best && best.flightKey !== chosen.flightKey && bestTotal < flightLow - 1
      ? { total: bestTotal, label: best.label, departure: best.departure }
      : null,
    savedAt: now.toISOString(),
  }
}
