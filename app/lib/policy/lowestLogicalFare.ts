import type { FlatFlightResult } from '@/app/lib/book/types'

// ── Lowest logical fare ──────────────────────────────────────────────────────
// A fare costs more than one the traveller was also shown, on the same route,
// departing within N minutes of it (the group's lowest_fare_window_minutes).
// That fare needs approval: it is not out of policy, but someone should see
// that a cheaper, equally convenient one was there.
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
  origin: string
  destination: string
  journeys: number         // one-way 1, round trip 2
  label: string            // "AI 101", for the reason line
  fares: { pricingKey: string; total: number }[]
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
    const fares = r.fareOptions
      .filter(f => typeof f.totalFare === 'number' && f.pricingKey)
      .map(f => ({ pricingKey: f.pricingKey, total: f.totalFare as number }))
    if (fares.length === 0) return []
    const leg = r.legs?.[0]
    const label = [leg?.airlineCode ?? r.airline?.code, leg?.flightNumber].filter(Boolean).join(' ')
    return [{ flightKey: r.flightKey, departure, origin, destination, journeys: r.journeys?.length || 1, label, fares }]
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

  let best: CheaperNearby | null = null
  for (const f of shown) {
    if (f.flightKey === chosen.flightKey) continue
    if (f.origin !== chosen.origin || f.destination !== chosen.destination || f.journeys !== chosen.journeys) continue
    const dep = Date.parse(f.departure)
    if (!Number.isFinite(dep) || Math.abs(dep - at) > windowMinutes * 60_000) continue
    const cheapest = Math.min(...f.fares.map(x => x.total))
    // At least a rupee: rounding is not a cheaper fare.
    if (cheapest > chosenFare.total - 1) continue
    if (!best || cheapest < best.total) {
      best = { chosenTotal: chosenFare.total, total: cheapest, departure: f.departure, label: f.label }
    }
  }
  return best
}
