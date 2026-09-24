import type { Queryable } from '@/app/lib/db'
import * as approvals from '@/app/lib/repositories/approvals'
import * as employees from '@/app/lib/repositories/employees'
import type { ApproverType, ChainTier } from './resolveApprovalTier'

// Every function here takes `db` -- the pool, or a transaction's connection,
// so approval writes can run inside transaction() with the rest of a decision.

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

// No `category`, deliberately. A template is a sequence of steps and verdict
// thresholds; nothing in it is air-specific or hotel-specific. Which kind of
// spend a chain routes is decided where it is ASSIGNED, so one chain can serve
// air, hotel and misc rather than being duplicated three times and drifting the
// first time somebody edits one copy.
export interface ApprovalTemplate {
  id: string
  name: string
  code: string | null
  mode: ChainMode
  quorum: ChainQuorum
  tiers: TemplateTier[]
}

// Where a resolved template came from. Surfaced so the UI can show an employee
// is on their band's chain or the client default rather than something chosen
// for them — the three look identical otherwise, and each changes for a
// different reason.
export type TemplateSource = 'employee' | 'band' | 'client_default'

export interface ResolvedTemplate {
  template: ApprovalTemplate
  source: TemplateSource
}

function toTemplate(row: approvals.TemplateRow): ApprovalTemplate {
  return {
    id: row.id,
    name: row.name,
    code: row.code ?? null,
    mode: row.mode as ChainMode,
    quorum: row.quorum as ChainQuorum,
    tiers: row.tiers ?? [],
  }
}

// ── getTierApprovers ─────────────────────────────────────────────────────────
// Who fills each step of one template at one client, keyed by step number.
//
// A step with no row here is unbound. Callers merge that into a tier carrying
// approver_type 'unbound', which resolveApproverForTier returns unresolved for
// — and raiseApprovals already logs that and flags the outcome.
// ─────────────────────────────────────────────────────────────────────────────

export async function getTierApprovers(
  db: Queryable,
  clientId: string,
  templateId: string
): Promise<Map<number, TierApprover>> {
  const rows = await approvals.bindings(db, clientId, templateId)
  return new Map(rows.map(r => [r.tier, { ...r, approver_type: r.approver_type as ApproverType }]))
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
//   employee  ->  band  ->  client default
//
// Most specific wins. The band rung is what makes a template worth having: if
// every assignment were per person, the template would be pure indirection and
// mapping approvers directly would be simpler. Set a band's chain once and it
// covers everyone in it; the per-employee row stays as the override for the
// people who genuinely differ.
//
// Note what is still NOT band-derived: WHO fills a step. Two employees at the
// same rank routinely report to different managers, so approver identity comes
// from approval_tier_approvers and from the employee's own manager_id. Bands
// choose the CHAIN, not the person — except 'any_manager_at', which is
// explicitly rank-scoped and always was.
// ─────────────────────────────────────────────────────────────────────────────

async function loadTemplate(
  db: Queryable,
  templateId: string,
  source: TemplateSource
): Promise<ResolvedTemplate | null> {
  const row = await approvals.template(db, templateId)
  return row ? { template: toTemplate(row), source } : null
}

export async function resolveTemplateForEmployee(
  db: Queryable,
  employeeId: string,
  clientId: string,
  category: string
): Promise<ResolvedTemplate | null> {
  const assigned = await approvals.employeeTemplateId(db, employeeId, category)

  if (assigned) {
    const resolved = await loadTemplate(db, assigned, 'employee')
    // A dangling template id falls THROUGH to the next rung rather than
    // resolving to nothing. The row exists but points at a template that is
    // gone; the employee still deserves whatever their band or client says.
    if (resolved) return resolved
  }

  // The band rung. Skipped entirely for an employee with no band — that is a
  // separate configuration gap, reported by the policy engine, and not
  // something to fail approval routing over.
  const bandCode = await employees.bandCode(db, employeeId)

  if (bandCode) {
    const byBand = await approvals.bandTemplateId(db, clientId, bandCode, category)
    if (byBand) {
      const resolved = await loadTemplate(db, byBand, 'band')
      if (resolved) return resolved
    }
  }

  const fallback = await approvals.defaultTemplateId(db, clientId, category)

  if (!fallback) return null

  return loadTemplate(db, fallback, 'client_default')
}

// ── getBandAssignmentsForClient ─────────────────────────────────────────────
// Every band-level assignment at one client, as `${bandCode}::${category}` ->
// templateId. Same shape as getAssignmentsForClient so the admin screen can
// render both ladders from one payload.
// ─────────────────────────────────────────────────────────────────────────────

export async function getBandAssignmentsForClient(
  db: Queryable,
  clientId: string
): Promise<Map<string, string>> {
  const rows = await approvals.bandAssignments(db, clientId)
  return new Map(rows.map(r => [`${r.band_code}::${r.category}`, r.template_id]))
}

// ── getAssignmentsForClient ─────────────────────────────────────────────────
// Every explicit per-employee assignment at a client, as
// `${employeeId}::${category}` -> templateId. Used by the admin screen to show
// the whole roster's routing in one table rather than one employee at a time.
// ─────────────────────────────────────────────────────────────────────────────

export async function getAssignmentsForClient(
  db: Queryable,
  employeeIds: string[]
): Promise<Map<string, string>> {
  const rows = await approvals.employeeAssignments(db, employeeIds)
  return new Map(rows.map(r => [`${r.employee_id}::${r.category}`, r.template_id]))
}
