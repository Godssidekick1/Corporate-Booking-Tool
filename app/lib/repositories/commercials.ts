import { sql, empty, join, many, maybeOne, one, exec, type Queryable, type Sql } from '@/app/lib/db/sql'
import { searchAcross, assignments, insertColumns } from '@/app/lib/db/fragments'
import type { Row } from '@/app/lib/db/types.generated'
import type { ResolvableRule } from '@/app/lib/commercials/resolveCommercials'
import type { CommercialKind } from '@/app/lib/commercials/calcOnByKind'

// ── Commercial rules ─────────────────────────────────────────────────────────
// Owns: commercial_rules, commercial_rule_assignments.
//
// Markup, discount and processing fee share one table, so a client's rules are
// ONE query, not one per kind. Which rule wins is resolveCommercials' decision
// (app/lib/commercials) -- nothing here ranks.
//
// Markup is TMC-internal: these rows must never reach a corporate-facing
// response. Only TMC-side routes read them.
// ─────────────────────────────────────────────────────────────────────────────

// The rule as the resolver needs it. The typed union columns (kind, calc_type…)
// are guaranteed by CHECK constraints, which is what makes the cast safe.
export async function rulesForTmc(db: Queryable, tmcId: string): Promise<ResolvableRule[]> {
  return many<ResolvableRule>(db, sql`
    select id, kind, category_id, airline_code, cabin, rbd_spec, fare_type, calc_type, calc_on, rate,
           calc_basis, exclude_tax_codes, include_ssr, active, valid_from, valid_to, created_at
    from commercial_rules where tmc_id = ${tmcId}
    order by created_at, id`)
}

export type RuleAssignment = Pick<Row<'commercial_rule_assignments'>,
  'rule_id' | 'kind' | 'client_id' | 'client_group_id' | 'bucket_id'>

export async function assignmentsForTmc(db: Queryable, tmcId: string): Promise<RuleAssignment[]> {
  return many<RuleAssignment>(db, sql`
    select rule_id, kind, client_id, client_group_id, bucket_id
    from commercial_rule_assignments where tmc_id = ${tmcId}
    order by id`)
}

// ═══ The rules master ═══════════════════════════════════════════════════════

export type RuleRecord = Omit<Row<'commercial_rules'>, 'tmc_id' | 'kind'> & { kind: CommercialKind }

const RULE = sql`
  id, kind, category_id, airline_code, cabin, rbd_spec, fare_type, calc_type, calc_on, rate,
  calc_basis, exclude_tax_codes, include_ssr, active, valid_from, valid_to, notes, created_by,
  created_at, updated_at`

export interface RuleFilter {
  kind?: string | null
  categoryId?: string | null
  search?: string
}

// Newest first. Status is NOT filterable here: it is derived from `active`
// and the validity window by commercialStatus(), and writing that rule a
// second time as SQL is how the two would drift. Callers filter in memory.
export async function listRules(db: Queryable, tmcId: string, filter: RuleFilter = {}): Promise<RuleRecord[]> {
  return many<RuleRecord>(db, sql`
    select ${RULE} from commercial_rules
    where tmc_id = ${tmcId}
      ${filter.kind ? sql`and kind = ${filter.kind}` : empty}
      ${filter.categoryId ? sql`and category_id = ${filter.categoryId}` : empty}
      ${searchAcross([sql`airline_code`, sql`notes`], filter.search)}
    order by created_at desc, id`)
}

export async function rule(db: Queryable, ruleId: string, tmcId: string): Promise<RuleRecord | null> {
  return maybeOne<RuleRecord>(db, sql`
    select ${RULE} from commercial_rules where id = ${ruleId} and tmc_id = ${tmcId}`)
}

export type RuleFields = Partial<Omit<Row<'commercial_rules'>, 'id' | 'tmc_id' | 'created_at' | 'updated_at' | 'created_by'>>

const RULE_WRITABLE: Record<keyof RuleFields, Sql> = {
  kind: sql`kind`, category_id: sql`category_id`, airline_code: sql`airline_code`, cabin: sql`cabin`,
  rbd_spec: sql`rbd_spec`, fare_type: sql`fare_type`, calc_type: sql`calc_type`, calc_on: sql`calc_on`,
  rate: sql`rate`, calc_basis: sql`calc_basis`, exclude_tax_codes: sql`exclude_tax_codes`,
  include_ssr: sql`include_ssr`, valid_from: sql`valid_from`, valid_to: sql`valid_to`,
  active: sql`active`, notes: sql`notes`,
}

export async function insertRule(
  db: Queryable,
  tmcId: string,
  createdBy: string,
  fields: RuleFields
): Promise<RuleRecord> {
  const columns = { ...RULE_WRITABLE, tmc_id: sql`tmc_id`, created_by: sql`created_by` }
  return one<RuleRecord>(db, sql`
    insert into commercial_rules ${insertColumns(columns, { ...fields, tmc_id: tmcId, created_by: createdBy })}
    returning ${RULE}`)
}

// Scoped to the TMC in the write itself. Null when the rule is not theirs.
export async function updateRule(
  db: Queryable,
  ruleId: string,
  tmcId: string,
  fields: RuleFields
): Promise<RuleRecord | null> {
  const columns = { ...RULE_WRITABLE, updated_at: sql`updated_at` }
  return maybeOne<RuleRecord>(db, sql`
    update commercial_rules set ${assignments(columns, { ...fields, updated_at: new Date().toISOString() })}
    where id = ${ruleId} and tmc_id = ${tmcId}
    returning ${RULE}`)
}

// Assignments cascade: they exist only to say who this rule reaches.
export async function deleteRule(db: Queryable, ruleId: string, tmcId: string): Promise<void> {
  await exec(db, sql`delete from commercial_rules where id = ${ruleId} and tmc_id = ${tmcId}`)
}

// ═══ Who a rule reaches ═════════════════════════════════════════════════════

export type AssignmentRecord = Pick<Row<'commercial_rule_assignments'>,
  'id' | 'rule_id' | 'kind' | 'client_id' | 'client_group_id' | 'bucket_id' | 'created_at'>

export async function assignmentList(db: Queryable, tmcId: string, ruleId?: string | null): Promise<AssignmentRecord[]> {
  return many<AssignmentRecord>(db, sql`
    select id, rule_id, kind, client_id, client_group_id, bucket_id, created_at
    from commercial_rule_assignments
    where tmc_id = ${tmcId} ${ruleId ? sql`and rule_id = ${ruleId}` : empty}
    order by created_at, id`)
}

// How many targets each rule reaches -- the blast radius of an edit.
export async function targetCounts(db: Queryable, tmcId: string): Promise<Map<string, number>> {
  const rows = await many<{ rule_id: string; n: number }>(db, sql`
    select rule_id, count(*)::int as n from commercial_rule_assignments
    where tmc_id = ${tmcId} group by rule_id`)
  return new Map(rows.map(r => [r.rule_id, r.n]))
}

export type NewAssignment = Pick<Row<'commercial_rule_assignments'>,
  'rule_id' | 'kind' | 'client_id' | 'client_group_id' | 'bucket_id'>

// Returns how many were NEW. The three partial unique indexes (one per target
// kind) make re-assigning the same target a no-op rather than an error.
export async function assign(
  db: Queryable,
  tmcId: string,
  createdBy: string,
  rows: readonly NewAssignment[]
): Promise<number> {
  if (rows.length === 0) return 0
  const values = join(rows.map(r => sql`(
    ${tmcId}, ${r.rule_id}, ${r.kind}, ${r.client_id}, ${r.client_group_id}, ${r.bucket_id}, ${createdBy})`))
  return exec(db, sql`
    insert into commercial_rule_assignments (tmc_id, rule_id, kind, client_id, client_group_id, bucket_id, created_by)
    values ${values}
    on conflict do nothing`)
}

export async function unassign(db: Queryable, assignmentId: string, tmcId: string): Promise<void> {
  await exec(db, sql`delete from commercial_rule_assignments where id = ${assignmentId} and tmc_id = ${tmcId}`)
}
