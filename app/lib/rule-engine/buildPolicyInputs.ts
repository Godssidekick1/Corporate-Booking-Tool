import { classifyFlight } from './classifyTrip'
import type { FlatFlightResult, PenaltyLine } from '@/app/lib/book/types'

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
  // The airline's cancellation fees for this fare (pricing's CancelPenalty).
  // Absent: max_cancel_penalty is not checked, unless the fare is non-refundable.
  cancelPenalties?: PenaltyLine[]
  // "Now", for the advance-booking count. Defaults to the real clock; tests
  // pass a fixed one.
  now?: Date
}

// ── daysAhead ────────────────────────────────────────────────────────────
// Whole calendar days from today to the first departure, both read as dates in
// India (the provider sends local times as "YYYY-MM-DDTHH:MM:SS", no zone).
// A flight tonight is 0 days ahead, tomorrow morning 1. Null when there is no
// usable departure date, so the check is skipped rather than guessed.
// ─────────────────────────────────────────────────────────────────────────────

function daysAhead(departure: string | undefined, now: Date): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(departure ?? '')
  if (!match) return null
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(now)
  const [y, m, d] = today.split('-').map(Number)
  const days = (Date.UTC(+match[1], +match[2] - 1, +match[3]) - Date.UTC(y, m - 1, d)) / 86_400_000
  return Number.isFinite(days) ? Math.round(days) : null
}

// ── longestLayoverHours ──────────────────────────────────────────────────────
// The longest wait at any stop, in any direction: from landing to taking off
// again at the same airport, so both times are local to it and subtract
// directly. Null when no stop carries both times.
// ─────────────────────────────────────────────────────────────────────────────

function longestLayoverHours(flight: FlatFlightResult): number | null {
  const stops = flight.journeys?.length ? flight.journeys.flatMap(j => j.stops ?? []) : flight.stops ?? []
  let longest: number | null = null
  for (const s of stops) {
    const arrived = Date.parse(s.arrivalDateTime)
    const leaves = s.departureDateTime ? Date.parse(s.departureDateTime) : NaN
    if (!Number.isFinite(arrived) || !Number.isFinite(leaves) || leaves < arrived) continue
    const hours = (leaves - arrived) / 3_600_000
    longest = Math.max(longest ?? 0, hours)
  }
  return longest === null ? null : Math.round(longest * 100) / 100
}

// ── cancelPenaltyAmount ──────────────────────────────────────────────────────
// What cancelling would cost, in rupees. A non-refundable fare loses the whole
// fare. Otherwise the airline's fee lines, as it sends them ("INR3000", "0"):
// the adult lines when there are any, the highest one. A fee in another
// currency or in words is not read, so the check is skipped, not guessed.
// ─────────────────────────────────────────────────────────────────────────────

function cancelPenaltyAmount(lines: PenaltyLine[] | undefined, isRefundable: boolean, totalFare: number): number | null {
  if (!isRefundable) return totalFare
  if (!lines?.length) return null
  const adult = lines.filter(l => l.paxType === 'ADT')
  const amounts = (adult.length ? adult : lines)
    .map(l => /^(?:INR\s*)?(\d+(?:\.\d+)?)$/i.exec(l.text.trim()))
    .filter((m): m is RegExpExecArray => m !== null)
    .map(m => Number(m[1]))
  return amounts.length ? Math.max(...amounts) : null
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
  const { flight, totalFare, isRefundable, selectedSeatFees, cancelPenalties, now = new Date() } = source

  // Amadeus sends fare/fee amounts as strings, matching the pattern already
  // seen elsewhere in this codebase (fare totals, taxes, etc.) — never
  // trust these as pre-parsed numbers. Non-numeric or missing fees are
  // treated as 0 rather than dropped, so a single malformed fee doesn't
  // silently exclude an otherwise-real charge from the policy total.
  const seatFeeTotal = (selectedSeatFees ?? []).reduce((sum, fee) => {
    const n = Number(fee)
    return sum + (Number.isFinite(n) ? n : 0)
  }, 0)

  // Route reassembly moved into classifyFlight so the ticketing gate can reach
  // the same answer. Two copies of "which legs is this trip made of" would mean
  // a booking that is domestic for policy and international for ticketing.
  const classification = classifyFlight(flight)
  const travelType = classification === 'domestic' ? 'flight_domestic' : 'flight_international'

  // Falls back to the first-leg-only `duration` if totalDuration wasn't
  // populated (e.g. an older cached FlatFlightResult from sessionStorage,
  // saved before this field existed, or a provider response that omitted
  // TotalDuration). That fallback under-counts layover time on connecting
  // itineraries, but a same-order-of-magnitude estimate beats treating the
  // trip as 0 hours and defaulting every connecting flight to short-haul.
  //
  // Measured per DIRECTION and the longest one wins. Long-haul cabin rules are
  // about how long someone sits in a seat at a stretch, so a 10-hour outbound
  // paired with a 3-hour return is a long-haul trip — not a 13-hour one, and
  // not a 10-hour one only if the outbound happens to be listed first.
  const journeyDurations = flight.journeys?.length
    ? flight.journeys.map(j => journeyHours(j.totalDuration ?? j.duration))
    : [journeyHours(flight.totalDuration ?? flight.duration)]
  const hours = Math.max(...journeyDurations)
  const isLongHaul = hours > 8
  const cabinLimitKey = isLongHaul ? 'cabin_class_long_haul' : 'cabin_class_short_haul'

  // A connection is an intermediate stop WITHIN a direction. A round trip's
  // turnaround is not one: it is where the outbound ends. Reading the
  // flight-level stopCount would have counted it, and flagged every non-stop
  // return as a connecting flight.
  const stops = flight.journeys?.length
    ? Math.max(...flight.journeys.map(j => j.stopCount ?? 0))
    : flight.stopCount ?? 0

  const advance = daysAhead(flight.journeys?.[0]?.origin?.dateTime ?? flight.origin?.dateTime, now)
  const layover = longestLayoverHours(flight)
  const cancelFee = cancelPenaltyAmount(cancelPenalties, isRefundable, totalFare)

  return {
    travelType,
    totalCost: totalFare,
    numericValues: {
      [classification === 'domestic' ? 'max_fare_domestic' : 'max_fare_intl']: totalFare,
      max_seat_selection_fee: seatFeeTotal,
      max_stops: stops,
      // Read from the flight itself (its departure as the provider sent it),
      // not from the search form, whose date format is display-only.
      ...(advance !== null ? { advance_booking_days: advance } : {}),
      ...(hours > 0 ? { max_journey_hours: Math.round(hours * 100) / 100 } : {}),
      ...(layover !== null ? { max_layover_hours: layover } : {}),
      ...(cancelFee !== null ? { max_cancel_penalty: cancelFee } : {}),
    },
    booleanValues: {
      // What the fare IS, not an entitlement used: evaluateBooking compares it
      // with refundable_fare_required.
      refundable_fare: isRefundable,
    },
    tierValues: {
      [cabinLimitKey]: cabinRank(flight.cabin),
      // 0 = budget (low-cost carrier), 1 = full-service, as CARRIER_OPTIONS.
      carrier_tier: flight.isLcc ? 0 : 1,
    },
  }
}