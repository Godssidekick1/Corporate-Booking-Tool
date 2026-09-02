import { createServiceClient } from '@/utils/supabase/service'

type ServiceClient = ReturnType<typeof createServiceClient>

export interface LinkedPolicyGroup {
  id: string
  name: string
  code: string | null
  bandRanks: number[]
}

// ── getBandRanksByGroup ──────────────────────────────────────────────────────
// Rank sets for the given groups, as a map of group id -> sorted ranks.
//
// Coverage is an explicit set rather than a min..max range so a group can cover
// non-contiguous ranks (1, 4, 7) — a range could only ever express a
// contiguous span.
// ─────────────────────────────────────────────────────────────────────────────

export async function getBandRanksByGroup(
  service: ServiceClient,
  groupIds: string[]
): Promise<Map<string, number[]>> {
  const byGroup = new Map<string, number[]>()

  if (groupIds.length === 0) return byGroup

  const { data: rankRows } = await service
    .from('policy_group_band_ranks')
    .select('policy_group_id, band_rank')
    .in('policy_group_id', groupIds)

  for (const row of rankRows ?? []) {
    const existing = byGroup.get(row.policy_group_id)
    if (existing) existing.push(row.band_rank)
    else byGroup.set(row.policy_group_id, [row.band_rank])
  }

  for (const ranks of byGroup.values()) ranks.sort((a, b) => a - b)

  // Groups with no ranks yet still need an entry, otherwise callers can't tell
  // "not fetched" from "covers nothing".
  for (const id of groupIds) {
    if (!byGroup.has(id)) byGroup.set(id, [])
  }

  return byGroup
}

// ── getLinkedPolicyGroups ────────────────────────────────────────────────────
// Every policy group linked to a client, with the ranks it covers.
//
// Fetched as separate queries (link rows, then group rows, then ranks) rather
// than a Supabase FK-embed — same reasoning used everywhere else in this
// codebase: embed-alias inference isn't relied on elsewhere, so this stays
// consistent rather than introducing untested syntax in a path this central.
//
// Shared by resolveEffectivePolicy (one employee's rank) and the corporate
// read-only policy view (every band the client has), so the two can never
// disagree about which groups apply to a client.
// ─────────────────────────────────────────────────────────────────────────────

export async function getLinkedPolicyGroups(
  service: ServiceClient,
  clientId: string
): Promise<LinkedPolicyGroup[]> {
  const { data: links } = await service
    .from('client_policy_groups')
    .select('policy_group_id')
    .eq('client_id', clientId)

  const groupIds = (links ?? []).map(l => l.policy_group_id)

  if (groupIds.length === 0) return []

  const { data: groups } = await service
    .from('policy_groups')
    .select('id, name, code')
    .in('id', groupIds)

  const ranksByGroup = await getBandRanksByGroup(service, groupIds)

  return (groups ?? []).map(g => ({
    id: g.id,
    name: g.name,
    code: g.code,
    bandRanks: ranksByGroup.get(g.id) ?? [],
  }))
}

// ── groupsCoveringRank ───────────────────────────────────────────────────────
// Which of the given groups cover a specific band rank — plain set membership.
//
// A group with an empty rank set covers nothing. That is deliberate: under the
// old range model a group with NULL bounds silently covered every rank, so a
// half-configured group could capture employees it was never meant to. An
// explicit set has no such ambiguity — you cover exactly what you listed.
//
// Returns every match rather than the first: exactly one group should ever
// cover a given rank (enforced by constraint triggers on both
// client_policy_groups and policy_group_band_ranks), and callers treat more
// than one as a configuration error worth surfacing rather than arbitrarily
// picking a winner.
// ─────────────────────────────────────────────────────────────────────────────

export function groupsCoveringRank<T extends { bandRanks: number[] }>(
  groups: T[],
  bandRank: number
): T[] {
  return groups.filter(g => g.bandRanks.includes(bandRank))
}
