import { ResolvedPolicy } from './resolveEffectivePolicy'

export type Verdict = 'green' | 'amber' | 'red'

export interface VerdictBreach {
  limit_key: string
  kind: 'numeric' | 'boolean' | 'tier'
  policyValue: number | boolean
  actualValue: number | boolean
  severity: 'amber' | 'red'
}

export interface VerdictResult {
  verdict: Verdict
  breaches: VerdictBreach[]
  costTier: 'auto_approve' | 'finance_approval' | 'within_finance_limit' | 'not_evaluated'
}

// Numeric keys where a HIGHER actual value than policy is the violation
// (spending caps, rate caps, star ratings used as a max).
const NUMERIC_MAX_KEYS = [
  'max_fare_domestic', 'max_fare_intl',
  'max_rate_major_city', 'max_rate_other_city', 'max_hotel_stars',
  'max_car_rate_per_day',
  'per_diem_allowance', 'max_trip_duration',
] as const

// Numeric keys where a LOWER actual value than policy is the violation
// (minimums — less notice than required, fewer bags than entitled is fine,
// but advance_booking_days is the only real "less is worse" case today).
const NUMERIC_MIN_KEYS = [
  'advance_booking_days',
] as const

// baggage_extra_bags is numeric but "more used than entitled" is the
// violation direction, same shape as NUMERIC_MAX_KEYS — included there.
// (Kept as a separate note rather than a separate list since it behaves
// identically to the max-key group.)

const BOOLEAN_ENTITLEMENT_KEYS = [
  'breakfast_included', 'business_class_allowed', 'sponsored_transport_allowed',
  'refundable_fare_required', 'connecting_flights_allowed', 'personal_trips_allowed',
] as const

// red_eye_restricted inverts the usual boolean meaning: policy `true` means
// red-eye flights are RESTRICTED (not allowed), so "used = true" while
// "policy = true" is itself the violation — opposite polarity from the
// other entitlement flags where policy `true` means allowed. Handled
// separately below rather than folded into BOOLEAN_ENTITLEMENT_KEYS to
// avoid silently inverting the meaning of every other flag.
const INVERTED_BOOLEAN_KEYS = ['red_eye_restricted'] as const

// Tiered/enum fields — ordinal comparison, higher actual than policy = violation.
const TIER_KEYS = [
  'cabin_class_short_haul', 'cabin_class_long_haul', 'seat_selection', 'carrier_tier',
] as const

interface BookingInput {
  totalCost: number
  numericValues: Partial<Record<string, number>>
  booleanValues: Partial<Record<string, boolean>>
  tierValues?: Partial<Record<string, number>>
}

// ── evaluateBooking ────────────────────────────────────────────────────────
// Combines hard-entitlement checks (numeric, boolean, tiered) with the
// cost-tier thresholds (auto_approve_under / finance_approval_over) into one
// verdict. The single worst individual signal wins — this never returns a
// "blocked" state; red is still bookable, just flagged for stricter approval.
// ─────────────────────────────────────────────────────────────────────────────

export function evaluateBooking(policy: ResolvedPolicy, booking: BookingInput): VerdictResult {
  const breaches: VerdictBreach[] = []

  // ── Numeric: policy is a maximum ─────────────────────────────────────────
  for (const key of NUMERIC_MAX_KEYS) {
    const policyValue = policy.limits[key]
    const actualValue = booking.numericValues[key]
    if (policyValue === undefined || actualValue === undefined) continue

    if (actualValue > policyValue) {
      const overRatio = (actualValue - policyValue) / Math.max(policyValue, 1)
      breaches.push({
        limit_key: key, kind: 'numeric', policyValue, actualValue,
        severity: overRatio > 0.5 ? 'red' : 'amber',
      })
    }
  }

  // ── Numeric: policy is a minimum ─────────────────────────────────────────
  for (const key of NUMERIC_MIN_KEYS) {
    const policyValue = policy.limits[key]
    const actualValue = booking.numericValues[key]
    if (policyValue === undefined || actualValue === undefined) continue

    if (actualValue < policyValue) {
      const overRatio = (policyValue - actualValue) / Math.max(policyValue, 1)
      breaches.push({
        limit_key: key, kind: 'numeric', policyValue, actualValue,
        severity: overRatio > 0.5 ? 'red' : 'amber',
      })
    }
  }

  // ── Boolean entitlements (standard polarity: policy true = allowed) ─────
  for (const key of BOOLEAN_ENTITLEMENT_KEYS) {
    const policyValue = policy.limits[key]
    const actualValue = booking.booleanValues[key]
    if (policyValue === undefined || actualValue === undefined) continue

    const allowed = Boolean(policyValue)
    const used = Boolean(actualValue)

    if (used && !allowed) {
      breaches.push({ limit_key: key, kind: 'boolean', policyValue: allowed, actualValue: used, severity: 'red' })
    }
  }

  // ── Boolean entitlements (inverted polarity: policy true = restricted) ──
  for (const key of INVERTED_BOOLEAN_KEYS) {
    const policyValue = policy.limits[key]
    const actualValue = booking.booleanValues[key]
    if (policyValue === undefined || actualValue === undefined) continue

    const restricted = Boolean(policyValue)
    const used = Boolean(actualValue)

    if (restricted && used) {
      breaches.push({ limit_key: key, kind: 'boolean', policyValue: restricted, actualValue: used, severity: 'amber' })
    }
  }

  // ── Tiered/enum fields — higher rank than policy allows = violation ─────
  for (const key of TIER_KEYS) {
    const policyValue = policy.limits[key]
    const actualValue = booking.tierValues?.[key]
    if (policyValue === undefined || actualValue === undefined) continue

    if (actualValue > policyValue) {
      const stepsOver = actualValue - policyValue
      breaches.push({
        limit_key: key, kind: 'tier', policyValue, actualValue,
        // More than one tier above policy (e.g. Economy entitlement, booked
        // First) is red; exactly one tier over is amber.
        severity: stepsOver > 1 ? 'red' : 'amber',
      })
    }
  }

  // ── Cost-tier thresholds ─────────────────────────────────────────────────
  const autoApproveUnder = policy.limits['auto_approve_under']
  const financeApprovalOver = policy.limits['finance_approval_over']

  let costTier: VerdictResult['costTier'] = 'not_evaluated'
  let costSeverity: 'amber' | 'red' | null = null

  if (autoApproveUnder !== undefined && financeApprovalOver !== undefined) {
    if (booking.totalCost <= autoApproveUnder) {
      costTier = 'auto_approve'
    } else if (booking.totalCost <= financeApprovalOver) {
      costTier = 'within_finance_limit'
      costSeverity = 'amber'
    } else {
      costTier = 'finance_approval'
      costSeverity = 'red'
    }
  }

  // ── Combine: worst signal wins ───────────────────────────────────────────
  const hasRedBreach = breaches.some(b => b.severity === 'red') || costSeverity === 'red'
  const hasAmberBreach = breaches.some(b => b.severity === 'amber') || costSeverity === 'amber'

  const verdict: Verdict = hasRedBreach ? 'red' : hasAmberBreach ? 'amber' : 'green'

  return { verdict, breaches, costTier }
}