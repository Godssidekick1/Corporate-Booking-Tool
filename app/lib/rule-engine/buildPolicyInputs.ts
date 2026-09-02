import { classifyTrip } from './classifyTrip'
import type { FlatFlightResult } from '@/app/lib/book/types'

// ── CABIN_RANK ────────────────────────────────────────────────────────────
// Mirrors CABIN_CLASS_OPTIONS in app/tmc/configurations/policy/page.tsx exactly —
// 0=Economy, 1=Premium Economy, 2=Business, 3=First. Amadeus's own `cabin`
// field on FlatFlightResult is free text and its exact vocabulary varies by
// provider, so this is a best-effort match, defaulting to Economy (0) for
// anything unrecognized rather than throwing — an unmapped cabin string
// should never crash a booking, just fail open to the lowest tier so real
// upgrades still get caught on the numeric fare check.
// ─────────────────────────────────────────────────────────────────────────────

function cabinRank(cabin: string | undefined): number {
  const normalized = (cabin ?? '').trim().toLowerCase()
  if (normalized.includes('first')) return 3
  if (normalized.includes('business')) return 2
  if (normalized.includes('premium')) return 1
  return 0
}

// ── journeyHours ─────────────────────────────────────────────────────────
// Parses an "HH:MM" duration string into decimal hours. Used against
// flight.totalDuration, which — per confirmed Amadeus UAT trace and explicit
// product guidance — already includes layover/ground time between
// connecting flights, not just airborne time. That's the intended
// definition of "how long is this trip" for the long-haul/short-haul cabin
// policy check: a 3h flight + 5h layover + 4h flight (12h total) should be
// judged as a long-haul trip, not a short-haul one, even though no single
// flight segment exceeds 8 hours.
// ─────────────────────────────────────────────────────────────────────────────

function journeyHours(duration: string | undefined): number {
  if (!duration) return 0
  const [h, m] = duration.split(':').map(Number)
  return (h ?? 0) + (m ?? 0) / 60
}

export interface PolicyInputSource {
  flight: FlatFlightResult
  totalFare: number
  isRefundable: boolean
  // All seats selected across every passenger and leg, flat — only their
  // fees matter for max_seat_selection_fee, so callers don't need to group
  // by passenger. Omit or pass [] if nothing's been picked yet (no seat
  // selection made is not a policy violation).
  selectedSeatFees?: string[]
}

export interface BuiltPolicyInputs {
  travelType: 'flight_domestic' | 'flight_international'
  totalCost: number
  numericValues: Partial<Record<string, number>>
  booleanValues: Partial<Record<string, boolean>>
  tierValues: Partial<Record<string, number>>
}

// ── buildPolicyInputsFromFlight ───────────────────────────────────────────────
// The only travel type wired up end-to-end today is flights (matches the
// booking flow's current scope — hotels/cars aren't bookable yet). Extend
// with buildPolicyInputsFromHotel / buildPolicyInputsFromCar alongside those
// booking flows when they exist, rather than overloading this one function.
// ─────────────────────────────────────────────────────────────────────────────

export function buildPolicyInputsFromFlight(source: PolicyInputSource): BuiltPolicyInputs {
  const { flight, totalFare, isRefundable, selectedSeatFees } = source

  // Amadeus sends fare/fee amounts as strings, matching the pattern already
  // seen elsewhere in this codebase (fare totals, taxes, etc.) — never
  // trust these as pre-parsed numbers. Non-numeric or missing fees are
  // treated as 0 rather than dropped, so a single malformed fee doesn't
  // silently exclude an otherwise-real charge from the policy total.
  const seatFeeTotal = (selectedSeatFees ?? []).reduce((sum, fee) => {
    const n = Number(fee)
    return sum + (Number.isFinite(n) ? n : 0)
  }, 0)

  const legs = [
    { origin: flight.origin?.code ?? '', destination: flight.destination?.code ?? '' },
    ...flight.stops.map((s, i) => ({
      origin: i === 0 ? (flight.origin?.code ?? '') : flight.stops[i - 1].code,
      destination: s.code,
    })),
  ].filter(l => l.origin && l.destination)

  const classification = classifyTrip(legs.length > 0 ? legs : [{ origin: flight.origin?.code ?? '', destination: flight.destination?.code ?? '' }])
  const travelType = classification === 'domestic' ? 'flight_domestic' : 'flight_international'

  // Falls back to the first-leg-only `duration` if totalDuration wasn't
  // populated (e.g. an older cached FlatFlightResult from sessionStorage,
  // saved before this field existed, or a provider response that omitted
  // TotalDuration). That fallback under-counts layover time on connecting
  // itineraries, but a same-order-of-magnitude estimate beats treating the
  // trip as 0 hours and defaulting every connecting flight to short-haul.
  const hours = journeyHours(flight.totalDuration ?? flight.duration)
  const isLongHaul = hours > 8
  const cabinLimitKey = isLongHaul ? 'cabin_class_long_haul' : 'cabin_class_short_haul'

  return {
    travelType,
    totalCost: totalFare,
    numericValues: {
      [classification === 'domestic' ? 'max_fare_domestic' : 'max_fare_intl']: totalFare,
      max_seat_selection_fee: seatFeeTotal,
      // advance_booking_days deliberately omitted here: it needs the
      // original search's departDate in a confirmed DD/MM/YYYY format, and
      // no current call site reliably threads that through (flowStorage's
      // SearchMeta.departDate is only loosely documented as "display-
      // formatted"). Wire this once the passengers page is confirmed to
      // pass a real DD/MM/YYYY string — guessing the format risks flagging
      // every booking as an advance-booking violation.
    },
    booleanValues: {
      // refundable_fare_required deliberately omitted: its actual-value
      // polarity (does "used=true" mean "booked non-refundable" or "booked
      // refundable"?) is ambiguous against evaluateBooking's used-and-not-
      // allowed check, and tmc/settings/policy/page.tsx notes it isn't
      // reliably wired end-to-end yet. Revisit once that's confirmed rather
      // than risk false breaches here.
      connecting_flights_allowed: flight.stopCount > 0,
    },
    tierValues: {
      [cabinLimitKey]: cabinRank(flight.cabin),
    },
  }
}