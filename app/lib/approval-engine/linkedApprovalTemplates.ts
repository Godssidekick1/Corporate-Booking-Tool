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
  bandRanks: number[]
}

// ── getTemplateBandRanks ─────────────────────────────────────────────────────
// Rank sets for the given templates, as template id -> sorted ranks. Templates
// with no ranks still get an entry, so callers can distinguish "covers nothing"
// from "not fetched".
// ─────────────────────────────────────────────────────────────────────────────

export async function getTemplateBandRanks(
  service: ServiceClient,
  templateIds: string[]
): Promise<Map<string, number[]>> {
  const byTemplate = new Map<string, number[]>()

  if (templateIds.length === 0) return byTemplate

  const { data: rankRows } = await service
    .from('approval_template_band_ranks')
    .select('template_id, band_rank')
    .in('template_id', templateIds)

  for (const row of rankRows ?? []) {
    const existing = byTemplate.get(row.template_id)
    if (existing) existing.push(row.band_rank)
    else byTemplate.set(row.template_id, [row.band_rank])
  }

  for (const ranks of byTemplate.values()) ranks.sort((a, b) => a - b)
  for (const id of templateIds) {
    if (!byTemplate.has(id)) byTemplate.set(id, [])
  }

  return byTemplate
}

// ── getLinkedApprovalTemplates ───────────────────────────────────────────────
// Every approval template linked to a company, with its rank coverage.
//
// Fetched as separate queries (links, then templates, then ranks) rather than
// a Supabase FK-embed, consistent with the rest of this codebase — embed-alias
// inference isn't relied on anywhere else and this path decides whether a
// booking needs approval at all.
// ─────────────────────────────────────────────────────────────────────────────

export async function getLinkedApprovalTemplates(
  service: ServiceClient,
  companyId: string
): Promise<ApprovalTemplate[]> {
  const { data: links } = await service
    .from('company_approval_templates')
    .select('template_id')
    .eq('company_id', companyId)

  const templateIds = (links ?? []).map(l => l.template_id)

  if (templateIds.length === 0) return []

  const { data: templates } = await service
    .from('approval_chain_templates')
    .select('id, name, code, category, mode, quorum, tiers')
    .in('id', templateIds)

  const ranksByTemplate = await getTemplateBandRanks(service, templateIds)

  return (templates ?? []).map(t => ({
    id: t.id,
    name: t.name,
    code: t.code,
    category: t.category,
    mode: t.mode as ChainMode,
    quorum: t.quorum as ChainQuorum,
    tiers: (t.tiers as ChainTier[] | null) ?? [],
    bandRanks: ranksByTemplate.get(t.id) ?? [],
  }))
}

// ── templatesCovering ────────────────────────────────────────────────────────
// Which templates apply to a given category at a given band rank. Category is
// part of the match, not just the rank: one template for flights_hotels and
// another for misc at the same rank is the normal arrangement, not a conflict.
//
// Returns every match rather than the first — exactly one should apply
// (enforced by constraint triggers on both company_approval_templates and
// approval_template_band_ranks), so more than one is a configuration error the
// caller should surface rather than silently resolve.
// ─────────────────────────────────────────────────────────────────────────────

export function templatesCovering(
  templates: ApprovalTemplate[],
  category: string,
  bandRank: number
): ApprovalTemplate[] {
  return templates.filter(t => t.category === category && t.bandRanks.includes(bandRank))
}
