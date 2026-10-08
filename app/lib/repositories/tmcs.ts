import { sql, empty, many, maybeOne, one, exec, type Queryable } from '@/app/lib/db/sql'
import { searchAcross, page, assignments, insertColumns } from '@/app/lib/db/fragments'
import type { Row } from '@/app/lib/db/types.generated'
import type { PageParams } from '@/app/lib/pagination'

// ── TMCs and the platform ────────────────────────────────────────────────────
// Owns: tmcs, platform_admins, branches.
//
// Branches belong here rather than with clients because they are the TMC's
// own offices (branches.tmc_id) -- a client is filed under one, but does not
// own it.
// ─────────────────────────────────────────────────────────────────────────────

// ═══ platform_admins ════════════════════════════════════════════════════════
// Amadeus staff. They have no employees row, deliberately -- they are not a
// member of any tenant -- so this is the only table that can say who they are.

export type PlatformAdminRow = Pick<Row<'platform_admins'>, 'user_id' | 'email'>

export async function platformAdmin(db: Queryable, userId: string): Promise<PlatformAdminRow | null> {
  return maybeOne<PlatformAdminRow>(db, sql`
    select user_id, email from platform_admins where user_id = ${userId}`)
}

// ═══ tmcs ═══════════════════════════════════════════════════════════════════

export async function tmcName(db: Queryable, tmcId: string): Promise<Pick<Row<'tmcs'>, 'id' | 'name'> | null> {
  return maybeOne(db, sql`select id, name from tmcs where id = ${tmcId}`)
}

// ═══ branches ═══════════════════════════════════════════════════════════════
// iata_number and office_id are recorded, never routed on.

export type Branch = Pick<Row<'branches'>,
  | 'id' | 'name' | 'branch_no' | 'profit_centre_code' | 'gst_number' | 'gst_name' | 'gst_email'
  | 'gst_contact' | 'gst_address_1' | 'gst_address_2' | 'country' | 'gst_state' | 'gst_city'
  | 'gst_zip' | 'iata_number' | 'office_id' | 'is_head_office' | 'status' | 'created_at' | 'updated_at'
> & { updated_by_name: string | null }

// Read from `branches b` joined to who last changed it (BRANCH_FROM).
const BRANCH = sql`
  b.id, b.name, b.branch_no, b.profit_centre_code, b.gst_number, b.gst_name, b.gst_email, b.gst_contact,
  b.gst_address_1, b.gst_address_2, b.country, b.gst_state, b.gst_city, b.gst_zip, b.iata_number, b.office_id,
  b.is_head_office, b.status, b.created_at, b.updated_at, u.full_name as updated_by_name`
const BRANCH_FROM = sql`branches b left join employees u on u.id = b.updated_by`

export type BranchListScope =
  | { ids: readonly string[] }
  | { search: string; page: Pick<PageParams, 'from' | 'to'>; status?: string | null }

export async function branches(
  db: Queryable,
  tmcId: string,
  scope: BranchListScope
): Promise<{ rows: Branch[]; total: number }> {
  if ('ids' in scope && scope.ids.length === 0) return { rows: [], total: 0 }
  const filter = 'ids' in scope
    ? sql`b.tmc_id = ${tmcId} and b.id = any(${[...scope.ids]})`
    : sql`b.tmc_id = ${tmcId}
        ${searchAcross([sql`b.name`, sql`b.branch_no`, sql`b.gst_city`, sql`b.gst_state`], scope.search)}
        ${scope.status ? sql`and b.status = ${scope.status}` : empty}`
  const limit = 'ids' in scope ? empty : page(scope.page)

  const [rows, count] = await Promise.all([
    // Head office first, then alphabetical: it is the one a desk looks for.
    many<Branch>(db, sql`
      select ${BRANCH} from ${BRANCH_FROM} where ${filter}
      order by b.is_head_office desc, b.name, b.id ${limit}`),
    one<{ n: number }>(db, sql`select count(*)::int as n from branches b where ${filter}`),
  ])
  return { rows, total: count.n }
}

export async function branch(db: Queryable, branchId: string): Promise<Branch | null> {
  return maybeOne<Branch>(db, sql`select ${BRANCH} from ${BRANCH_FROM} where b.id = ${branchId}`)
}

// A branch, only if it is this TMC's -- another tenant's is indistinguishable
// from one that does not exist.
export async function branchInTmc(
  db: Queryable,
  branchId: string,
  tmcId: string
): Promise<Pick<Row<'branches'>, 'id' | 'tmc_id' | 'name'> | null> {
  return maybeOne(db, sql`
    select id, tmc_id, name from branches where id = ${branchId} and tmc_id = ${tmcId}`)
}

export type BranchFields = Partial<Pick<Row<'branches'>,
  | 'name' | 'branch_no' | 'profit_centre_code' | 'gst_number' | 'gst_name' | 'gst_email'
  | 'gst_contact' | 'gst_address_1' | 'gst_address_2' | 'country' | 'gst_state' | 'gst_city'
  | 'gst_zip' | 'iata_number' | 'office_id' | 'is_head_office' | 'status'
>>

const BRANCH_WRITABLE = {
  name: sql`name`, branch_no: sql`branch_no`, profit_centre_code: sql`profit_centre_code`,
  gst_number: sql`gst_number`, gst_name: sql`gst_name`, gst_email: sql`gst_email`,
  gst_contact: sql`gst_contact`, gst_address_1: sql`gst_address_1`, gst_address_2: sql`gst_address_2`,
  country: sql`country`, gst_state: sql`gst_state`, gst_city: sql`gst_city`, gst_zip: sql`gst_zip`,
  iata_number: sql`iata_number`, office_id: sql`office_id`, is_head_office: sql`is_head_office`,
  status: sql`status`,
} as const

// Fields left undefined take the column default (country 'India',
// is_head_office false, status 'active').
export async function insertBranch(
  db: Queryable,
  tmcId: string,
  createdBy: string,
  fields: BranchFields
): Promise<Branch> {
  const columns = { ...BRANCH_WRITABLE, tmc_id: sql`tmc_id`, created_by: sql`created_by`, updated_by: sql`updated_by` }
  return one<Branch>(db, sql`
    with b as (
      insert into branches ${insertColumns(columns, { ...fields, tmc_id: tmcId, created_by: createdBy, updated_by: createdBy })}
      returning *
    )
    select ${BRANCH} from b left join employees u on u.id = b.updated_by`)
}

export async function updateBranch(db: Queryable, branchId: string, updatedBy: string, fields: BranchFields): Promise<Branch> {
  const columns = { ...BRANCH_WRITABLE, updated_at: sql`updated_at`, updated_by: sql`updated_by` }
  return one<Branch>(db, sql`
    with b as (
      update branches set ${assignments(columns, { ...fields, updated_at: new Date().toISOString(), updated_by: updatedBy })}
      where id = ${branchId}
      returning *
    )
    select ${BRANCH} from b left join employees u on u.id = b.updated_by`)
}

// A TMC has at most one head office (partial unique index). Clearing the
// incumbent first is what lets "make this the head office" succeed.
// The demoted branch has changed too, and by the same person.
export async function demoteHeadOffice(db: Queryable, tmcId: string, updatedBy: string, exceptBranchId?: string): Promise<void> {
  await exec(db, sql`
    update branches set is_head_office = false, updated_at = now(), updated_by = ${updatedBy}
    where tmc_id = ${tmcId} and is_head_office
    ${exceptBranchId ? sql`and id <> ${exceptBranchId}` : empty}`)
}

export async function deleteBranch(db: Queryable, branchId: string): Promise<void> {
  await exec(db, sql`delete from branches where id = ${branchId}`)
}

export async function branchNames(db: Queryable, branchIds: readonly string[]): Promise<Map<string, string>> {
  if (branchIds.length === 0) return new Map()
  const rows = await many<{ id: string; name: string }>(db, sql`
    select id, name from branches where id = any(${[...branchIds]})`)
  return new Map(rows.map(r => [r.id, r.name]))
}

// ═══ tmcs, as the platform sees them ════════════════════════════════════════

export type Tmc = Pick<Row<'tmcs'>, 'id' | 'name' | 'status' | 'created_at'>

export interface PlatformTmcRow extends Tmc {
  clientCount: number
  staffCount: number
  adminCount: number
}

// One query for the page and its counts -- this was a count query per TMC per
// figure, three per row. Newest first, as the platform screen lists them.
export async function platformList(
  db: Queryable,
  search: string | null | undefined,
  params: Pick<PageParams, 'from' | 'to'>
): Promise<{ rows: PlatformTmcRow[]; total: number }> {
  const where = sql`where true ${searchAcross([sql`t.name`], search)}`
  const [rows, count] = await Promise.all([
    many<PlatformTmcRow>(db, sql`
      select t.id, t.name, t.status, t.created_at,
             (select count(*)::int from clients c where c.tmc_id = t.id) as "clientCount",
             (select count(*)::int from employees e where e.tmc_id = t.id and e.role in ('tmc_admin', 'tc')) as "staffCount",
             (select count(*)::int from employees e where e.tmc_id = t.id and e.role = 'tmc_admin') as "adminCount"
      from tmcs t ${where}
      order by t.created_at desc, t.id
      ${page(params)}`),
    one<{ n: number }>(db, sql`select count(*)::int as n from tmcs t ${where}`),
  ])
  return { rows, total: count.n }
}

export async function tmc(db: Queryable, tmcId: string): Promise<Tmc | null> {
  return maybeOne<Tmc>(db, sql`select id, name, status, created_at from tmcs where id = ${tmcId}`)
}

// Case-insensitive, and an existence check: it must not care how many
// same-named TMCs there already are.
export async function nameTaken(db: Queryable, name: string): Promise<boolean> {
  return (await maybeOne(db, sql`select 1 from tmcs where lower(name) = lower(${name}) limit 1`)) !== null
}

export async function insertTmc(db: Queryable, name: string): Promise<{ id: string }> {
  return one<{ id: string }>(db, sql`insert into tmcs (name, status) values (${name}, 'active') returning id`)
}

// Null when there is no such TMC.
export async function setTmcStatus(
  db: Queryable,
  tmcId: string,
  status: string
): Promise<Pick<Row<'tmcs'>, 'id' | 'name' | 'status'> | null> {
  return maybeOne(db, sql`update tmcs set status = ${status} where id = ${tmcId} returning id, name, status`)
}
