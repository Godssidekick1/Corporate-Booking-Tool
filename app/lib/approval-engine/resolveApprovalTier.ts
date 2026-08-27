import { createServiceClient } from '@/utils/supabase/service'
import type { Verdict, VerdictBreach } from '@/app/lib/rule-engine/evaluateBooking'
import {
  resolveTemplateForEmployee,
  getTierApprovers,
  mergeTiers,
  type ChainMode,
  type ChainQuorum,
} from './linkedApprovalTemplates'

type ServiceClient = ReturnType<typeof createServiceClient>

// ── Approval Engine v3 ───────────────────────────────────────────────────
// Chains are assigned directly to a specific employee by a TMC/admin —
// there is no band-based lookup anymore. A chain is resolved by
// (employee_id, category), where category collapses travelType's finer
// granularity (flight_domestic, flight_international, hotel, ...) into
// exactly two routing buckets:
//   'flights_hotels' — flight_domestic, flight_international, hotel, etc.
//   'misc'            — everything else (car rentals, expenses, ...)
// Policy rules (the Rule Engine) still use the finer travelType split for
// evaluating limits — this collapsing is ONLY for approval routing.
//
// approver_type: 'manager' still resolves via manager_id, 'any_manager_at'
// still resolves via band rank among active managers/admins — both
// unchanged from before, since who's ELIGIBLE to approve is still a
// legitimate band-scoped concept even though WHICH chain applies to a
// given employee is no longer derived from their band.
//
// tiers (jsonb on approval_chains) shape — walked in tier order:
//   { tier: number, approver_type: ApproverType, min_verdict: Verdict,
//     approver_user_id?: string,      // only for 'specific_user'
//     min_band_rank?: number }        // only for 'any_manager_at'
// ─────────────────────────────────────────────────────────────────────────────

export type ApprovalCategory = 'flights_hotels' | 'misc'

// ── categoryForTravelType ──────────────────────────────────────────────────
// The only place travelType's finer granularity gets collapsed to a
// routing category. Anything starting with 'flight' or 'hotel' is
// flights_hotels; everything else (car_rental, misc expenses, and any
// future travel type nobody's thought of yet) defaults to misc rather than
// silently matching neither bucket.
export function categoryForTravelType(travelType: string): ApprovalCategory {
  if (travelType.startsWith('flight') || travelType.startsWith('hotel')) return 'flights_hotels'
  return 'misc'
}

// 'unbound' is not a choice anyone makes — it is what a step resolves to when
// this company has not said who fills it. Modelled as a type rather than a
// separate flag so it falls through resolveApproverForTier to null, which
// raiseApprovals already treats as an unresolvable approver.
export type ApproverType =
  | 'manager' | 'finance_role' | 'specific_user' | 'admin' | 'self' | 'any_manager_at'
  | 'unbound'

export interface ChainTier {
  tier: number
  approver_type: ApproverType
  min_verdict: string
  // What the template calls this step. Display only — carried through so error
  // logs can name the step an admin sees rather than a bare number.
  label?: string | null
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
  // Parallel mode raises several approvals at once. approvalId/approverId
  // stay populated with the first for callers that only handle one.
  approvalIds?: string[]
  approverIds?: string[]
  // Set when a template applied but not one of its approvers could be
  // resolved to a real person — e.g. the tier wants a finance user and the
  // company has none active. The booking is NOT held on an approval nobody
  // can see; the caller decides what to do, but this says why.
  unresolvedApprovers?: boolean
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
// Which approval template applies to this employee for this booking.
//
// Assignment is per employee, not per band. A spend limit genuinely is a
// band-level concept, but an approver is not: two people at the same rank
// routinely report to different managers, so a rank-wide route can't express
// the ordinary case. Bands still decide WHO may approve — 'any_manager_at' is
// rank-scoped — just not WHICH chain applies.
//
// An explicit assignment wins; the company default catches everyone else, so a
// new hire is routed from day one rather than silently bypassing approval
// until somebody remembers to configure them.
// ─────────────────────────────────────────────────────────────────────────────

export interface ResolvedChain {
  templateId: string
  name: string
  mode: ChainMode
  quorum: ChainQuorum
  tiers: ChainTier[]
}

async function resolveChainForEmployee(
  service: ServiceClient,
  employeeId: string,
  companyId: string,
  travelType: string
): Promise<ResolvedChain | null> {
  const category = categoryForTravelType(travelType)
  const resolved = await resolveTemplateForEmployee(service, employeeId, companyId, category)

  if (!resolved) return null

  // Structure comes from the template, identity from this company's bindings.
  // Merged here so everything downstream keeps working in one tier shape.
  const approvers = await getTierApprovers(service, companyId, resolved.template.id)

  return {
    templateId: resolved.template.id,
    name: resolved.template.name,
    mode: resolved.template.mode,
    quorum: resolved.template.quorum,
    tiers: mergeTiers(resolved.template.tiers, approvers),
  }
}

// ── eligibleTiers ────────────────────────────────────────────────────────────
// The tier entries this booking's verdict actually triggers, in tier order.
// Shared by both modes: sequential takes the first, parallel takes all of them.
// ─────────────────────────────────────────────────────────────────────────────

function eligibleTiers(tiers: ChainTier[], verdict: Verdict): ChainTier[] {
  return [...tiers]
    .sort((a, b) => a.tier - b.tier)
    .filter(t => verdictRank(verdict) >= verdictRank(t.min_verdict))
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


// ── raiseApprovals ────────────────────────────────────────────────────────────
// Creates the approval rows for a set of eligible tier entries.
//
// 'self' entries are logged as already-approved and never block. Everything
// else becomes a pending row. In parallel mode every row is written at the SAME
// tier number, because quorum finds siblings by (booking_id, tier) — entries
// carrying different tier numbers in the template would otherwise fragment one
// parallel group into several that each clear independently.
// ─────────────────────────────────────────────────────────────────────────────

interface RaiseContext {
  bookingId: string
  companyId: string
  employeeId: string
  verdict: Verdict
  reason: string
}

async function raiseApprovals(
  service: ServiceClient,
  chain: ResolvedChain,
  entries: ChainTier[],
  ctx: RaiseContext
): Promise<TierOutcome> {
  const groupTier = chain.mode === 'parallel'
    ? Math.min(...entries.map(e => e.tier))
    : entries[0].tier

  const selfApprovalIds: string[] = []
  const pending: { approverId: string }[] = []
  let unresolved = false

  for (const entry of entries) {
    if (entry.approver_type === 'self') {
      // Logged but never blocking. approver_id is NOT NULL, so the traveler
      // is recorded as their own approver and the reason makes clear no human
      // reviewed it.
      const { data: logged, error } = await service
        .from('approvals')
        .insert({
          company_id: ctx.companyId,
          booking_id: ctx.bookingId,
          approver_id: ctx.employeeId,
          tier: groupTier,
          status: 'approved',
          reason: `Self-approved (this band requires no review): ${ctx.reason}`,
          chain_template_id: chain.templateId,
          verdict: ctx.verdict,
          actioned_at: new Date().toISOString(),
        })
        .select('id')
        .single()

      if (error || !logged) {
        throw new Error(`Failed to log self-approval record: ${error?.message ?? 'unknown error'}`)
      }

      selfApprovalIds.push(logged.id)
      continue
    }

    const approverId = await resolveApproverForTier(service, entry, ctx.employeeId, ctx.companyId)

    if (!approverId) {
      // Two ways to land here: the company never said who fills this step
      // ('unbound'), or it did but nobody matches — e.g. the step wants a
      // finance user and the company has none active. Both are recorded rather
      // than silently dropped: previously this produced a booking held for
      // approval with no approvals row, invisible to every queue and
      // unresolvable without touching the database.
      const stepName = entry.label ? `"${entry.label}"` : `tier ${entry.tier}`
      console.error(
        entry.approver_type === 'unbound'
          ? `Approval chain "${chain.name}" step ${stepName} has no approver set for company ${ctx.companyId}.`
          : `Approval chain "${chain.name}" step ${stepName} (${entry.approver_type}) resolved to nobody ` +
            `for employee ${ctx.employeeId} at company ${ctx.companyId}.`
      )
      unresolved = true
      continue
    }

    // One person appearing twice in a parallel group would have to approve
    // the same booking twice before 'all' quorum could clear.
    if (pending.some(p => p.approverId === approverId)) continue

    pending.push({ approverId })
  }

  if (pending.length === 0) {
    return {
      requiresApproval: false,
      selfApproved: selfApprovalIds.length > 0,
      approvalId: selfApprovalIds[0],
      approvalIds: selfApprovalIds,
      tier: groupTier,
      unresolvedApprovers: unresolved,
    }
  }

  const { data: inserted, error } = await service
    .from('approvals')
    .insert(pending.map(p => ({
      company_id: ctx.companyId,
      booking_id: ctx.bookingId,
      approver_id: p.approverId,
      tier: groupTier,
      status: 'pending',
      reason: ctx.reason,
      chain_template_id: chain.templateId,
      verdict: ctx.verdict,
    })))
    .select('id, approver_id')

  if (error || !inserted || inserted.length === 0) {
    throw new Error(`Failed to create approval record: ${error?.message ?? 'unknown error'}`)
  }

  return {
    requiresApproval: true,
    approvalId: inserted[0].id,
    approverId: inserted[0].approver_id,
    approvalIds: inserted.map(a => a.id),
    approverIds: inserted.map(a => a.approver_id),
    tier: groupTier,
    unresolvedApprovers: unresolved,
  }
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
    // No template covers this employee's band for this category, so there is
    // nothing to route to and the booking proceeds unapproved.
    //
    // This is a fail-open, unchanged from the previous behaviour. It matters
    // far less than it did: coverage is inherited from the employee's band
    // now, so a company with templates linked routes new hires automatically
    // instead of leaving everyone unconfigured until someone got to them.
    return { requiresApproval: false }
  }

  const eligible = eligibleTiers(chain.tiers, verdict)

  if (eligible.length === 0) {
    return { requiresApproval: false }
  }

  // Sequential stops at the first triggered tier and walks the rest as each
  // approval comes back. Parallel raises every triggered entry at once.
  const entries = chain.mode === 'parallel' ? eligible : [eligible[0]]

  return raiseApprovals(service, chain, entries, {
    bookingId, companyId, employeeId, verdict, reason,
  })
}

// ── advanceApprovalChain ──────────────────────────────────────────────────────
// Called after an approval is approved, to decide whether the booking is done.
//
// The caller has already flipped the acted-on row to 'approved' before this
// runs, so anything still pending is genuinely outstanding.
// ─────────────────────────────────────────────────────────────────────────────
export async function advanceApprovalChain(
  service: ServiceClient,
  params: {
    bookingId: string
    companyId: string
    employeeId: string
    chainTemplateId: string
    completedTier: number
    verdict: Verdict
    reason: string
  }
): Promise<TierOutcome> {
  const { bookingId, companyId, employeeId, chainTemplateId, completedTier, verdict, reason } = params

  const { data: template } = await service
    .from('approval_chain_templates')
    .select('id, name, mode, quorum, tiers')
    .eq('id', chainTemplateId)
    .maybeSingle()

  if (!template) {
    // The template was deleted mid-flight. Finalising is the safer failure
    // here than holding a booking nobody can now advance.
    return { requiresApproval: false }
  }

  const chain: ResolvedChain = {
    templateId: template.id,
    name: template.name,
    mode: template.mode as ChainMode,
    quorum: template.quorum as ChainQuorum,
    tiers: (template.tiers as ChainTier[] | null) ?? [],
  }

  if (chain.mode === 'parallel') {
    const { data: siblings } = await service
      .from('approvals')
      .select('id')
      .eq('booking_id', bookingId)
      .eq('tier', completedTier)
      .eq('status', 'pending')

    const outstanding = siblings ?? []

    if (chain.quorum === 'any') {
      // The first approval carries it. Retire the rest so they stop appearing
      // as live work in other approvers' queues.
      if (outstanding.length > 0) {
        await service
          .from('approvals')
          .update({ status: 'superseded', actioned_at: new Date().toISOString() })
          .in('id', outstanding.map(s => s.id))
      }
      return { requiresApproval: false, tier: completedTier }
    }

    // quorum 'all' — still blocked while anyone has yet to act.
    return outstanding.length > 0
      ? { requiresApproval: true, tier: completedTier }
      : { requiresApproval: false, tier: completedTier }
  }

  const sorted = [...chain.tiers].sort((a, b) => a.tier - b.tier)
  const nextTier = sorted.find(t => t.tier > completedTier)

  if (!nextTier || verdictRank(verdict) < verdictRank(nextTier.min_verdict)) {
    return { requiresApproval: false }
  }

  return raiseApprovals(service, chain, [nextTier], {
    bookingId, companyId, employeeId, verdict, reason,
  })
}