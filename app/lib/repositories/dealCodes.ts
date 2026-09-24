import { sql, empty, join, many, maybeOne, one, exec, type Queryable, type Sql } from '@/app/lib/db/sql'
import { assignments, searchAcross } from '@/app/lib/db/fragments'
import type { Row } from '@/app/lib/db/types.generated'
import type { ResolvableDeal, AssignmentKind } from '@/app/lib/deal-codes/resolveDealCodes'

// ── Deal codes ───────────────────────────────────────────────────────────────
// Owns: deal_codes, deal_code_assignments, deal_code_categories,
// deal_code_category_types.
//
// A deal code reaches a client in one of three ways (an assignment's `kind`):
// directly, through a bucket the client is in, or through the client's group.
//
// The master and its assignments are at the bottom.
// ─────────────────────────────────────────────────────────────────────────────

// kind is CHECK-constrained to the three ways a deal reaches a client.
export type DealAssignment = Omit<Pick<Row<'deal_code_assignments'>,
  'id' | 'deal_code_id' | 'kind' | 'client_id' | 'client_group_id' | 'bucket_id'>, 'kind'> & { kind: AssignmentKind }

// Every assignment in the TMC. The caller decides which reach a given client,
// so the rule for "reaches" lives in one place in the domain code.
export async function assignmentsForTmc(db: Queryable, tmcId: string): Promise<DealAssignment[]> {
  return many<DealAssignment>(db, sql`
    select id, deal_code_id, kind, client_id, client_group_id, bucket_id
    from deal_code_assignments where tmc_id = ${tmcId}
    order by id`)
}

export type DealCodeLabel = Pick<Row<'deal_codes'>, 'id' | 'code' | 'code_type' | 'airline_code'>

export async function labels(db: Queryable, dealCodeIds: readonly string[]): Promise<DealCodeLabel[]> {
  if (dealCodeIds.length === 0) return []
  return many<DealCodeLabel>(db, sql`
    select id, code, code_type, airline_code from deal_codes
    where id = any(${[...dealCodeIds]})
    order by airline_code, code, id`)
}

// ═══ Reach through buckets ══════════════════════════════════════════════════

export async function countByBucket(db: Queryable, bucketIds: readonly string[]): Promise<Map<string, number>> {
  if (bucketIds.length === 0) return new Map()
  const rows = await many<{ bucket_id: string; n: number }>(db, sql`
    select bucket_id, count(*)::int as n from deal_code_assignments
    where bucket_id = any(${[...bucketIds]}) group by bucket_id`)
  return new Map(rows.map(r => [r.bucket_id, r.n]))
}

export async function countForBucket(db: Queryable, bucketId: string): Promise<number> {
  return (await one<{ n: number }>(db, sql`
    select count(*)::int as n from deal_code_assignments where bucket_id = ${bucketId}`)).n
}

export async function idsForBucket(db: Queryable, bucketId: string): Promise<string[]> {
  const rows = await many<{ deal_code_id: string }>(db, sql`
    select deal_code_id from deal_code_assignments where bucket_id = ${bucketId} order by deal_code_id`)
  return rows.map(r => r.deal_code_id)
}

// ═══ Resolution ═════════════════════════════════════════════════════════════

// The deal as resolveDealCodes reads it. Dates arrive as 'YYYY-MM-DD' strings
// (the DATE type parser), which is what the resolver compares against.
export async function forResolution(db: Queryable, dealCodeIds: readonly string[]): Promise<ResolvableDeal[]> {
  if (dealCodeIds.length === 0) return []
  return many<ResolvableDeal>(db, sql`
    select id, code, code_type, airline_code, flight_spec, active,
           sales_from, sales_to, travel_from, travel_to, created_at
    from deal_codes where id = any(${[...dealCodeIds]})
    order by created_at, id`)
}

// Category code -> id for a TMC. Commercial rules match on category, which a
// booking derives from its own flight (DOMAIRBSP, INTAIRLCC…).
export async function categoryIdsByCode(db: Queryable, tmcId: string): Promise<Map<string, string>> {
  const rows = await many<{ id: string; code: string }>(db, sql`
    select id, code from deal_code_categories where tmc_id = ${tmcId} order by created_at, id`)
  return new Map(rows.map(r => [r.code, r.id]))
}

export type CategoryLabel = Pick<Row<'deal_code_categories'>, 'id' | 'code' | 'label'>

export async function categoriesForTmc(db: Queryable, tmcId: string): Promise<CategoryLabel[]> {
  return many<CategoryLabel>(db, sql`
    select id, code, label from deal_code_categories where tmc_id = ${tmcId} order by code, id`)
}

// Only if it is this TMC's -- a category id from another tenant must not be
// borrowable by a rule filed here.
export async function categoryInTmc(db: Queryable, categoryId: string, tmcId: string): Promise<boolean> {
  const row = await maybeOne<{ ok: boolean }>(db, sql`
    select true as ok from deal_code_categories where id = ${categoryId} and tmc_id = ${tmcId}`)
  return row !== null
}

// ═══ The deal code master ═══════════════════════════════════════════════════

export type DealCodeRecord = Pick<Row<'deal_codes'>,
  | 'id' | 'category_id' | 'airline_code' | 'code' | 'code_type' | 'flight_spec' | 'sales_from' | 'sales_to'
  | 'travel_from' | 'travel_to' | 'active' | 'notes' | 'created_by' | 'created_at'
>

const DEAL = sql`id, category_id, airline_code, code, code_type, flight_spec, sales_from, sales_to,
  travel_from, travel_to, active, notes, created_by, created_at`

export interface DealFilter {
  categoryId?: string | null
  codeType?: string | null
  search?: string | null
}

// Status is derived in the domain (dealCodeStatus), so it is filtered there.
export async function listForTmc(db: Queryable, tmcId: string, f: DealFilter): Promise<DealCodeRecord[]> {
  return many<DealCodeRecord>(db, sql`
    select ${DEAL} from deal_codes
    where tmc_id = ${tmcId}
    ${f.categoryId ? sql`and category_id = ${f.categoryId}` : empty}
    ${f.codeType ? sql`and code_type = ${f.codeType}` : empty}
    ${searchAcross([sql`code`, sql`airline_code`], f.search)}
    order by airline_code, code, id`)
}

export async function dealCode(db: Queryable, dealCodeId: string): Promise<DealCodeRecord | null> {
  return maybeOne<DealCodeRecord>(db, sql`select ${DEAL} from deal_codes where id = ${dealCodeId}`)
}

// Only if it is this TMC's.
export async function dealInTmc(
  db: Queryable,
  dealCodeId: string,
  tmcId: string
): Promise<Pick<Row<'deal_codes'>, 'id' | 'tmc_id' | 'code'> | null> {
  return maybeOne(db, sql`select id, tmc_id, code from deal_codes where id = ${dealCodeId} and tmc_id = ${tmcId}`)
}

export type DealEditBase = Pick<Row<'deal_codes'>, 'category_id' | 'airline_code' | 'code_type' | 'flight_spec'>

export async function editBase(db: Queryable, dealCodeId: string): Promise<DealEditBase | null> {
  return maybeOne<DealEditBase>(db, sql`
    select category_id, airline_code, code_type, flight_spec from deal_codes where id = ${dealCodeId}`)
}

export type NewDealCode = Pick<Row<'deal_codes'>,
  | 'tmc_id' | 'category_id' | 'airline_code' | 'code' | 'code_type' | 'flight_spec' | 'sales_from'
  | 'sales_to' | 'travel_from' | 'travel_to' | 'active' | 'notes' | 'created_by'
>

function dealValues(d: NewDealCode): Sql {
  return sql`(${d.tmc_id}, ${d.category_id}, ${d.airline_code}, ${d.code}, ${d.code_type}, ${d.flight_spec},
    ${d.sales_from}, ${d.sales_to}, ${d.travel_from}, ${d.travel_to}, ${d.active}, ${d.notes}, ${d.created_by})`
}

const DEAL_INSERT = sql`insert into deal_codes (tmc_id, category_id, airline_code, code, code_type, flight_spec,
  sales_from, sales_to, travel_from, travel_to, active, notes, created_by)`

export async function insertDeal(db: Queryable, d: NewDealCode): Promise<DealCodeRecord> {
  return one<DealCodeRecord>(db, sql`${DEAL_INSERT} values ${dealValues(d)} returning ${DEAL}`)
}

// One statement: an import lands whole or not at all.
export async function insertDeals(db: Queryable, deals: readonly NewDealCode[]): Promise<void> {
  if (deals.length === 0) return
  await exec(db, sql`${DEAL_INSERT} values ${join(deals.map(dealValues))}`)
}

export type DealEdit = Partial<Pick<Row<'deal_codes'>,
  | 'category_id' | 'airline_code' | 'code' | 'code_type' | 'flight_spec' | 'sales_from' | 'sales_to'
  | 'travel_from' | 'travel_to' | 'active' | 'notes'
>>

const DEAL_EDITABLE: Record<keyof DealEdit, Sql> = {
  category_id: sql`category_id`, airline_code: sql`airline_code`, code: sql`code`, code_type: sql`code_type`,
  flight_spec: sql`flight_spec`, sales_from: sql`sales_from`, sales_to: sql`sales_to`,
  travel_from: sql`travel_from`, travel_to: sql`travel_to`, active: sql`active`, notes: sql`notes`,
}

export async function updateDeal(db: Queryable, dealCodeId: string, patch: DealEdit): Promise<DealCodeRecord> {
  const set = Object.values(patch).some(v => v !== undefined)
    ? sql`${assignments(DEAL_EDITABLE, patch)}, updated_at = now()`
    : sql`updated_at = now()`
  return one<DealCodeRecord>(db, sql`update deal_codes set ${set} where id = ${dealCodeId} returning ${DEAL}`)
}

// Assignments cascade; callers refuse while any exist.
export async function deleteDeal(db: Queryable, dealCodeId: string): Promise<void> {
  await exec(db, sql`delete from deal_codes where id = ${dealCodeId}`)
}

// For the spreadsheet: every deal with its category's code in place of the id.
export type DealCsvRow = Omit<DealCodeRecord, 'id' | 'category_id' | 'created_by' | 'created_at'> & { category: string | null }

export async function csvRows(db: Queryable, tmcId: string): Promise<DealCsvRow[]> {
  return many<DealCsvRow>(db, sql`
    select d.code, d.code_type, d.airline_code, c.code as category, d.flight_spec, d.sales_from, d.sales_to,
           d.travel_from, d.travel_to, d.active, d.notes
    from deal_codes d
    left join deal_code_categories c on c.id = d.category_id
    where d.tmc_id = ${tmcId}
    order by d.airline_code, d.code, d.id`)
}

// ═══ Who a deal reaches ═════════════════════════════════════════════════════

// Assignments per deal, for the master's "reaches N" column.
export async function targetCounts(db: Queryable, tmcId: string): Promise<Map<string, number>> {
  const rows = await many<{ deal_code_id: string; n: number }>(db, sql`
    select deal_code_id, count(*)::int as n from deal_code_assignments
    where tmc_id = ${tmcId} group by deal_code_id`)
  return new Map(rows.map(r => [r.deal_code_id, r.n]))
}

export async function countForDeal(db: Queryable, dealCodeId: string): Promise<number> {
  return (await one<{ n: number }>(db, sql`
    select count(*)::int as n from deal_code_assignments where deal_code_id = ${dealCodeId}`)).n
}

export interface NamedAssignment {
  id: string
  kind: string
  targetId: string
  targetName: string
}

// One query where the old path made four: the target's name comes from
// whichever of the three tables the kind points at.
export async function namedAssignments(db: Queryable, dealCodeId: string): Promise<NamedAssignment[]> {
  return many<NamedAssignment>(db, sql`
    select a.id, a.kind,
           coalesce(a.client_id, a.client_group_id, a.bucket_id) as "targetId",
           coalesce(c.name, g.name, b.name, 'Unknown') as "targetName"
    from deal_code_assignments a
    left join clients c on c.id = a.client_id
    left join client_groups g on g.id = a.client_group_id
    left join buckets b on b.id = a.bucket_id
    where a.deal_code_id = ${dealCodeId}
    order by a.created_at, a.id`)
}

export type DealAssignmentRow = DealAssignment & Pick<Row<'deal_code_assignments'>, 'created_at'>

export async function assignmentList(db: Queryable, tmcId: string, dealCodeId?: string | null): Promise<DealAssignmentRow[]> {
  return many<DealAssignmentRow>(db, sql`
    select id, deal_code_id, kind, client_id, client_group_id, bucket_id, created_at
    from deal_code_assignments
    where tmc_id = ${tmcId} ${dealCodeId ? sql`and deal_code_id = ${dealCodeId}` : empty}
    order by created_at, id`)
}

export interface NewAssignment {
  kind: 'client' | 'client_group' | 'bucket'
  targetId: string
}

// Re-assigning is a no-op, not an error: the partial unique indexes (one per
// target column) make the duplicate harmless, and DO NOTHING keeps the rest of
// the batch.
export async function assign(
  db: Queryable,
  tmcId: string,
  dealCodeId: string,
  targets: readonly NewAssignment[],
  createdBy: string
): Promise<void> {
  if (targets.length === 0) return
  const column = (t: NewAssignment, kind: NewAssignment['kind']) => (t.kind === kind ? t.targetId : null)
  await exec(db, sql`
    insert into deal_code_assignments (tmc_id, deal_code_id, kind, client_id, client_group_id, bucket_id, created_by)
    values ${join(targets.map(t => sql`(${tmcId}, ${dealCodeId}, ${t.kind},
      ${column(t, 'client')}, ${column(t, 'client_group')}, ${column(t, 'bucket')}, ${createdBy})`))}
    on conflict do nothing`)
}

// Scoped by tenant in the delete itself, so there is no check-then-write gap.
export async function unassign(db: Queryable, assignmentId: string, tmcId: string): Promise<void> {
  await exec(db, sql`delete from deal_code_assignments where id = ${assignmentId} and tmc_id = ${tmcId}`)
}

// ═══ Categories and the type matrix ═════════════════════════════════════════

export type Category = Pick<Row<'deal_code_categories'>, 'id' | 'code' | 'label' | 'active'>

export async function categories(db: Queryable, tmcId: string): Promise<Category[]> {
  return many<Category>(db, sql`
    select id, code, label, active from deal_code_categories where tmc_id = ${tmcId} order by code, id`)
}

export async function categoryOf(
  db: Queryable,
  categoryId: string,
  tmcId: string
): Promise<Pick<Row<'deal_code_categories'>, 'id' | 'code'> | null> {
  return maybeOne(db, sql`select id, code from deal_code_categories where id = ${categoryId} and tmc_id = ${tmcId}`)
}

// The code types each category permits.
export async function allowedTypes(db: Queryable, categoryIds: readonly string[]): Promise<Map<string, string[]>> {
  const byCategory = new Map<string, string[]>()
  if (categoryIds.length === 0) return byCategory
  const rows = await many<{ category_id: string; code_type: string }>(db, sql`
    select category_id, code_type from deal_code_category_types
    where category_id = any(${[...categoryIds]}) and allowed
    order by category_id, code_type`)
  for (const r of rows) byCategory.set(r.category_id, [...(byCategory.get(r.category_id) ?? []), r.code_type])
  return byCategory
}

export interface CategorySeed {
  code: string
  label: string
  types: Record<string, boolean>
}

// Idempotent: the categories and their matrix rows are inserted only where
// missing, so two first reads racing each other both succeed and seed once.
// The caller runs it in a transaction.
export async function seedCategories(db: Queryable, tmcId: string, seeds: readonly CategorySeed[]): Promise<void> {
  if (seeds.length === 0) return
  await exec(db, sql`
    insert into deal_code_categories (tmc_id, code, label)
    values ${join(seeds.map(s => sql`(${tmcId}, ${s.code}, ${s.label})`))}
    on conflict (tmc_id, code) do nothing`)
  const matrix = seeds.flatMap(s => Object.entries(s.types).map(([type, allowed]) => ({ code: s.code, type, allowed })))
  if (matrix.length === 0) return
  await exec(db, sql`
    insert into deal_code_category_types (category_id, code_type, allowed)
    select c.id, m.code_type, m.allowed
    from (values ${join(matrix.map(m => sql`(${m.code}, ${m.type}, ${m.allowed}::boolean)`))}) as m(code, code_type, allowed)
    join deal_code_categories c on c.tmc_id = ${tmcId} and c.code = m.code
    on conflict (category_id, code_type) do nothing`)
}
