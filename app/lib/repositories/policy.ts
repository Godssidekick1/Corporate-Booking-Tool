import { sql, empty, join, many, maybeOne, one, exec, type Queryable, type Sql } from '@/app/lib/db/sql'
import { assignments } from '@/app/lib/db/fragments'
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
// The policy master's own CRUD is at the bottom.
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

// ═══ The policy master ══════════════════════════════════════════════════════

export type PolicyGroup = Pick<Row<'policy_groups'>, 'id' | 'name' | 'code' | 'description' | 'created_at'>

const GROUP = sql`id, name, code, description, created_at`

// Search is a plain substring on name or code, as it always was.
export async function groupsForTmc(db: Queryable, tmcId: string, search?: string | null): Promise<PolicyGroup[]> {
  const term = search?.trim()
  return many<PolicyGroup>(db, sql`
    select ${GROUP} from policy_groups
    where tmc_id = ${tmcId}
    ${term ? sql`and (name ilike ${`%${term}%`} or code ilike ${`%${term}%`})` : empty}
    order by name, id`)
}

export async function group(db: Queryable, groupId: string): Promise<PolicyGroup | null> {
  return maybeOne<PolicyGroup>(db, sql`select ${GROUP} from policy_groups where id = ${groupId}`)
}

export type GroupOwner = Pick<Row<'policy_groups'>, 'id' | 'tmc_id' | 'name'>

export async function groupOwner(db: Queryable, groupId: string): Promise<GroupOwner | null> {
  return maybeOne<GroupOwner>(db, sql`select id, tmc_id, name from policy_groups where id = ${groupId}`)
}

export async function groupLabels(db: Queryable, groupIds: readonly string[]): Promise<PolicyGroupLabel[]> {
  if (groupIds.length === 0) return []
  return many<PolicyGroupLabel>(db, sql`
    select id, name, code from policy_groups where id = any(${[...groupIds]}) order by name, id`)
}

// Name and code are each unique per TMC; callers map the two to their own 409s.
export async function insertGroup(
  db: Queryable,
  g: Pick<Row<'policy_groups'>, 'tmc_id' | 'name' | 'code' | 'description'>
): Promise<PolicyGroup> {
  return one<PolicyGroup>(db, sql`
    insert into policy_groups (tmc_id, name, code, description)
    values (${g.tmc_id}, ${g.name}, ${g.code}, ${g.description})
    returning ${GROUP}`)
}

export type GroupEdit = Partial<Pick<Row<'policy_groups'>, 'name' | 'code' | 'description'>>

const GROUP_EDITABLE: Record<keyof GroupEdit, Sql> = { name: sql`name`, code: sql`code`, description: sql`description` }

export async function updateGroup(db: Queryable, groupId: string, patch: GroupEdit): Promise<void> {
  await exec(db, sql`update policy_groups set ${assignments(GROUP_EDITABLE, patch)} where id = ${groupId}`)
}

// Rules go with it (ON DELETE CASCADE).
export async function deleteGroup(db: Queryable, groupId: string): Promise<void> {
  await exec(db, sql`delete from policy_groups where id = ${groupId}`)
}

// The policy_group_band_ranks_no_overlap trigger refuses a rank already covered
// at a client this group is linked to (an exclusion violation).
export async function addRanks(db: Queryable, groupId: string, ranks: readonly number[]): Promise<void> {
  if (ranks.length === 0) return
  await exec(db, sql`
    insert into policy_group_band_ranks (policy_group_id, band_rank)
    values ${join(ranks.map(r => sql`(${groupId}, ${r})`))}`)
}

export async function removeRanks(db: Queryable, groupId: string, ranks: readonly number[]): Promise<void> {
  if (ranks.length === 0) return
  await exec(db, sql`
    delete from policy_group_band_ranks where policy_group_id = ${groupId} and band_rank = any(${[...ranks]})`)
}

// ═══ Links to clients ═══════════════════════════════════════════════════════

// Clients linked to each group. Every requested id gets an entry.
export async function clientCounts(db: Queryable, groupIds: readonly string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>(groupIds.map(id => [id, 0]))
  if (groupIds.length === 0) return counts
  const rows = await many<{ policy_group_id: string; n: number }>(db, sql`
    select policy_group_id, count(*)::int as n from client_policy_groups
    where policy_group_id = any(${[...groupIds]}) group by policy_group_id`)
  for (const r of rows) counts.set(r.policy_group_id, r.n)
  return counts
}

export type ClientLink = Pick<Row<'client_policy_groups'>, 'policy_group_id' | 'assigned_at'>

export async function links(db: Queryable, clientId: string): Promise<ClientLink[]> {
  return many<ClientLink>(db, sql`
    select policy_group_id, assigned_at from client_policy_groups
    where client_id = ${clientId} order by assigned_at, policy_group_id`)
}

// The client_policy_groups_no_overlap trigger is the backstop for two links
// racing each other (an exclusion violation).
export async function link(db: Queryable, clientId: string, groupId: string, assignedBy: string | null): Promise<void> {
  await exec(db, sql`
    insert into client_policy_groups (client_id, policy_group_id, assigned_by)
    values (${clientId}, ${groupId}, ${assignedBy})`)
}

export async function unlink(db: Queryable, clientId: string, groupId: string): Promise<void> {
  await exec(db, sql`
    delete from client_policy_groups where client_id = ${clientId} and policy_group_id = ${groupId}`)
}

// ═══ Rules: append-only versions ════════════════════════════════════════════

// The newest live version of a group's rules, 0 when it has none.
export async function latestVersion(db: Queryable, groupId: string): Promise<number> {
  const row = await one<{ v: number | null }>(db, sql`
    select max(version) as v from policy_rules where policy_group_id = ${groupId} and deleted_at is null`)
  return row.v ?? 0
}

export type RuleRow = Pick<Row<'policy_rules'>, 'id' | 'travel_type' | 'limit_key' | 'limit_value' | 'limit_bool' | 'version'>

export async function rulesAtVersion(db: Queryable, groupId: string, version: number): Promise<RuleRow[]> {
  return many<RuleRow>(db, sql`
    select id, travel_type, limit_key, limit_value, limit_bool, version from policy_rules
    where policy_group_id = ${groupId} and version = ${version} and deleted_at is null
    order by created_at, id`)
}

export type LatestRule = Pick<Row<'policy_rules'>,
  'policy_group_id' | 'version' | 'travel_type' | 'limit_key' | 'limit_value' | 'limit_bool'>

// Each group's newest live version, in ONE query: the groups version
// independently, so there is no single version number to filter on.
export async function latestRulesFor(db: Queryable, groupIds: readonly string[]): Promise<LatestRule[]> {
  if (groupIds.length === 0) return []
  return many<LatestRule>(db, sql`
    select r.policy_group_id, r.version, r.travel_type, r.limit_key, r.limit_value, r.limit_bool
    from policy_rules r
    join (
      select policy_group_id, max(version) as version from policy_rules
      where policy_group_id = any(${[...groupIds]}) and deleted_at is null
      group by policy_group_id
    ) latest on latest.policy_group_id = r.policy_group_id and latest.version = r.version
    where r.deleted_at is null
    order by r.policy_group_id, r.created_at, r.id`)
}

export interface NewRule {
  tmc_id: string
  policy_group_id: string
  travel_type: string
  limit_key: string
  limit_value: number | null
  limit_bool: boolean | null
  version: number
  updated_by: string | null
}

// client_id, band_id and band_code are legacy and always null now.
export async function insertRules(db: Queryable, rules: readonly NewRule[]): Promise<void> {
  if (rules.length === 0) return
  await exec(db, sql`
    insert into policy_rules (client_id, tmc_id, policy_group_id, band_id, band_code, travel_type, limit_key,
                              limit_value, limit_bool, locked, version, updated_by)
    values ${join(rules.map(r => sql`(
      null, ${r.tmc_id}, ${r.policy_group_id}, null, null, ${r.travel_type}, ${r.limit_key},
      ${r.limit_value}, ${r.limit_bool}, false, ${r.version}, ${r.updated_by})`))}`)
}
