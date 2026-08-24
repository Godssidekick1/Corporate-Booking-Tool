import { createServiceClient } from '@/utils/supabase/service'

type ServiceClient = ReturnType<typeof createServiceClient>

export interface LinkedPolicyGroup {
  id: string
  name: string
  code: string | null
  min_band_rank: number | null
  max_band_rank: number | null
}

// ── getLinkedPolicyGroups ────────────────────────────────────────────────────
// Every policy group linked to a company, with its rank range.
//
// Fetched as two queries (link rows, then group rows) rather than a Supabase
// FK-embed — same reasoning used everywhere else in this codebase: embed-alias
// inference isn't relied on elsewhere, so this stays consistent rather than
// introducing untested syntax in a path this central.
//
// Shared by resolveEffectivePolicy (one employee's rank) and the corporate
// read-only policy view (every band the company has), so the two can never
// disagree about which groups apply to a company.
// ─────────────────────────────────────────────────────────────────────────────

export async function getLinkedPolicyGroups(
  service: ServiceClient,
  companyId: string
): Promise<LinkedPolicyGroup[]> {
  const { data: links } = await service
    .from('company_policy_groups')
    .select('policy_group_id')
    .eq('company_id', companyId)

  const groupIds = (links ?? []).map(l => l.policy_group_id)

  if (groupIds.length === 0) return []

  const { data: groups } = await service
    .from('policy_groups')
    .select('id, name, code, min_band_rank, max_band_rank')
    .in('id', groupIds)

  return groups ?? []
}

// ── groupsCoveringRank ───────────────────────────────────────────────────────
// Which of the given groups apply at a specific band rank. NULL min/max means
// "unbounded on that side" — a group with no explicit range covers every rank,
// which matches how a TMC admin would reasonably expect an unrestricted group
// to behave rather than silently matching nothing.
//
// Returns every match rather than the first: exactly one group should ever
// cover a given rank, and callers treat more than one as a configuration error
// worth surfacing instead of arbitrarily picking a winner.
// ─────────────────────────────────────────────────────────────────────────────

export function groupsCoveringRank<T extends { min_band_rank: number | null; max_band_rank: number | null }>(
  groups: T[],
  bandRank: number
): T[] {
  return groups.filter(g => {
    const withinMin = g.min_band_rank === null || bandRank >= g.min_band_rank
    const withinMax = g.max_band_rank === null || bandRank <= g.max_band_rank
    return withinMin && withinMax
  })
}
