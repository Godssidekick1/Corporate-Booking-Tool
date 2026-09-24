import { sql, empty, many, maybeOne, one, exec, type Queryable } from '@/app/lib/db/sql'
import { searchAcross, page, assignments, insertColumns } from '@/app/lib/db/fragments'
import type { Row } from '@/app/lib/db/types.generated'
import type { PageParams } from '@/app/lib/pagination'

// ── TMCs and the platform ────────────────────────────────────────────────────
// Owns: tmcs, platform_admins, audit_log, branches.
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
  | 'gst_zip' | 'iata_number' | 'office_id' | 'is_head_office' | 'status' | 'created_at'
>

const BRANCH = sql`
  id, name, branch_no, profit_centre_code, gst_number, gst_name, gst_email, gst_contact,
  gst_address_1, gst_address_2, country, gst_state, gst_city, gst_zip, iata_number, office_id,
  is_head_office, status, created_at`

export type BranchListScope =
  | { ids: readonly string[] }
  | { search: string; page: Pick<PageParams, 'from' | 'to'> }

export async function branches(
  db: Queryable,
  tmcId: string,
  scope: BranchListScope
): Promise<{ rows: Branch[]; total: number }> {
  if ('ids' in scope && scope.ids.length === 0) return { rows: [], total: 0 }
  const filter = 'ids' in scope
    ? sql`tmc_id = ${tmcId} and id = any(${[...scope.ids]})`
    : sql`tmc_id = ${tmcId} ${searchAcross([sql`name`, sql`branch_no`, sql`gst_city`, sql`gst_state`], scope.search)}`
  const limit = 'ids' in scope ? empty : page(scope.page)

  const [rows, count] = await Promise.all([
    // Head office first, then alphabetical: it is the one a desk looks for.
    many<Branch>(db, sql`
      select ${BRANCH} from branches where ${filter}
      order by is_head_office desc, name, id ${limit}`),
    one<{ n: number }>(db, sql`select count(*)::int as n from branches where ${filter}`),
  ])
  return { rows, total: count.n }
}

export async function branch(db: Queryable, branchId: string): Promise<Branch | null> {
  return maybeOne<Branch>(db, sql`select ${BRANCH} from branches where id = ${branchId}`)
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
  const columns = { ...BRANCH_WRITABLE, tmc_id: sql`tmc_id`, created_by: sql`created_by` }
  return one<Branch>(db, sql`
    insert into branches ${insertColumns(columns, { ...fields, tmc_id: tmcId, created_by: createdBy })}
    returning ${BRANCH}`)
}

export async function updateBranch(db: Queryable, branchId: string, fields: BranchFields): Promise<Branch> {
  const columns = { ...BRANCH_WRITABLE, updated_at: sql`updated_at` }
  return one<Branch>(db, sql`
    update branches set ${assignments(columns, { ...fields, updated_at: new Date().toISOString() })}
    where id = ${branchId}
    returning ${BRANCH}`)
}

// A TMC has at most one head office (partial unique index). Clearing the
// incumbent first is what lets "make this the head office" succeed.
export async function demoteHeadOffice(db: Queryable, tmcId: string, exceptBranchId?: string): Promise<void> {
  await exec(db, sql`
    update branches set is_head_office = false
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
