import { createServiceClient } from '@/utils/supabase/service'
import type { ApproverType, ChainTier } from './resolveApprovalTier'

type ServiceClient = ReturnType<typeof createServiceClient>

export type ChainMode = 'sequential' | 'parallel'
export type ChainQuorum = 'any' | 'all'

// ── TemplateTier ─────────────────────────────────────────────────────────────
// A step as the template stores it: structure only. Who fills it is decided per
// client, in approval_tier_approvers — a template is shared across clients and
// a person only exists inside one of them.
//
// `label` is what the TMC calls the step ("Line manager", "Finance sign-off").
// It carries no behaviour; it exists so the person binding approvers at each
// client knows what the step is meant to be.
// ─────────────────────────────────────────────────────────────────────────────
export interface TemplateTier {
  tier: number
  min_verdict: string
  label?: string | null
}

// The identity half, one row per (client, template, step).
export interface TierApprover {
  tier: number
  approver_type: ApproverType
  approver_user_id?: string | null
  min_band_rank?: number | null
}

export interface ApprovalTemplate {
  id: string
  name: string
  code: string | null
  category: string
  mode: ChainMode
  quorum: ChainQuorum
  tiers: TemplateTier[]
}

// Where a resolved template came from. Surfaced so the UI can show an employee
// is on the client default rather than something chosen for them — the two
// look identical otherwise, and only one of them changes when the default does.
export type TemplateSource = 'employee' | 'client_default'

export interface ResolvedTemplate {
  template: ApprovalTemplate
  source: TemplateSource
}

const TEMPLATE_COLUMNS = 'id, name, code, category, mode, quorum, tiers'

function toTemplate(row: Record<string, unknown>): ApprovalTemplate {
  return {
    id: row.id as string,
    name: row.name as string,
    code: (row.code as string | null) ?? null,
    category: row.category as string,
    mode: row.mode as ChainMode,
    quorum: row.quorum as ChainQuorum,
    tiers: (row.tiers as TemplateTier[] | null) ?? [],
  }
}

// ── getTierApprovers ─────────────────────────────────────────────────────────
// Who fills each step of one template at one client, keyed by step number.
//
// A step with no row here is unbound. Callers merge that into a tier carrying
// approver_type 'unbound', which resolveApproverForTier returns null for — and
// null already means "unresolvable approver" to raiseApprovals, which logs it
// and flags the outcome. No separate handling needed.
// ─────────────────────────────────────────────────────────────────────────────

export async function getTierApprovers(
  service: ServiceClient,
  clientId: string,
  templateId: string
): Promise<Map<number, TierApprover>> {
  const { data: rows } = await service
    .from('approval_tier_approvers')
    .select('tier, approver_type, approver_user_id, min_band_rank')
    .eq('client_id', clientId)
    .eq('template_id', templateId)

  return new Map((rows ?? []).map(r => [r.tier as number, r as TierApprover]))
}

// ── mergeTiers ───────────────────────────────────────────────────────────────
// Joins the two halves into the ChainTier shape the engine already works in.
//
// This is the whole point of keeping the binding row shaped like the old inline
// tier: resolveApproverForTier, raiseApprovals, eligibleTiers and both entry
// points read the result unchanged.
// ─────────────────────────────────────────────────────────────────────────────

export function mergeTiers(
  structure: TemplateTier[],
  approvers: Map<number, TierApprover>
): ChainTier[] {
  return structure.map(step => {
    const bound = approvers.get(step.tier)

    return {
      tier: step.tier,
      min_verdict: step.min_verdict,
      label: step.label ?? null,
      approver_type: bound?.approver_type ?? 'unbound',
      approver_user_id: bound?.approver_user_id ?? null,
      min_band_rank: bound?.min_band_rank ?? null,
    }
  })
}

// ── resolveTemplateForEmployee ───────────────────────────────────────────────
// Which approval template applies to one employee for one category.
//
// Explicit assignment wins; the client default covers everyone else. Approver
// routing is deliberately NOT band-derived: two employees at the same rank
// commonly report to different managers, so a rank-wide route can't express
// the ordinary case. Bands still matter for WHO may approve — the
// 'any_manager_at' approver type is rank-scoped — just not for WHICH chain
// applies.
//
// Fetched as separate queries rather than a Supabase FK-embed, consistent with
// the rest of this codebase: embed-alias inference isn't relied on anywhere
// else, and this path decides whether a booking needs approval at all.
// ─────────────────────────────────────────────────────────────────────────────

export async function resolveTemplateForEmployee(
  service: ServiceClient,
  employeeId: string,
  clientId: string,
  category: string
): Promise<ResolvedTemplate | null> {
  const { data: assignment } = await service
    .from('employee_approval_templates')
    .select('template_id')
    .eq('employee_id', employeeId)
    .eq('category', category)
    .maybeSingle()

  if (assignment) {
    const { data: template } = await service
      .from('approval_chain_templates')
      .select(TEMPLATE_COLUMNS)
      .eq('id', assignment.template_id)
      .maybeSingle()

    if (template) return { template: toTemplate(template), source: 'employee' }
  }

  const { data: fallback } = await service
    .from('client_default_approval_templates')
    .select('template_id')
    .eq('client_id', clientId)
    .eq('category', category)
    .maybeSingle()

  if (!fallback) return null

  const { data: defaultTemplate } = await service
    .from('approval_chain_templates')
    .select(TEMPLATE_COLUMNS)
    .eq('id', fallback.template_id)
    .maybeSingle()

  if (!defaultTemplate) return null

  return { template: toTemplate(defaultTemplate), source: 'client_default' }
}

// ── getAssignmentsForClient ─────────────────────────────────────────────────
// Every explicit per-employee assignment at a client, as
// `${employeeId}::${category}` -> templateId. Used by the admin screen to show
// the whole roster's routing in one table rather than one employee at a time.
// ─────────────────────────────────────────────────────────────────────────────

export async function getAssignmentsForClient(
  service: ServiceClient,
  employeeIds: string[]
): Promise<Map<string, string>> {
  const byKey = new Map<string, string>()

  if (employeeIds.length === 0) return byKey

  const { data: rows } = await service
    .from('employee_approval_templates')
    .select('employee_id, category, template_id')
    .in('employee_id', employeeIds)

  for (const row of rows ?? []) {
    byKey.set(`${row.employee_id}::${row.category}`, row.template_id)
  }

  return byKey
}
