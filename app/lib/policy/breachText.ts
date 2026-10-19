// ── How a policy breach reads ────────────────────────────────────────────────
// One wording for a breach wherever it is shown: the approval reason stored on
// the approval row, and the fare, passenger and confirm pages. These used to be
// four copies of the same label map, and three of them had already fallen
// behind (no carrier, seat-fee or hotel labels), so a breach the engine raised
// showed up as its raw key.
//
// The wording for the older numeric and yes/no checks is unchanged on purpose:
// approval reasons already stored read the same as new ones. Two exceptions,
// both of which read wrongly before: advance booking said "exceeded" for a
// window that was too SHORT, and tiers showed rank numbers ("2") instead of
// their names ("Business").
// ─────────────────────────────────────────────────────────────────────────────

import { FIELD_BY_KEY } from './fields'

export interface BreachLike {
  limit_key: string
  kind: string
  policyValue: unknown
  actualValue: unknown
}

export const BREACH_LABELS: Record<string, string> = {
  max_fare_domestic: 'domestic fare limit',
  max_fare_intl: 'international fare limit',
  advance_booking_days: 'minimum advance booking window',
  max_rate_major_city: 'hotel rate limit (major city)',
  max_rate_other_city: 'hotel rate limit (other city)',
  max_hotel_stars: 'hotel star rating limit',
  max_car_rate_per_day: 'car rental daily rate limit',
  baggage_extra_bags: 'extra baggage allowance',
  per_diem_allowance: 'per diem allowance',
  max_trip_duration: 'maximum trip duration',
  breakfast_included: 'breakfast inclusion entitlement',
  sponsored_transport_allowed: 'sponsored transport entitlement',
  refundable_fare_required: 'refundable fare requirement',
  // Replaced by max_stops (migration 20261019000000); kept so bookings judged
  // before it still read properly.
  connecting_flights_allowed: 'connecting flights entitlement',
  max_stops: 'stop limit',
  max_journey_hours: 'journey time limit',
  red_eye_restricted: 'red-eye flight restriction',
  personal_trips_allowed: 'personal trips entitlement',
  cabin_class_short_haul: 'cabin class entitlement (short-haul)',
  cabin_class_long_haul: 'cabin class entitlement (long-haul)',
  seat_selection: 'seat selection entitlement',
  carrier_tier: 'preferred carrier tier',
  max_seat_selection_fee: 'seat selection spend limit',
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

export function breachLine(b: BreachLike): string {
  const label = BREACH_LABELS[b.limit_key] ?? b.limit_key
  const policy = Number(b.policyValue)
  const actual = Number(b.actualValue)

  // Each line starts with the label and never contains ";", which is what
  // joins several breaches into one approval reason.
  switch (b.limit_key) {
    case 'refundable_fare_required':
      return `${label} not met: this fare is non-refundable`
    case 'advance_booking_days':
      return `${label} not met: booked ${plural(actual, 'day', 'days')} ahead, the policy asks for at least ${plural(policy, 'day', 'days')}`
    case 'max_stops':
      return policy === 0
        ? `${label} exceeded: ${plural(actual, 'stop', 'stops')}, the policy allows non-stop flights only`
        : `${label} exceeded: ${plural(actual, 'stop', 'stops')}, the policy allows at most ${plural(policy, 'stop', 'stops')}`
    case 'max_journey_hours':
      return `${label} exceeded: a ${actual} h journey, the policy allows up to ${policy} h`
  }

  if (b.kind === 'boolean') return `${label} is not permitted for this employee`

  // A tier is a rank (0 = Economy, 1 = Premium Economy...). The rank numbers
  // mean nothing to a reader, so the field's own option names are shown.
  if (b.kind === 'tier') {
    const options = FIELD_BY_KEY[b.limit_key]?.options
    const name = (v: number) => options?.find(o => o.value === v)?.label
    if (name(policy) && name(actual)) return `${label} exceeded (policy: ${name(policy)}, actual: ${name(actual)})`
  }

  return `${label} exceeded (policy: ${b.policyValue}, actual: ${b.actualValue})`
}
