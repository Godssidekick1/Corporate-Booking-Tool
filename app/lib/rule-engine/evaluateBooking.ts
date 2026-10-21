import { ResolvedPolicy } from './resolveEffectivePolicy'

// Three outcomes, stored by their old colour names:
//   green  Within policy   -- every cap and rule met. Whether it still goes for
//                             approval is the company's choice (Corporate
//                             Settings: within_policy_approval).
//   amber  Needs approval  -- over a fare cap but within the group's grace. Always
//                             goes for approval; never blocked.
//   red    Out of policy   -- beyond grace, or any rule broken. Approval, or
//                             refused where the company blocks out-of-policy fares.
// Only the fare caps have grace. Every other rule is strict: one cabin above
// entitlement is a broken rule, not "somewhat over".
export type Verdict = 'green' | 'amber' | 'red'

export interface VerdictBreach {
  limit_key: string
  kind: 'numeric' | 'boolean' | 'tier'
  policyValue: number | boolean
  actualValue: number | boolean
  severity: 'amber' | 'red'
  // A fare cap with grace: the most the fare may be and still need approval
  // rather than be out of policy.
  graceLimit?: number
}

export interface VerdictResult {
  verdict: Verdict
  breaches: VerdictBreach[]
}

const FARE_CAP_KEYS: ReadonlySet<string> = new Set(['max_fare_domestic', 'max_fare_intl'])

// The fare cap plus the group's grace: a percentage of the cap, or a fixed
// amount (fare_grace_unit 1 = ₹). No grace set: the cap itself. Rounded to
// the paisa, so 10% over ₹50,000 is ₹55,000 and not a float just above it.
export function graceLimitFor(cap: number, limits: ResolvedPolicy['limits']): number {
  const grace = Number(limits['fare_grace'] ?? 0)
  if (!(grace > 0)) return cap
  const limit = Number(limits['fare_grace_unit'] ?? 0) === 1 ? cap + grace : cap * (1 + grace / 100)
  return Math.round(limit * 100) / 100
}

const NUMERIC_LIMIT_KEYS = [
  'max_fare_domestic', 'max_fare_intl',
  'advance_booking_days',
  'max_rate_major_city', 'max_rate_other_city', 'max_hotel_stars',
  'max_car_rate_per_day',
  'baggage_extra_bags',
  'per_diem_allowance',
  'max_trip_duration',
  'max_seat_selection_fee',
  // Stops in the worst direction. Numeric, not a tier: a stop over the limit is
  // the old "connecting flights not allowed" breach, red for non-stop-only
  // (1 over 0) exactly as that was. 3 means "any" and is skipped below.
  'max_stops',
  // Hours door to door in the longest direction, layovers included.
  'max_journey_hours',
  // The longest wait at any one stop, in hours.
  'max_layover_hours',
  // What cancelling would cost, in rupees (the whole fare if non-refundable).
  'max_cancel_penalty',
] as const

const BOOLEAN_ENTITLEMENT_KEYS = [
  'breakfast_included',
  'sponsored_transport_allowed',
  'red_eye_restricted',
] as const

// Tier keys — stored as numeric rank (0=Economy, 1=Premium Economy, etc.)
// Actual value must be <= policy value (higher rank = better cabin = needs entitlement)
// seat_selection here is NOT the same concept as max_seat_selection_fee
// above — this would be a seat-category tier (e.g. standard/preferred/extra-
// legroom), which has no matching config field in tmc/settings/policy yet,
// so it silently never fires. max_seat_selection_fee (a numeric spend cap
// on selected seat fees) is the one actually wired end-to-end. Leaving this
// here in case a real seat-tier field gets added later — remove it if that
// never happens, don't wire fee data into it as a workaround.
const TIER_LIMIT_KEYS = [
  'cabin_class_short_haul',
  'cabin_class_long_haul',
  'seat_selection',
  'carrier_tier',
] as const

interface BookingInput {
  // The booking's total. Not judged by itself: what a trip costs overall is
  // expense management's question, not the flight policy's.
  totalCost: number
  numericValues: Partial<Record<string, number>>
  booleanValues: Partial<Record<string, boolean>>
  tierValues?: Partial<Record<string, number>>
}

export function evaluateBooking(policy: ResolvedPolicy, booking: BookingInput): VerdictResult {
  const breaches: VerdictBreach[] = []

  // ── Hard numeric limits ──────────────────────────────────────────────────
  for (const key of NUMERIC_LIMIT_KEYS) {
    const rawPolicyValue = policy.limits[key]
    const actualValue = booking.numericValues[key]
    if (rawPolicyValue === undefined || actualValue === undefined) continue

    const policyValue = Number(rawPolicyValue)
    if (key === 'max_stops' && policyValue >= 3) continue

    const isViolation = key === 'advance_booking_days'
      ? actualValue < policyValue
      : actualValue > policyValue

    if (isViolation) {
      // A fare within the group's grace needs approval; beyond it, or over
      // any other limit, is out of policy.
      if (FARE_CAP_KEYS.has(key)) {
        const graceLimit = graceLimitFor(policyValue, policy.limits)
        breaches.push({
          limit_key: key, kind: 'numeric', policyValue, actualValue,
          severity: actualValue <= graceLimit ? 'amber' : 'red',
          ...(graceLimit > policyValue ? { graceLimit } : {}),
        })
      } else {
        breaches.push({ limit_key: key, kind: 'numeric', policyValue, actualValue, severity: 'red' })
      }
    }
  }

  // ── Boolean entitlements ─────────────────────────────────────────────────
  for (const key of BOOLEAN_ENTITLEMENT_KEYS) {
    const rawPolicyValue = policy.limits[key]
    const actualValue = booking.booleanValues[key]
    if (rawPolicyValue === undefined || actualValue === undefined) continue

    const allowed = Boolean(rawPolicyValue)
    const used = Boolean(actualValue)

    if (used && !allowed) {
      breaches.push({
        limit_key: key,
        kind: 'boolean',
        policyValue: allowed,
        actualValue: used,
        severity: 'red',
      })
    }
  }

  // ── Required fare conditions ─────────────────────────────────────────────
  // The opposite polarity to an entitlement: the policy REQUIRES something and
  // the fare does not have it. Read as one, "refundable required" breached only
  // when a fare was refundable, which is backwards; that is why it was never
  // supplied before.
  if (policy.limits['refundable_fare_required'] === true && booking.booleanValues['refundable_fare'] === false) {
    breaches.push({
      limit_key: 'refundable_fare_required',
      kind: 'boolean',
      policyValue: true,
      actualValue: false,
      severity: 'red',
    })
  }

  // ── Tier limits (cabin class, seat selection, carrier tier) ──────────────
  // Higher numeric rank = better/more expensive option.
  // Actual rank must be <= policy rank. Any tier above is out of policy.
  for (const key of TIER_LIMIT_KEYS) {
    const rawPolicyValue = policy.limits[key]
    const actualValue = booking.tierValues?.[key]
    if (rawPolicyValue === undefined || actualValue === undefined) continue

    const policyValue = Number(rawPolicyValue)

    if (actualValue > policyValue) {
      breaches.push({ limit_key: key, kind: 'tier', policyValue, actualValue, severity: 'red' })
    }
  }

  // ── Combine: worst signal wins ───────────────────────────────────────────
  // The old cost thresholds (auto_approve_under, finance_approval_over) are
  // no longer read: they coloured fares that were under their cap, mixing
  // "is this within policy" with "how much is spent".
  const verdict: Verdict = breaches.some(b => b.severity === 'red') ? 'red'
    : breaches.some(b => b.severity === 'amber') ? 'amber' : 'green'

  return { verdict, breaches }
}