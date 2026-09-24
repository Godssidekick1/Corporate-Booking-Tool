import type { Queryable } from '@/app/lib/db'
import * as policy from '@/app/lib/repositories/policy'

// Every function here takes `db` -- the pool or a transaction's connection.
// Rank sets are policy.bandRanksByGroup: coverage is an explicit set rather
// than a min..max range, so a group can cover non-contiguous ranks (1, 4, 7).

export interface LinkedPolicyGroup {
  id: string
  name: string
  code: string | null
  bandRanks: number[]
}

// ── getLinkedPolicyGroups ────────────────────────────────────────────────────
// Every policy group linked to a client, with the ranks it covers.
//
// Two queries: the linked groups (one join), then their ranks.
//
// Shared by resolveEffectivePolicy (one employee's rank) and the corporate
// read-only policy view (every band the client has), so the two can never
// disagree about which groups apply to a client.
// ─────────────────────────────────────────────────────────────────────────────

export async function getLinkedPolicyGroups(
  db: Queryable,
  clientId: string
): Promise<LinkedPolicyGroup[]> {
  const groups = await policy.linkedGroups(db, clientId)

  if (groups.length === 0) return []

  const ranksByGroup = await policy.bandRanksByGroup(db, groups.map(g => g.id))

  return groups.map(g => ({
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
