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

const NUMERIC_LIMIT_KEYS = [
  'max_fare_domestic', 'max_fare_intl',
  'advance_booking_days',
  'max_rate_major_city', 'max_rate_other_city', 'max_hotel_stars',
  'max_car_rate_per_day',
  'baggage_extra_bags',
  'per_diem_allowance',
  'max_trip_duration',
  'max_seat_selection_fee',
] as const

const BOOLEAN_ENTITLEMENT_KEYS = [
  'breakfast_included',
  'sponsored_transport_allowed',
  'refundable_fare_required',
  'connecting_flights_allowed',
  'red_eye_restricted',
  'personal_trips_allowed',
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

    const isViolation = key === 'advance_booking_days'
      ? actualValue < policyValue
      : actualValue > policyValue

    if (isViolation) {
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

  // ── Tier limits (cabin class, seat selection, carrier tier) ──────────────
  // Higher numeric rank = better/more expensive option.
  // Actual rank must be <= policy rank. Exceeding by 1 tier = amber, 2+ = red.
  for (const key of TIER_LIMIT_KEYS) {
    const rawPolicyValue = policy.limits[key]
    const actualValue = booking.tierValues?.[key]
    if (rawPolicyValue === undefined || actualValue === undefined) continue

    const policyValue = Number(rawPolicyValue)

    if (actualValue > policyValue) {
      const tierDiff = actualValue - policyValue
      breaches.push({
        limit_key: key,
        kind: 'tier',
        policyValue,
        actualValue,
        severity: tierDiff >= 2 ? 'red' : 'amber',
      })
    }
  }

  // ── Cost-tier thresholds ─────────────────────────────────────────────────
  const rawAutoApproveUnder = policy.limits['auto_approve_under']
  const rawFinanceApprovalOver = policy.limits['finance_approval_over']

  let costTier: VerdictResult['costTier'] = 'not_evaluated'
  let costSeverity: 'amber' | 'red' | null = null

  if (rawAutoApproveUnder !== undefined && rawFinanceApprovalOver !== undefined) {
    const autoApproveUnder = Number(rawAutoApproveUnder)
    const financeApprovalOver = Number(rawFinanceApprovalOver)

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