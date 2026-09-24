import { sql, many, type Queryable } from '@/app/lib/db/sql'
import type { Row } from '@/app/lib/db/types.generated'

// ── Policy ───────────────────────────────────────────────────────────────────
// Owns: policy_groups, policy_rules, policy_group_band_ranks,
// client_policy_groups.
//
// A policy group is a client-agnostic template covering an explicit SET of
// band ranks, linked to clients many-to-many. Which group governs a traveller
// (their rank, the client's links) is decided in app/lib/rule-engine; this
// module only reads the pieces.
//
// The policy master's own CRUD moves here in a later phase.
// ─────────────────────────────────────────────────────────────────────────────

// Rank sets for the given groups, group id -> ranks ascending. Every requested
// id gets an entry, empty when it covers nothing -- callers must be able to
// tell "not fetched" from "covers nothing".
export async function bandRanksByGroup(db: Queryable, groupIds: readonly string[]): Promise<Map<string, number[]>> {
  const byGroup = new Map<string, number[]>(groupIds.map(id => [id, []]))
  if (groupIds.length === 0) return byGroup

  const rows = await many<{ policy_group_id: string; band_rank: number }>(db, sql`
    select policy_group_id, band_rank from policy_group_band_ranks
    where policy_group_id = any(${[...groupIds]})
    order by policy_group_id, band_rank`)

  for (const r of rows) byGroup.get(r.policy_group_id)?.push(r.band_rank)
  return byGroup
}

export type PolicyGroupLabel = Pick<Row<'policy_groups'>, 'id' | 'name' | 'code'>

// The groups linked to a client. One join where the old path made three calls.
export async function linkedGroups(db: Queryable, clientId: string): Promise<PolicyGroupLabel[]> {
  return many<PolicyGroupLabel>(db, sql`
    select g.id, g.name, g.code
    from client_policy_groups l
    join policy_groups g on g.id = l.policy_group_id
    where l.client_id = ${clientId}
    order by g.name, g.id`)
}

export type LiveRule = Pick<Row<'policy_rules'>, 'version' | 'travel_type' | 'limit_key' | 'limit_value' | 'limit_bool'>

// Every live (not soft-deleted) rule of a group, newest version first. The
// caller keeps the newest version of the WHOLE set -- see
// resolveEffectivePolicy for why that must not be "the newest version that
// has this category".
export async function liveRules(db: Queryable, groupId: string): Promise<LiveRule[]> {
  return many<LiveRule>(db, sql`
    select version, travel_type, limit_key, limit_value, limit_bool
    from policy_rules
    where policy_group_id = ${groupId} and deleted_at is null
    order by version desc, id`)
}
