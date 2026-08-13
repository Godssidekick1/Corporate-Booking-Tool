import { createServiceClient } from '@/utils/supabase/service'
import type { Verdict, VerdictBreach } from '@/app/lib/rule-engine/evaluateBooking'

type ServiceClient = ReturnType<typeof createServiceClient>

// Verdict severity ordering, so "does this tier's min_verdict apply" can be
// a simple >= comparison instead of a chain of if/else.
const VERDICT_RANK: Record<Verdict, number> = { green: 0, amber: 1, red: 2 }

// ── verdictRank ──────────────────────────────────────────────────────────
// min_verdict on approval_chain_tiers comes straight from a DB select(),
// typed as `string` since Supabase can't enforce the CHECK constraint at
// the type level. If a row ever holds something other than
// 'green'/'amber'/'red' — a typo from free-form chain-builder UI, a NULL
// from an old migration, an empty string — VERDICT_RANK[badValue] would be
// `undefined`, and `rank >= undefined` is always false in JS. That would
// silently skip a tier that was meant to require approval, which is the
// wrong direction to fail for something enforcing spend policy. Unknown
// values are treated as 'red' (the strictest tier) instead, so a
// misconfigured tier blocks and gets noticed/escalated rather than quietly
// never firing.
// ─────────────────────────────────────────────────────────────────────────────

function verdictRank(value: string): number {
  if (value in VERDICT_RANK) return VERDICT_RANK[value as Verdict]
  console.error(`approval_chain_tiers.min_verdict has an unrecognized value: "${value}" — treating as 'red' (strictest) rather than silently skipping this tier.`)
  return VERDICT_RANK.red
}

export interface TierOutcome {
  // No human approval needed at all — either no chain is assigned, the
  // chain has no tiers, or tier 1's min_verdict isn't met by this verdict.
  // Caller should mark the booking 'approved' immediately.
  requiresApproval: boolean
  approvalId?: string
  tier?: number
  approverId?: string
}

// ── buildReason ────────────────────────────────────────────────────────────
// Turns the breaches array from evaluateBooking into the human-readable,
// system-generated explanation stored in approvals.reason. Kept separate
// from evaluateBooking itself since that module has no DB/label knowledge.
// ─────────────────────────────────────────────────────────────────────────────

const LIMIT_LABELS: Record<string, string> = {
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
  connecting_flights_allowed: 'connecting flights entitlement',
  red_eye_restricted: 'red-eye flight restriction',
  personal_trips_allowed: 'personal trips entitlement',
  cabin_class_short_haul: 'cabin class entitlement (short-haul)',
  cabin_class_long_haul: 'cabin class entitlement (long-haul)',
  seat_selection: 'seat selection entitlement',
  carrier_tier: 'preferred carrier tier',
}

export function buildReason(breaches: VerdictBreach[], costTier: string, totalCost: number): string {
  const parts: string[] = []

  for (const b of breaches) {
    const label = LIMIT_LABELS[b.limit_key] ?? b.limit_key
    if (b.kind === 'boolean') {
      parts.push(`${label} is not permitted for this employee`)
    } else {
      parts.push(`${label} exceeded (policy: ${b.policyValue}, actual: ${b.actualValue})`)
    }
  }

  if (costTier === 'finance_approval') {
    parts.push(`total cost ₹${totalCost} exceeds the finance approval threshold`)
  } else if (costTier === 'within_finance_limit') {
    parts.push(`total cost ₹${totalCost} is above auto-approval but within finance limits`)
  }

  return parts.length > 0 ? parts.join('; ') : 'Within policy'
}

// ── resolveApproverForTier ───────────────────────────────────────────────────
// Turns a tier's approver_type into an actual employee id.
// ─────────────────────────────────────────────────────────────────────────────

async function resolveApproverForTier(
  service: ServiceClient,
  tier: { approver_type: string; approver_user_id: string | null },
  employeeId: string,
  companyId: string
): Promise<string | null> {
  if (tier.approver_type === 'specific_user') {
    return tier.approver_user_id
  }

  if (tier.approver_type === 'manager') {
    const { data: employee } = await service
      .from('employees')
      .select('manager_id')
      .eq('id', employeeId)
      .maybeSingle()
    return employee?.manager_id ?? null
  }

  if (tier.approver_type === 'finance_role' || tier.approver_type === 'admin') {
    const role = tier.approver_type === 'finance_role' ? 'finance' : 'admin'
    const { data: candidate } = await service
      .from('employees')
      .select('id')
      .eq('company_id', companyId)
      .eq('role', role)
      .eq('status', 'active')
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle()
    return candidate?.id ?? null
  }

  return null
}

// ── startApprovalForBooking ───────────────────────────────────────────────────
// Called once, right after a booking is inserted (post AddPassenger) with its
// policy verdict known. Resolves the employee's assigned chain and creates
// ONLY the first tier whose min_verdict is met — later tiers are created
// lazily by advanceApprovalChain once the prior tier is approved.
// ─────────────────────────────────────────────────────────────────────────────

export async function startApprovalForBooking(
  service: ServiceClient,
  params: {
    bookingId: string
    companyId: string
    employeeId: string
    verdict: Verdict
    reason: string
  }
): Promise<TierOutcome> {
  const { bookingId, companyId, employeeId, verdict, reason } = params

  const { data: assignment } = await service
    .from('employee_approval_chains')
    .select('chain_id')
    .eq('employee_id', employeeId)
    .maybeSingle()

  if (!assignment) {
    // No chain assigned to this employee — nothing to route to, so the
    // booking proceeds without human approval regardless of verdict. This
    // is a TMC/admin configuration gap, not a policy pass.
    return { requiresApproval: false }
  }

  const { data: tiers } = await service
    .from('approval_chain_tiers')
    .select('id, tier, approver_type, approver_user_id, min_verdict')
    .eq('chain_id', assignment.chain_id)
    .order('tier', { ascending: true })

  const firstTier = (tiers ?? []).find(t => verdictRank(verdict) >= verdictRank(t.min_verdict))

  if (!firstTier) {
    return { requiresApproval: false }
  }

  const approverId = await resolveApproverForTier(service, firstTier, employeeId, companyId)

  if (!approverId) {
    // Chain is misconfigured (e.g. employee has no manager_id, or no
    // finance-role employee exists in this company) — fail safe by NOT
    // silently approving. Surface this distinctly so the UI can tell the
    // employee to contact an admin rather than showing a generic pending
    // screen that will never resolve.
    return { requiresApproval: true, tier: firstTier.tier, approverId: undefined }
  }

  const { data: approval, error } = await service
    .from('approvals')
    .insert({
      company_id: companyId,
      booking_id: bookingId,
      approver_id: approverId,
      tier: firstTier.tier,
      status: 'pending',
      reason,
      chain_id: assignment.chain_id,
      verdict,
    })
    .select('id')
    .single()

  if (error || !approval) {
    throw new Error(`Failed to create approval record: ${error?.message ?? 'unknown error'}`)
  }

  return { requiresApproval: true, approvalId: approval.id, tier: firstTier.tier, approverId }
}

// ── advanceApprovalChain ──────────────────────────────────────────────────────
// Called after a tier is approved. Creates the next tier's row if one exists
// and its min_verdict is met by the booking's stored verdict; otherwise
// signals the caller to mark the booking fully approved.
// ─────────────────────────────────────────────────────────────────────────────

export async function advanceApprovalChain(
  service: ServiceClient,
  params: {
    bookingId: string
    companyId: string
    employeeId: string
    chainId: string
    completedTier: number
    verdict: Verdict
    reason: string
  }
): Promise<TierOutcome> {
  const { bookingId, companyId, employeeId, chainId, completedTier, verdict, reason } = params

  const { data: nextTier } = await service
    .from('approval_chain_tiers')
    .select('id, tier, approver_type, approver_user_id, min_verdict')
    .eq('chain_id', chainId)
    .gt('tier', completedTier)
    .order('tier', { ascending: true })
    .limit(1)
    .maybeSingle()

  if (!nextTier || verdictRank(verdict) < verdictRank(nextTier.min_verdict)) {
    return { requiresApproval: false }
  }

  const approverId = await resolveApproverForTier(service, nextTier, employeeId, companyId)

  if (!approverId) {
    return { requiresApproval: true, tier: nextTier.tier, approverId: undefined }
  }

  const { data: approval, error } = await service
    .from('approvals')
    .insert({
      company_id: companyId,
      booking_id: bookingId,
      approver_id: approverId,
      tier: nextTier.tier,
      status: 'pending',
      reason,
      chain_id: chainId,
      verdict,
    })
    .select('id')
    .single()

  if (error || !approval) {
    throw new Error(`Failed to create next-tier approval record: ${error?.message ?? 'unknown error'}`)
  }

  return { requiresApproval: true, approvalId: approval.id, tier: nextTier.tier, approverId }
}