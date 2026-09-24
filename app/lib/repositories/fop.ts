import { sql, empty, join, many, maybeOne, one, exec, type Queryable, type Sql } from '@/app/lib/db/sql'
import { assignments, insertColumns, page, searchAcross } from '@/app/lib/db/fragments'
import type { PageParams } from '@/app/lib/pagination'
import type { Row } from '@/app/lib/db/types.generated'
import type { ResolvableFop } from '@/app/lib/fop/resolveFop'

// ── Forms of payment ─────────────────────────────────────────────────────────
// Owns: forms_of_payment, fop_assignments, fop_gds_entries, fop_payment_types.
//
// Reaches clients the same three ways deal codes do (client, bucket, client
// group). The master's own CRUD is below the resolution read.
//
// Card fields (last4, expiry) are selected by forResolution, whose result
// is frozen onto a booking, and by the TMC master screens. The label and
// assignment reads never select them.
// ─────────────────────────────────────────────────────────────────────────────

export type FopAssignment = Pick<Row<'fop_assignments'>,
  'id' | 'fop_id' | 'kind' | 'client_id' | 'client_group_id' | 'bucket_id' | 'is_active'>

export async function assignmentsForTmc(db: Queryable, tmcId: string): Promise<FopAssignment[]> {
  return many<FopAssignment>(db, sql`
    select id, fop_id, kind, client_id, client_group_id, bucket_id, is_active
    from fop_assignments where tmc_id = ${tmcId}
    order by id`)
}

export type FopLabel = Pick<Row<'forms_of_payment'>, 'id' | 'fop_code' | 'label' | 'payer' | 'fop_type'>

export async function labels(db: Queryable, fopIds: readonly string[]): Promise<FopLabel[]> {
  if (fopIds.length === 0) return []
  return many<FopLabel>(db, sql`
    select id, fop_code, label, payer, fop_type from forms_of_payment
    where id = any(${[...fopIds]})
    order by id`)
}

export async function countForBucket(db: Queryable, bucketId: string): Promise<number> {
  return (await one<{ n: number }>(db, sql`
    select count(*)::int as n from fop_assignments where bucket_id = ${bucketId}`)).n
}

// ═══ Resolution ═════════════════════════════════════════════════════════════

// Every form of payment at the TMC, as resolveFop ranks them. The card
// fields ARE read here: the resolved choice is frozen onto the booking with
// its description ("Amex ···· 1111"), which is how a counsellor knows which
// card to charge.
export async function forResolution(db: Queryable, tmcId: string): Promise<ResolvableFop[]> {
  return many<ResolvableFop>(db, sql`
    select id, label, fop_type, payer, card_type, last4, expiry_month, expiry_year, branch_id,
           airline_code, rbd_spec, active, is_default, created_at
    from forms_of_payment where tmc_id = ${tmcId}
    order by created_at, id`)
}

// ═══ The master ═════════════════════════════════════════════════════════════
// The TMC screens DO read the card fields (last4, expiry) -- a counsellor picks
// a card by them. Who may see which row is the route's visibility rule.

export type FopRecord = Pick<Row<'forms_of_payment'>,
  | 'id' | 'fop_code' | 'label' | 'fop_type' | 'payer' | 'gds_entry_id' | 'payment_type_id' | 'card_type'
  | 'last4' | 'expiry_month' | 'expiry_year' | 'gds_alias' | 'branch_id' | 'owner_client_id'
  | 'owner_employee_id' | 'airline_code' | 'rbd_spec' | 'active' | 'is_default' | 'notes' | 'created_at'
>

const FOP = sql`id, fop_code, label, fop_type, payer, gds_entry_id, payment_type_id, card_type, last4,
  expiry_month, expiry_year, gds_alias, branch_id, owner_client_id, owner_employee_id, airline_code,
  rbd_spec, active, is_default, notes, created_at`

export interface FopFilter {
  ids?: readonly string[]
  type?: string | null
  payer?: string | null
  ownerClientId?: string | null
  search?: string | null
}

// With ids, exactly those (the other filters are ignored, as the picker that
// sends ids expects). Status is derived in the domain, so it is filtered there.
export async function listForTmc(db: Queryable, tmcId: string, f: FopFilter): Promise<FopRecord[]> {
  const filters = f.ids && f.ids.length > 0
    ? sql`and id = any(${[...f.ids]})`
    : sql`
      ${f.type ? sql`and fop_type = ${f.type}` : empty}
      ${f.payer ? sql`and payer = ${f.payer}` : empty}
      ${f.ownerClientId ? sql`and owner_client_id = ${f.ownerClientId}` : empty}
      ${searchAcross([sql`fop_code`, sql`label`, sql`airline_code`, sql`last4`], f.search)}`
  return many<FopRecord>(db, sql`
    select ${FOP} from forms_of_payment where tmc_id = ${tmcId} ${filters}
    order by label, id`)
}

export async function fop(db: Queryable, fopId: string): Promise<FopRecord | null> {
  return maybeOne<FopRecord>(db, sql`select ${FOP} from forms_of_payment where id = ${fopId}`)
}

export async function fopInTmc(
  db: Queryable,
  fopId: string,
  tmcId: string
): Promise<Pick<Row<'forms_of_payment'>, 'id' | 'tmc_id' | 'label'> | null> {
  return maybeOne(db, sql`select id, tmc_id, label from forms_of_payment where id = ${fopId} and tmc_id = ${tmcId}`)
}

export type NewFop = Omit<FopRecord, 'id' | 'created_at'> & Pick<Row<'forms_of_payment'>, 'tmc_id' | 'created_by'>

const FOP_COLUMNS: Record<keyof NewFop, Sql> = {
  tmc_id: sql`tmc_id`, fop_code: sql`fop_code`, label: sql`label`, fop_type: sql`fop_type`, payer: sql`payer`,
  gds_entry_id: sql`gds_entry_id`, payment_type_id: sql`payment_type_id`, card_type: sql`card_type`,
  last4: sql`last4`, expiry_month: sql`expiry_month`, expiry_year: sql`expiry_year`, gds_alias: sql`gds_alias`,
  branch_id: sql`branch_id`, owner_client_id: sql`owner_client_id`, owner_employee_id: sql`owner_employee_id`,
  airline_code: sql`airline_code`, rbd_spec: sql`rbd_spec`, active: sql`active`, is_default: sql`is_default`,
  notes: sql`notes`, created_by: sql`created_by`,
}

// fop_code is unique per TMC (fop_code_uniq), and one default per TMC
// (fop_one_default_per_tmc) -- callers clear the old default first.
export async function insertFop(db: Queryable, f: NewFop): Promise<FopRecord> {
  return one<FopRecord>(db, sql`insert into forms_of_payment ${insertColumns(FOP_COLUMNS, f)} returning ${FOP}`)
}

export type FopEdit = Partial<Omit<NewFop, 'tmc_id' | 'created_by'>>

export async function updateFop(db: Queryable, fopId: string, patch: FopEdit): Promise<FopRecord> {
  const set = Object.values(patch).some(v => v !== undefined)
    ? sql`${assignments(FOP_COLUMNS, patch)}, updated_at = now()`
    : sql`updated_at = now()`
  return one<FopRecord>(db, sql`update forms_of_payment set ${set} where id = ${fopId} returning ${FOP}`)
}

// Marking a second default is a SWAP: the old holder is cleared, in the same
// transaction as the write that claims it.
export async function clearDefault(db: Queryable, tmcId: string, exceptId?: string): Promise<void> {
  await exec(db, sql`
    update forms_of_payment set is_default = false
    where tmc_id = ${tmcId} and is_default ${exceptId ? sql`and id <> ${exceptId}` : empty}`)
}

// Assignments cascade; callers refuse while any exist.
export async function deleteFop(db: Queryable, fopId: string): Promise<void> {
  await exec(db, sql`delete from forms_of_payment where id = ${fopId}`)
}

// ═══ The code lists ═════════════════════════════════════════════════════════

export type GdsEntry = Pick<Row<'fop_gds_entries'>, 'id' | 'code' | 'label' | 'active'>
export type PaymentType = Pick<Row<'fop_payment_types'>, 'id' | 'code' | 'label' | 'requires_card' | 'active'>

export async function gdsEntries(db: Queryable, tmcId: string): Promise<GdsEntry[]> {
  return many<GdsEntry>(db, sql`
    select id, code, label, active from fop_gds_entries where tmc_id = ${tmcId} order by code, id`)
}

export async function paymentTypes(db: Queryable, tmcId: string): Promise<PaymentType[]> {
  return many<PaymentType>(db, sql`
    select id, code, label, requires_card, active from fop_payment_types where tmc_id = ${tmcId} order by code, id`)
}

export async function gdsEntryInTmc(db: Queryable, entryId: string, tmcId: string): Promise<boolean> {
  return (await maybeOne(db, sql`select 1 from fop_gds_entries where id = ${entryId} and tmc_id = ${tmcId}`)) !== null
}

export async function paymentTypeInTmc(
  db: Queryable,
  typeId: string,
  tmcId: string
): Promise<Pick<Row<'fop_payment_types'>, 'id' | 'requires_card'> | null> {
  return maybeOne(db, sql`select id, requires_card from fop_payment_types where id = ${typeId} and tmc_id = ${tmcId}`)
}

// Idempotent, so two first reads racing each other seed once.
export async function seedCodes(
  db: Queryable,
  tmcId: string,
  entries: readonly { code: string; label: string }[],
  types: readonly { code: string; label: string; requires_card: boolean }[]
): Promise<void> {
  if (entries.length > 0) {
    await exec(db, sql`
      insert into fop_gds_entries (tmc_id, code, label)
      values ${join(entries.map(e => sql`(${tmcId}, ${e.code}, ${e.label})`))}
      on conflict (tmc_id, code) do nothing`)
  }
  if (types.length > 0) {
    await exec(db, sql`
      insert into fop_payment_types (tmc_id, code, label, requires_card)
      values ${join(types.map(t => sql`(${tmcId}, ${t.code}, ${t.label}, ${t.requires_card})`))}
      on conflict (tmc_id, code) do nothing`)
  }
}

// ═══ Who a form of payment applies to ═══════════════════════════════════════

export async function countForFop(db: Queryable, fopId: string): Promise<number> {
  return (await one<{ n: number }>(db, sql`select count(*)::int as n from fop_assignments where fop_id = ${fopId}`)).n
}

export interface NamedFopAssignment {
  id: string
  kind: string
  targetId: string
  targetName: string
  is_active: boolean
}

// The target's name joined in, where the old path made a lookup per table.
export async function namedAssignments(db: Queryable, fopId: string): Promise<NamedFopAssignment[]> {
  return many<NamedFopAssignment>(db, sql`
    select a.id, a.kind,
           coalesce(a.client_id, a.client_group_id, a.bucket_id) as "targetId",
           coalesce(c.name, g.name, b.name, 'Unknown') as "targetName",
           a.is_active
    from fop_assignments a
    left join clients c on c.id = a.client_id
    left join client_groups g on g.id = a.client_group_id
    left join buckets b on b.id = a.bucket_id
    where a.fop_id = ${fopId}
    order by a.created_at, a.id`)
}

export interface MappingRow {
  id: string
  fop_id: string
  fop_code: string | null
  fop_label: string
  kind: 'client' | 'client_group' | 'bucket'
  target_id: string
  target_name: string
  is_active: boolean
  created_at: string
  created_by_name: string | null
}

// The flat mapping list. Search spans BOTH sides of the mapping -- the form
// of payment's code or label, and the target's name in whichever of three
// tables its kind points at -- which is one WHERE over a join here. Through
// PostgREST it took four id lookups and an `in` list per column.
export async function mappings(
  db: Queryable,
  tmcId: string,
  scope: { fopId?: string | null; search?: string | null },
  params: Pick<PageParams, 'from' | 'to'>
): Promise<{ rows: MappingRow[]; total: number }> {
  const where = sql`
    where a.tmc_id = ${tmcId}
    ${scope.fopId ? sql`and a.fop_id = ${scope.fopId}` : empty}
    ${searchAcross([sql`f.fop_code`, sql`f.label`, sql`c.name`, sql`g.name`, sql`b.name`], scope.search)}`
  const from = sql`
    from fop_assignments a
    left join forms_of_payment f on f.id = a.fop_id
    left join clients c on c.id = a.client_id
    left join client_groups g on g.id = a.client_group_id
    left join buckets b on b.id = a.bucket_id`

  const [rows, count] = await Promise.all([
    many<MappingRow>(db, sql`
      select a.id, a.fop_id, f.fop_code, coalesce(f.label, 'Unknown') as fop_label, a.kind,
             coalesce(a.client_id, a.client_group_id, a.bucket_id) as target_id,
             -- A target whose row is gone reads as Unknown rather than blank: a
             -- mapping pointing at nothing is something an admin must see.
             coalesce(c.name, g.name, b.name, 'Unknown') as target_name,
             a.is_active, a.created_at, e.full_name as created_by_name
      ${from}
      left join employees e on e.id = a.created_by
      ${where}
      order by a.created_at desc, a.id
      ${page(params)}`),
    one<{ n: number }>(db, sql`select count(*)::int as n ${from} ${where}`),
  ])
  return { rows, total: count.n }
}

export async function assign(
  db: Queryable,
  tmcId: string,
  fopId: string,
  targets: readonly { kind: 'client' | 'client_group' | 'bucket'; targetId: string }[],
  createdBy: string
): Promise<void> {
  if (targets.length === 0) return
  const column = (t: { kind: string; targetId: string }, kind: string) => (t.kind === kind ? t.targetId : null)
  await exec(db, sql`
    insert into fop_assignments (tmc_id, fop_id, kind, client_id, client_group_id, bucket_id, created_by)
    values ${join(targets.map(t => sql`(${tmcId}, ${fopId}, ${t.kind},
      ${column(t, 'client')}, ${column(t, 'client_group')}, ${column(t, 'bucket')}, ${createdBy})`))}
    on conflict do nothing`)
}

// Both scoped by tenant in the statement itself.
export async function setMappingActive(db: Queryable, mappingId: string, tmcId: string, active: boolean): Promise<void> {
  await exec(db, sql`update fop_assignments set is_active = ${active} where id = ${mappingId} and tmc_id = ${tmcId}`)
}

export async function unassign(db: Queryable, mappingId: string, tmcId: string): Promise<void> {
  await exec(db, sql`delete from fop_assignments where id = ${mappingId} and tmc_id = ${tmcId}`)
}
