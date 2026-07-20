import { ResolvedPolicy } from './resolveEffectivePolicy'

export type Verdict = 'green' | 'amber' | 'red'

export interface VerdictBreach {
  limit_key: string
  kind: 'numeric' | 'boolean'
  policyValue: number | boolean
  actualValue: number | boolean
  severity: 'amber' | 'red'
}

export interface VerdictResult {
  verdict: Verdict
  breaches: VerdictBreach[]
  costTier: 'auto_approve' | 'finance_approval' | 'within_finance_limit' | 'not_evaluated'
}

// Numeric keys that represent hard entitlement caps (not the cost-tier
// thresholds themselves) — breaching these is a real policy violation.
const NUMERIC_LIMIT_KEYS = [
  'max_fare_domestic', 'max_fare_intl',
  'advance_booking_days', // special: actual must be >= policy (less notice = worse)
  'max_rate_major_city', 'max_rate_other_city', 'max_hotel_stars',
  'max_car_rate_per_day',
] as const

// Boolean entitlement keys — true means allowed. A booking using something
// the policy marks false is a breach.
const BOOLEAN_ENTITLEMENT_KEYS = [
  'breakfast_included', 'business_class_allowed', 'sponsored_transport_allowed',
] as const

interface BookingInput {
  totalCost: number
  numericValues: Partial<Record<string, number>>   // e.g. { max_fare_domestic: 7500 }
  booleanValues: Partial<Record<string, boolean>>  // e.g. { business_class_allowed: true }
}

// ── evaluateBooking ────────────────────────────────────────────────────────
// Combines hard-entitlement checks (numeric + boolean) with the cost-tier
// thresholds (auto_approve_under / finance_approval_over) into one verdict.
// The single worst individual signal wins — this never returns a "blocked"
// state; red is still bookable, just flagged for stricter approval.
// ─────────────────────────────────────────────────────────────────────────────

export function evaluateBooking(policy: ResolvedPolicy, booking: BookingInput): VerdictResult {
  const breaches: VerdictBreach[] = []

  // ── Hard numeric limits ──────────────────────────────────────────────────
  for (const key of NUMERIC_LIMIT_KEYS) {
    const policyValue = policy.limits[key]
    const actualValue = booking.numericValues[key]
    if (policyValue === undefined || actualValue === undefined) continue

    const isViolation = key === 'advance_booking_days'
      ? actualValue < policyValue   // fewer days notice than required = worse
      : actualValue > policyValue   // over the cap = worse

    if (isViolation) {
      // How far over, as a ratio, decides amber vs red — more than 50% over
      // the limit is red, anything past the limit but under that is amber.
      const overRatio = key === 'advance_booking_days'
        ? (policyValue - actualValue) / Math.max(policyValue, 1)
        : (actualValue - policyValue) / Math.max(policyValue, 1)

      breaches.push({
        limit_key: key,
        kind: 'numeric',
        policyValue,
        actualValue,
        severity: overRatio > 0.5 ? 'red' : 'amber',
      })
    }
  }

  // ── Boolean entitlements ─────────────────────────────────────────────────
  for (const key of BOOLEAN_ENTITLEMENT_KEYS) {
    const policyValue = policy.limits[key]
    const actualValue = booking.booleanValues[key]
    if (policyValue === undefined || actualValue === undefined) continue

    const allowed = Boolean(policyValue)
    const used = Boolean(actualValue)

    // Using something not entitled to is always treated as red — these are
    // typically the more visible, harder-to-justify breaches (e.g. flying
    // business without the entitlement), unlike a numeric overage.
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