import { createServiceClient } from '@/utils/supabase/service'
import type { ChainTier } from './resolveApprovalTier'

type ServiceClient = ReturnType<typeof createServiceClient>

export type ChainMode = 'sequential' | 'parallel'
export type ChainQuorum = 'any' | 'all'

export interface ApprovalTemplate {
  id: string
  name: string
  code: string | null
  category: string
  mode: ChainMode
  quorum: ChainQuorum
  tiers: ChainTier[]
}

// Where a resolved template came from. Surfaced so the UI can show an employee
// is on the company default rather than something chosen for them — the two
// look identical otherwise, and only one of them changes when the default does.
export type TemplateSource = 'employee' | 'company_default'

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
    tiers: (row.tiers as ChainTier[] | null) ?? [],
  }
}

// ── resolveTemplateForEmployee ───────────────────────────────────────────────
// Which approval template applies to one employee for one category.
//
// Explicit assignment wins; the company default covers everyone else. Approver
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
  companyId: string,
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
    .from('company_default_approval_templates')
    .select('template_id')
    .eq('company_id', companyId)
    .eq('category', category)
    .maybeSingle()

  if (!fallback) return null

  const { data: defaultTemplate } = await service
    .from('approval_chain_templates')
    .select(TEMPLATE_COLUMNS)
    .eq('id', fallback.template_id)
    .maybeSingle()

  if (!defaultTemplate) return null

  return { template: toTemplate(defaultTemplate), source: 'company_default' }
}

// ── getAssignmentsForCompany ─────────────────────────────────────────────────
// Every explicit per-employee assignment at a company, as
// `${employeeId}::${category}` -> templateId. Used by the admin screen to show
// the whole roster's routing in one table rather than one employee at a time.
// ─────────────────────────────────────────────────────────────────────────────

export async function getAssignmentsForCompany(
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
