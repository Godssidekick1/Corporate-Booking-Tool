// ── What a traveller may see of a frozen booking ─────────────────────────────
// THE LEAK THIS CLOSES: bookings.fare_breakdown.passengerBreakup is the
// AIRLINE's per-passenger split, frozen verbatim at add-passenger. Sent to a
// traveller beside the sell total -- as /api/bookings and /api/bookings/recent
// did -- it makes a markup one subtraction away, and a markup that is
// discoverable in a network response is not hidden, whatever the UI renders.
// (The booking detail route already scaled it onto the sell side; the list
// routes passed it through.)
//
// The itinerary is projected too, as defence in depth rather than a known
// leak: search marks up its fareOptions before the browser ever holds them,
// so the frozen fares are sell-side. But it also carries pricingKey, a
// provider session credential with no business in a browser, and whatever
// the provider mapping adds next.
//
// ALLOWLISTS, NOT DENYLISTS: a field added later must be hidden until someone
// decides it is safe, not shown until someone notices it is not. Every key
// below is one a screen actually reads (route, times, cabin, baggage) or
// carries no money.
//
// Used by every traveller-facing route that returns a stored booking. The
// TMC side is unaffected: it may see the airline's figures.
// ─────────────────────────────────────────────────────────────────────────────

const ITINERARY_KEYS = [
  'provider', 'airline', 'origin', 'destination', 'journeys', 'legs', 'stops', 'stopCount',
  'duration', 'totalDuration', 'cabin', 'bookingCode', 'isLcc', 'isNdc', 'refundable',
  'checkInBaggageKg', 'cabinBaggageKg', 'checkInBaggagePieces', 'cabinBaggagePieces', 'currency',
] as const

const FARE_BREAKDOWN_KEYS = ['currency', 'fareType', 'isRefundable', 'seatFees'] as const

function pick(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const source = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of keys) {
    if (key in source) out[key] = source[key]
  }
  return out
}

// The itinerary without its fares or provider session keys.
export function travellerItinerary(itinerary: unknown): Record<string, unknown> | null {
  return pick(itinerary, ITINERARY_KEYS)
}

// The fare breakdown without the airline's per-passenger figures. Routes that
// show a per-passenger split (the booking detail) scale it onto the sell side
// themselves and add it back.
export function travellerFareBreakdown(fareBreakdown: unknown): Record<string, unknown> | null {
  return pick(fareBreakdown, FARE_BREAKDOWN_KEYS)
}
