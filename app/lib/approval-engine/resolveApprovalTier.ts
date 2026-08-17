import { createServiceClient } from '@/utils/supabase/service'
import type { Verdict, VerdictBreach } from '@/app/lib/rule-engine/evaluateBooking'

type ServiceClient = ReturnType<typeof createServiceClient>

// ── Approval Engine v2 ───────────────────────────────────────────────────
// Chains are resolved by (company_id, band_id, travel_type) — mirrors how
// policy_rules resolves by (company_id/tmc_id, band_code, travel_type).
// There is no per-employee chain assignment anymore: every employee in a
// given band automatically uses that band's chain for that travel type.
// This directly supports band-scoped approval authority (e.g. an L3/L4
// manager approving for L1/L2 travelers) — see approver_type: 'manager'
// below, which resolves via manager_id same as before, and 'any_manager_at'
// which resolves via band rank instead of the reporting line, for cases
// where the traveler's own manager_id isn't the intended approver.
//
// tiers (jsonb on approval_chains) shape — walked in tier order:
//   { tier: number, approver_type: ApproverType, min_verdict: Verdict,
//     approver_user_id?: string,      // only for 'specific_user'
//     min_band_rank?: number }        // only for 'any_manager_at'
// ─────────────────────────────────────────────────────────────────────────────

export type ApproverType = 'manager' | 'finance_role' | 'specific_user' | 'admin' | 'self' | 'any_manager_at'

export interface ChainTier {
  tier: number
  approver_type: ApproverType
  min_verdict: string
  approver_user_id?: string | null
  min_band_rank?: number | null
}

const VERDICT_RANK: Record<Verdict, number> = { green: 0, amber: 1, red: 2 }

// ── verdictRank ──────────────────────────────────────────────────────────
// tiers is jsonb with no DB-level CHECK on min_verdict's contents, so an
// unrecognized value is even more possible here than the old column-based
// design. Unknown values fail toward 'red' (strictest) rather than
// silently never triggering — wrong direction to fail for spend policy.
// ─────────────────────────────────────────────────────────────────────────────

function verdictRank(value: string): number {
  if (value in VERDICT_RANK) return VERDICT_RANK[value as Verdict]
  console.error(`approval_chains.tiers has an unrecognized min_verdict: "${value}" — treating as 'red' (strictest) rather than silently skipping this tier.`)
  return VERDICT_RANK.red
}

export interface TierOutcome {
  requiresApproval: boolean
  approvalId?: string
  tier?: number
  approverId?: string
  // True when this tier resolved to approver_type 'self' — the caller
  // should still log a record to `approvals` (status pre-set to 'approved',
  // no human ever acted), just never block the booking on it.
  selfApproved?: boolean
}

// ── buildReason ────────────────────────────────────────────────────────────
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
  max_seat_selection_fee: 'seat selection spend limit',
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

// ── resolveChainForEmployee ──────────────────────────────────────────────────
// Looks up the employee's band, then the (company, band, travel_type) chain.
// Returns null if either lookup comes up empty — a missing band or a band
// with no configured chain both mean "no chain applies," same as the old
// design's "no assignment" case.
// ─────────────────────────────────────────────────────────────────────────────

async function resolveChainForEmployee(
  service: ServiceClient,
  employeeId: string,
  companyId: string,
  travelType: string
): Promise<{ chainId: string; tiers: ChainTier[] } | null> {
  const { data: employee } = await service
    .from('employees')
    .select('band_code')
    .eq('id', employeeId)
    .maybeSingle()

  if (!employee?.band_code) return null

  const { data: band } = await service
    .from('bands')
    .select('id')
    .eq('company_id', companyId)
    .eq('code', employee.band_code)
    .maybeSingle()

  if (!band) return null

  const { data: chain } = await service
    .from('approval_chains')
    .select('id, tiers')
    .eq('company_id', companyId)
    .eq('band_id', band.id)
    .eq('travel_type', travelType)
    .maybeSingle()

  if (!chain) return null

  return { chainId: chain.id, tiers: (chain.tiers as ChainTier[] | null) ?? [] }
}

// ── resolveApproverForTier ───────────────────────────────────────────────────
async function resolveApproverForTier(
  service: ServiceClient,
  tier: ChainTier,
  employeeId: string,
  companyId: string
): Promise<string | null> {
  if (tier.approver_type === 'specific_user') {
    return tier.approver_user_id ?? null
  }

  if (tier.approver_type === 'manager') {
    const { data: employee } = await service
      .from('employees')
      .select('manager_id')
      .eq('id', employeeId)
      .maybeSingle()
    return employee?.manager_id ?? null
  }

  // Band-scoped authority: approve via ANY active manager/admin whose own
  // band rank is >= min_band_rank, regardless of the traveler's specific
  // manager_id. This is what makes "an L4 manager can approve for L1/L2
  // travelers" expressible even when the traveler's direct manager_id
  // points somewhere else, or isn't set at all. Picks the lowest-rank
  // qualifying approver (closest in seniority to the traveler) rather than
  // always escalating to the most senior person available.
  if (tier.approver_type === 'any_manager_at') {
    const minRank = tier.min_band_rank ?? 0
    const { data: candidates } = await service
      .from('employees')
      .select('id, band_code, bands:band_code(rank)')
      .eq('company_id', companyId)
      .in('role', ['manager', 'admin'])
      .eq('status', 'active')

    // bands:band_code(rank) FK-embed syntax isn't used elsewhere in this
    // codebase and its behavior here is unverified — resolve rank via a
    // manual second query instead, consistent with how the rest of this
    // file avoids relying on embed inference.
    if (!candidates || candidates.length === 0) return null

    const { data: bandRanks } = await service
      .from('bands')
      .select('code, rank')
      .eq('company_id', companyId)

    const rankByCode = new Map((bandRanks ?? []).map(b => [b.code, b.rank]))
    const qualifying = candidates
      .map(c => ({ id: c.id, rank: rankByCode.get((c as { band_code: string | null }).band_code ?? '') ?? -1 }))
      .filter(c => c.rank >= minRank)
      .sort((a, b) => a.rank - b.rank)

    return qualifying[0]?.id ?? null
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
export async function startApprovalForBooking(
  service: ServiceClient,
  params: {
    bookingId: string
    companyId: string
    employeeId: string
    travelType: string
    verdict: Verdict
    reason: string
  }
): Promise<TierOutcome> {
  const { bookingId, companyId, employeeId, travelType, verdict, reason } = params

  const chain = await resolveChainForEmployee(service, employeeId, companyId, travelType)

  if (!chain || chain.tiers.length === 0) {
    // No chain configured for this band/travel type — nothing to route to.
    // Same fallback as before: proceeds without human approval rather than
    // stranding the employee on a TMC configuration gap.
    return { requiresApproval: false }
  }

  const sortedTiers = [...chain.tiers].sort((a, b) => a.tier - b.tier)
  const firstTier = sortedTiers.find(t => verdictRank(verdict) >= verdictRank(t.min_verdict))

  if (!firstTier) {
    return { requiresApproval: false }
  }

  if (firstTier.approver_type === 'self') {
    // Log a record but never block. status is pre-set to 'approved' with no
    // real approver_id — approver_id is NOT NULL on the existing approvals
    // table, so the traveler themself is recorded as their own approver,
    // with the reason field making clear this was a self-approval, not a
    // real review.
    const { data: approval, error } = await service
      .from('approvals')
      .insert({
        company_id: companyId,
        booking_id: bookingId,
        approver_id: employeeId,
        tier: firstTier.tier,
        status: 'approved',
        reason: `Self-approved (band exempt from approval): ${reason}`,
        chain_id: chain.chainId,
        verdict,
        actioned_at: new Date().toISOString(),
      })
      .select('id')
      .single()

    if (error || !approval) {
      throw new Error(`Failed to log self-approval record: ${error?.message ?? 'unknown error'}`)
    }

    return { requiresApproval: false, selfApproved: true, approvalId: approval.id, tier: firstTier.tier }
  }

  const approverId = await resolveApproverForTier(service, firstTier, employeeId, companyId)

  if (!approverId) {
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
      chain_id: chain.chainId,
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

  const { data: chain } = await service
    .from('approval_chains')
    .select('tiers')
    .eq('id', chainId)
    .maybeSingle()

  const tiers = ((chain?.tiers as ChainTier[] | null) ?? []).sort((a, b) => a.tier - b.tier)
  const nextTier = tiers.find(t => t.tier > completedTier)

  if (!nextTier || verdictRank(verdict) < verdictRank(nextTier.min_verdict)) {
    return { requiresApproval: false }
  }

  if (nextTier.approver_type === 'self') {
    const { data: approval, error } = await service
      .from('approvals')
      .insert({
        company_id: companyId,
        booking_id: bookingId,
        approver_id: employeeId,
        tier: nextTier.tier,
        status: 'approved',
        reason: `Self-approved (band exempt from approval): ${reason}`,
        chain_id: chainId,
        verdict,
        actioned_at: new Date().toISOString(),
      })
      .select('id')
      .single()

    if (error || !approval) {
      throw new Error(`Failed to log self-approval record: ${error?.message ?? 'unknown error'}`)
    }

    return { requiresApproval: false, selfApproved: true, approvalId: approval.id, tier: nextTier.tier }
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