import { sql, many, type Queryable } from '@/app/lib/db/sql'
import type { Row } from '@/app/lib/db/types.generated'
import type { ResolvableRule } from '@/app/lib/commercials/resolveCommercials'

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
