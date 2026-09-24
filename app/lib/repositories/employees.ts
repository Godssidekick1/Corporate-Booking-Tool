import { sql, empty, json, many, maybeOne, one, exec, type Queryable, type Sql } from '@/app/lib/db/sql'
import { searchAcross, page, assignments } from '@/app/lib/db/fragments'
import type { Row } from '@/app/lib/db/types.generated'
import type { PageParams } from '@/app/lib/pagination'
import type { TravelerProfile } from '@/app/lib/book/types'

// ── Employees, bands and access ──────────────────────────────────────────────
// Owns: employees, bands, employee_permissions, employee_client_access.
//
// Everyone who signs in has an employees row -- corporate staff and TMC staff
// alike -- except platform admins, who live in tmcs.ts. Role, tenant and
// status on this row decide what every route will let a caller do.
// ─────────────────────────────────────────────────────────────────────────────

// ═══ Access checks ══════════════════════════════════════════════════════════
// Read on every TMC-side request by requireTmcPermission. Kept to the columns
// the check needs, and deliberately separate queries: a tmc_admin never needs
// the permission lookup, so it is not paid for.

export type AccessProfile = Pick<Row<'employees'>, 'role' | 'tmc_id' | 'status'>

export async function accessProfile(db: Queryable, employeeId: string): Promise<AccessProfile | null> {
  return maybeOne<AccessProfile>(db, sql`
    select role, tmc_id, status from employees where id = ${employeeId}`)
}

export async function hasPermission(db: Queryable, employeeId: string, permissionKey: string): Promise<boolean> {
  const row = await maybeOne<{ ok: boolean }>(db, sql`
    select true as ok from employee_permissions
    where employee_id = ${employeeId} and permission_key = ${permissionKey}`)
  return row !== null
}

export async function hasClientAccess(db: Queryable, employeeId: string, clientId: string): Promise<boolean> {
  const row = await maybeOne<{ ok: boolean }>(db, sql`
    select true as ok from employee_client_access
    where employee_id = ${employeeId} and client_id = ${clientId}`)
  return row !== null
}

// The clients a TC has been granted. Empty is a real answer -- "sees nothing"
// -- and is different from the null that getAccessibleClientIds returns for a
// tmc_admin, who sees every client of their TMC.
export async function accessibleClientIds(db: Queryable, employeeId: string): Promise<string[]> {
  const rows = await many<{ client_id: string }>(db, sql`
    select client_id from employee_client_access
    where employee_id = ${employeeId}
    order by client_id`)
  return rows.map(r => r.client_id)
}

// ═══ Reporting chain ════════════════════════════════════════════════════════

export type ManagerCandidate = Pick<Row<'employees'>, 'id' | 'client_id' | 'manager_id'>

// An employee, only if they work at the given client -- a manager from another
// tenant must be indistinguishable from one who does not exist.
export async function findInClient(db: Queryable, employeeId: string, clientId: string): Promise<ManagerCandidate | null> {
  return maybeOne<ManagerCandidate>(db, sql`
    select id, client_id, manager_id from employees
    where id = ${employeeId} and client_id = ${clientId}`)
}

// Whether walking up the manager chain from `startId` (inclusive) reaches
// `targetId` within `maxDepth` steps.
//
// One query, where the loop it replaces issued one round trip PER LEVEL of the
// org chart -- up to 50. The depth bound is kept: a cycle that already exists
// in the data (from some other bug) must terminate rather than recurse forever,
// and WITH RECURSIVE over a cycle is exactly that without one.
export async function reportsUpTo(
  db: Queryable,
  startId: string,
  targetId: string,
  maxDepth: number
): Promise<boolean> {
  const row = await maybeOne<{ found: boolean }>(db, sql`
    with recursive chain (id, manager_id, depth) as (
      select id, manager_id, 1 from employees where id = ${startId}
      union all
      select e.id, e.manager_id, c.depth + 1
      from employees e
      join chain c on e.id = c.manager_id
      where c.depth < ${maxDepth}
    )
    select exists (select 1 from chain where id = ${targetId}) as found`)
  return row?.found === true
}

// ═══ Session routing ════════════════════════════════════════════════════════

export type SessionProfile = Pick<Row<'employees'>, 'role' | 'first_login_completed'>

// Read by proxy.ts to route a signed-in user to the right side of the product
// and to force first-login onboarding. Keyed by the id from a VERIFIED session;
// the proxy never passes an id it was handed by the browser.
export async function sessionProfile(db: Queryable, userId: string): Promise<SessionProfile | null> {
  return maybeOne<SessionProfile>(db, sql`
    select role, first_login_completed from employees where id = ${userId}`)
}

// ═══ Sign-in and activation ═════════════════════════════════════════════════

export type RoleAndStatus = Pick<Row<'employees'>, 'role' | 'status'>

export async function roleAndStatus(db: Queryable, employeeId: string): Promise<RoleAndStatus | null> {
  return maybeOne<RoleAndStatus>(db, sql`select role, status from employees where id = ${employeeId}`)
}

// First successful sign-in after an email invite: invited -> active. A no-op
// for anyone else, which is why the status is part of the WHERE rather than a
// read-then-write -- two tabs finishing an invite at once cannot race it.
export async function activateIfInvited(db: Queryable, employeeId: string): Promise<boolean> {
  const n = await exec(db, sql`
    update employees set status = 'active' where id = ${employeeId} and status = 'invited'`)
  return n > 0
}

// Whether the company this person belongs to is still in service. TMC staff
// carry no client_id and get { client_id: null, client_status: null }.
export interface ClientStanding {
  client_id: string | null
  client_status: string | null
}

export async function clientStanding(db: Queryable, employeeId: string): Promise<ClientStanding | null> {
  return maybeOne<ClientStanding>(db, sql`
    select e.client_id, c.status as client_status
    from employees e
    left join clients c on c.id = e.client_id
    where e.id = ${employeeId}`)
}

// ═══ Profile ════════════════════════════════════════════════════════════════

export type EmployeeProfile = Pick<Row<'employees'>,
  | 'id' | 'full_name' | 'email' | 'role' | 'status' | 'client_id' | 'tmc_id'
  | 'band_id' | 'band_code' | 'band_rank' | 'manager_id' | 'department' | 'cost_centre'
>

// The signed-in person, as /api/me reports them. Null means there is no row --
// a real answer (a platform admin, or a broken account) -- never a failure,
// which now throws instead of arriving as null and reading as "not found".
export async function profile(db: Queryable, employeeId: string): Promise<EmployeeProfile | null> {
  return maybeOne<EmployeeProfile>(db, sql`
    select id, full_name, email, role, status, client_id, tmc_id,
           band_id, band_code, band_rank, manager_id, department, cost_centre
    from employees where id = ${employeeId}`)
}

export async function permissionKeys(db: Queryable, employeeId: string): Promise<string[]> {
  const rows = await many<{ permission_key: string }>(db, sql`
    select permission_key from employee_permissions
    where employee_id = ${employeeId}
    order by permission_key`)
  return rows.map(r => r.permission_key)
}

export type EmployeeStatusRow = Pick<Row<'employees'>, 'id' | 'client_id' | 'status'>

// Headcount inputs for the TMC dashboard, across a set of clients.
export async function statusesInClients(db: Queryable, clientIds: readonly string[]): Promise<EmployeeStatusRow[]> {
  if (clientIds.length === 0) return []
  return many<EmployeeStatusRow>(db, sql`
    select id, client_id, status from employees
    where client_id = any(${[...clientIds]})
    order by client_id, id`)
}

// Travellers across a set of clients -- anyone not deactivated, which includes
// people who have been invited but not yet signed in.
export async function countActiveInClients(db: Queryable, clientIds: readonly string[]): Promise<number> {
  if (clientIds.length === 0) return 0
  const row = await one<{ n: number }>(db, sql`
    select count(*)::int as n from employees
    where client_id = any(${[...clientIds]}) and status <> 'deactivated'`)
  return row.n
}

// ═══ TMC-side account (/api/tmc/profile) ════════════════════════════════════

export type TmcAccount = Pick<Row<'employees'>,
  'id' | 'full_name' | 'email' | 'role' | 'status' | 'tmc_id' | 'created_at'>

export async function tmcAccount(db: Queryable, employeeId: string): Promise<TmcAccount | null> {
  return maybeOne<TmcAccount>(db, sql`
    select id, full_name, email, role, status, tmc_id, created_at
    from employees where id = ${employeeId}`)
}

// Display name only -- see the route for why nothing else is self-editable.
export async function rename(
  db: Queryable,
  employeeId: string,
  fullName: string
): Promise<Pick<Row<'employees'>, 'id' | 'full_name'> | null> {
  return maybeOne(db, sql`
    update employees set full_name = ${fullName}
    where id = ${employeeId}
    returning id, full_name`)
}

// ═══ Traveller profile (/api/employees/me) ══════════════════════════════════

export interface TravellerRecord {
  id: string
  full_name: string
  email: string
  traveler_profile: TravelerProfile | null
  first_login_completed: boolean
}

export async function travellerRecord(db: Queryable, employeeId: string): Promise<TravellerRecord | null> {
  return maybeOne<TravellerRecord>(db, sql`
    select id, full_name, email, traveler_profile, first_login_completed
    from employees where id = ${employeeId}`)
}

export type SavedTravellerProfile = Pick<TravellerRecord, 'id' | 'traveler_profile' | 'first_login_completed'>

// Saving the profile IS the end of first-login onboarding: proxy.ts keeps
// redirecting to /profile until first_login_completed is true.
export async function saveTravellerProfile(
  db: Queryable,
  employeeId: string,
  profile: TravelerProfile
): Promise<SavedTravellerProfile | null> {
  return maybeOne<SavedTravellerProfile>(db, sql`
    update employees
    set traveler_profile = ${json(profile)}, first_login_completed = true
    where id = ${employeeId}
    returning id, traveler_profile, first_login_completed`)
}

// ═══ Corporate admin: the company's people ══════════════════════════════════

export type ClientScope = Pick<Row<'employees'>, 'client_id' | 'role'>

// Which company the caller administers, and whether they may.
export async function clientScope(db: Queryable, employeeId: string): Promise<ClientScope | null> {
  return maybeOne<ClientScope>(db, sql`select client_id, role from employees where id = ${employeeId}`)
}

export type Band = Pick<Row<'bands'>, 'id' | 'code' | 'rank'>

// Codes are matched exactly; callers that accept free-typed input normalise
// the case themselves.
export async function bandByCode(db: Queryable, clientId: string, code: string): Promise<Band | null> {
  return maybeOne<Band>(db, sql`
    select id, code, rank from bands where client_id = ${clientId} and code = ${code}`)
}

export async function findByEmailInClient(
  db: Queryable,
  clientId: string,
  email: string
): Promise<Pick<Row<'employees'>, 'id' | 'status'> | null> {
  return maybeOne(db, sql`
    select id, status from employees where client_id = ${clientId} and email = ${email}`)
}

export type NewEmployee = Pick<Row<'employees'>,
  | 'id' | 'auth_user_id' | 'client_id' | 'band_id' | 'band_code' | 'band_rank'
  | 'email' | 'full_name' | 'role' | 'status' | 'onboarding_method'
  | 'first_login_completed' | 'department' | 'cost_centre'
>

export async function insert(db: Queryable, e: NewEmployee): Promise<void> {
  await exec(db, sql`
    insert into employees (
      id, auth_user_id, client_id, band_id, band_code, band_rank, email, full_name,
      role, status, onboarding_method, first_login_completed, department, cost_centre
    ) values (
      ${e.id}, ${e.auth_user_id}, ${e.client_id}, ${e.band_id}, ${e.band_code}, ${e.band_rank},
      ${e.email}, ${e.full_name}, ${e.role}, ${e.status}, ${e.onboarding_method},
      ${e.first_login_completed}, ${e.department}, ${e.cost_centre}
    )`)
}

// How a people list is narrowed. Exactly one of the three: specific people
// (a picker resolving the ids it already shows), everything up to a cap (the
// hierarchy tree), or a searched page.
export type ListScope =
  | { ids: readonly string[] }
  | { cap: number }
  | { search: string; page: Pick<PageParams, 'from' | 'to'> }

export interface Listed<T> {
  rows: T[]
  // Matches before paging -- the paged envelope's `total`.
  total: number
}

// Shared by directory() and roster(): the same filter feeds the page and the
// count, so the total always describes the rows the pages are cut from.
async function listEmployees<T>(
  db: Queryable,
  columns: Sql,
  where: Sql,
  scope: ListScope,
  searchColumns: readonly Sql[]
): Promise<Listed<T>> {
  let filter = where
  let limit = empty
  if ('ids' in scope) {
    if (scope.ids.length === 0) return { rows: [], total: 0 }
    filter = sql`${where} and id = any(${[...scope.ids]})`
  } else if ('cap' in scope) {
    limit = sql`limit ${scope.cap}`
  } else {
    filter = sql`${where} ${searchAcross(searchColumns, scope.search)}`
    limit = page(scope.page)
  }

  const [rows, count] = await Promise.all([
    many<T>(db, sql`select ${columns} from employees where ${filter} order by full_name, id ${limit}`),
    one<{ n: number }>(db, sql`select count(*)::int as n from employees where ${filter}`),
  ])
  return { rows, total: count.n }
}

export type DirectoryRow = Pick<Row<'employees'>,
  | 'id' | 'full_name' | 'email' | 'role' | 'status' | 'band_code' | 'department'
  | 'cost_centre' | 'onboarding_method' | 'manager_id' | 'top_of_hierarchy'
>

// The corporate settings/users table.
export async function directory(db: Queryable, clientId: string, scope: ListScope): Promise<Listed<DirectoryRow>> {
  return listEmployees<DirectoryRow>(
    db,
    sql`id, full_name, email, role, status, band_code, department, cost_centre,
        onboarding_method, manager_id, top_of_hierarchy`,
    sql`client_id = ${clientId}`,
    scope,
    [sql`full_name`, sql`email`, sql`department`, sql`cost_centre`]
  )
}

export type RosterRow = Pick<Row<'employees'>,
  'id' | 'full_name' | 'email' | 'band_code' | 'band_rank' | 'status' | 'manager_id' | 'top_of_hierarchy'>

// A client's people as the TMC sees them. `missingManager` narrows to people
// with no reporting line who are not the top by design -- the ones a 'manager'
// approval step would resolve to nobody for. Ignored when resolving ids.
export async function roster(
  db: Queryable,
  clientId: string,
  scope: ListScope,
  options: { missingManager?: boolean } = {}
): Promise<Listed<RosterRow>> {
  const missing = options.missingManager && !('ids' in scope)
    ? sql`and manager_id is null and top_of_hierarchy is not true`
    : empty
  return listEmployees<RosterRow>(
    db,
    sql`id, full_name, email, band_code, band_rank, status, manager_id, top_of_hierarchy`,
    sql`client_id = ${clientId} ${missing}`,
    scope,
    [sql`full_name`, sql`email`]
  )
}

export async function findWithStatusInClient(
  db: Queryable,
  employeeId: string,
  clientId: string
): Promise<Pick<Row<'employees'>, 'id' | 'client_id' | 'status'> | null> {
  return maybeOne(db, sql`
    select id, client_id, status from employees where id = ${employeeId} and client_id = ${clientId}`)
}

export type CorporateEdit = Partial<Pick<Row<'employees'>, 'role' | 'status'>>

export type CorporateEditResult = Pick<Row<'employees'>,
  'id' | 'full_name' | 'email' | 'role' | 'status' | 'band_code' | 'manager_id'>

const CORPORATE_EDITABLE = { role: sql`role`, status: sql`status` } as const

// What a corporate admin may change about someone: role and status. Bands and
// reporting lines are the TMC's (applyReportingEdit).
export async function applyCorporateEdit(
  db: Queryable,
  employeeId: string,
  patch: CorporateEdit
): Promise<CorporateEditResult> {
  return one<CorporateEditResult>(db, sql`
    update employees set ${assignments(CORPORATE_EDITABLE, patch)}
    where id = ${employeeId}
    returning id, full_name, email, role, status, band_code, manager_id`)
}

// ═══ TMC side: reporting lines and bands ════════════════════════════════════

export type ReportingTarget = Pick<Row<'employees'>, 'id' | 'client_id' | 'full_name' | 'top_of_hierarchy'>

export async function reportingTarget(db: Queryable, employeeId: string): Promise<ReportingTarget | null> {
  return maybeOne<ReportingTarget>(db, sql`
    select id, client_id, full_name, top_of_hierarchy from employees where id = ${employeeId}`)
}

export type ReportingEdit = Partial<Pick<Row<'employees'>,
  'manager_id' | 'top_of_hierarchy' | 'band_id' | 'band_code' | 'band_rank'>>

export type ReportingEditResult = Pick<Row<'employees'>,
  'id' | 'full_name' | 'manager_id' | 'top_of_hierarchy' | 'band_code' | 'band_rank'>

const REPORTING_EDITABLE = {
  manager_id: sql`manager_id`,
  top_of_hierarchy: sql`top_of_hierarchy`,
  band_id: sql`band_id`,
  band_code: sql`band_code`,
  band_rank: sql`band_rank`,
} as const

// band_code and band_rank travel with band_id: they are denormalised onto the
// employee so policy resolution needs no join, and must never disagree with it.
export async function applyReportingEdit(
  db: Queryable,
  employeeId: string,
  patch: ReportingEdit
): Promise<ReportingEditResult> {
  return one<ReportingEditResult>(db, sql`
    update employees set ${assignments(REPORTING_EDITABLE, patch)}
    where id = ${employeeId}
    returning id, full_name, manager_id, top_of_hierarchy, band_code, band_rank`)
}

// ═══ Travel counsellors (TMC staff) ═════════════════════════════════════════

export type CounsellorRow = Pick<Row<'employees'>, 'id' | 'full_name' | 'email' | 'status' | 'created_at' | 'branch_id'>

export async function counsellors(db: Queryable, tmcId: string, scope: ListScope): Promise<Listed<CounsellorRow>> {
  return listEmployees<CounsellorRow>(
    db,
    sql`id, full_name, email, status, created_at, branch_id`,
    sql`tmc_id = ${tmcId} and role = 'tc'`,
    scope,
    [sql`full_name`, sql`email`]
  )
}

export async function findCounsellorInTmc(
  db: Queryable,
  employeeId: string,
  tmcId: string
): Promise<Pick<Row<'employees'>, 'id'> | null> {
  return maybeOne(db, sql`
    select id from employees where id = ${employeeId} and tmc_id = ${tmcId} and role = 'tc'`)
}

export async function findByEmailInTmc(
  db: Queryable,
  tmcId: string,
  email: string
): Promise<Pick<Row<'employees'>, 'id'> | null> {
  return maybeOne(db, sql`select id from employees where tmc_id = ${tmcId} and email = ${email}`)
}

export interface NewCounsellor {
  id: string
  tmc_id: string
  full_name: string
  email: string
}

// A counsellor starts 'invited' with no client of their own; what they can
// reach is granted separately (grantPermissions, grantClientAccess).
export async function insertCounsellor(db: Queryable, c: NewCounsellor): Promise<void> {
  await exec(db, sql`
    insert into employees (id, auth_user_id, tmc_id, client_id, full_name, email, role, status)
    values (${c.id}, ${c.id}, ${c.tmc_id}, null, ${c.full_name}, ${c.email}, 'tc', 'invited')`)
}

export async function setStatus(db: Queryable, employeeId: string, status: string): Promise<void> {
  await exec(db, sql`update employees set status = ${status} where id = ${employeeId}`)
}

// Organisational only -- a branch grants nothing.
export async function setBranch(db: Queryable, employeeId: string, branchId: string | null): Promise<void> {
  await exec(db, sql`update employees set branch_id = ${branchId} where id = ${employeeId}`)
}

// ═══ Grants: permissions and client access ══════════════════════════════════

export interface PermissionGrant { employee_id: string; permission_key: string }
export interface ClientGrant { employee_id: string; client_id: string }

export async function permissionsFor(db: Queryable, employeeIds: readonly string[]): Promise<PermissionGrant[]> {
  if (employeeIds.length === 0) return []
  return many<PermissionGrant>(db, sql`
    select employee_id, permission_key from employee_permissions
    where employee_id = any(${[...employeeIds]})
    order by employee_id, permission_key`)
}

export async function clientAccessFor(db: Queryable, employeeIds: readonly string[]): Promise<ClientGrant[]> {
  if (employeeIds.length === 0) return []
  return many<ClientGrant>(db, sql`
    select employee_id, client_id from employee_client_access
    where employee_id = any(${[...employeeIds]})
    order by employee_id, client_id`)
}

// One statement for the whole set. A repeated key violates the primary key and
// fails the statement -- inside a transaction, the whole replacement.
export async function grantPermissions(
  db: Queryable,
  employeeId: string,
  keys: readonly string[],
  grantedBy: string
): Promise<void> {
  if (keys.length === 0) return
  await exec(db, sql`
    insert into employee_permissions (employee_id, permission_key, granted_by)
    select ${employeeId}, k, ${grantedBy} from unnest(${[...keys]}::text[]) as k`)
}

export async function grantClientAccess(
  db: Queryable,
  employeeId: string,
  clientIds: readonly string[],
  grantedBy: string
): Promise<void> {
  if (clientIds.length === 0) return
  await exec(db, sql`
    insert into employee_client_access (employee_id, client_id, granted_by)
    select ${employeeId}, c, ${grantedBy} from unnest(${[...clientIds]}::uuid[]) as c`)
}

export async function revokeAllPermissions(db: Queryable, employeeId: string): Promise<void> {
  await exec(db, sql`delete from employee_permissions where employee_id = ${employeeId}`)
}

export async function revokeAllClientAccess(db: Queryable, employeeId: string): Promise<void> {
  await exec(db, sql`delete from employee_client_access where employee_id = ${employeeId}`)
}

// ═══ Branch staff ═══════════════════════════════════════════════════════════
// Who works out of which branch. Branches themselves are tmcs.ts's; the
// question "who is there" is about employees.

export async function staffCountsByBranch(db: Queryable, branchIds: readonly string[]): Promise<Map<string, number>> {
  if (branchIds.length === 0) return new Map()
  const rows = await many<{ branch_id: string; n: number }>(db, sql`
    select branch_id, count(*)::int as n from employees
    where branch_id = any(${[...branchIds]})
    group by branch_id`)
  return new Map(rows.map(r => [r.branch_id, r.n]))
}

export type BranchStaff = Pick<Row<'employees'>, 'id' | 'full_name' | 'email' | 'role' | 'status'>

export async function staffAtBranch(db: Queryable, branchId: string): Promise<BranchStaff[]> {
  return many<BranchStaff>(db, sql`
    select id, full_name, email, role, status from employees
    where branch_id = ${branchId}
    order by full_name, id`)
}

export async function countAtBranch(db: Queryable, branchId: string): Promise<number> {
  return (await one<{ n: number }>(db, sql`
    select count(*)::int as n from employees where branch_id = ${branchId}`)).n
}

// ═══ Bands ══════════════════════════════════════════════════════════════════
// A client's own grading vocabulary. `rank` is the structural part policy
// groups match on; code and label are whatever the client calls them.
//
// Renames reach employees through the bands_sync_employees trigger, in the
// same statement -- nothing here copies band_code/band_rank on a band edit.

export type BandRow = Pick<Row<'bands'>, 'id' | 'code' | 'label' | 'rank'>
export type BandRecord = BandRow & Pick<Row<'bands'>, 'client_id'>

export async function bandsForClient(db: Queryable, clientId: string): Promise<BandRow[]> {
  return many<BandRow>(db, sql`
    select id, code, label, rank from bands where client_id = ${clientId} order by rank, id`)
}

export async function band(db: Queryable, bandId: string): Promise<BandRecord | null> {
  return maybeOne<BandRecord>(db, sql`
    select id, client_id, code, label, rank from bands where id = ${bandId}`)
}

// The band already holding a rank, if any. `limit 1` rather than expecting
// one: rank is unique by convention, not by constraint, and a client that
// already has a clash must still get a clear 409 here rather than a 500.
export async function bandAtRank(
  db: Queryable,
  clientId: string,
  rank: number,
  exceptBandId?: string
): Promise<Pick<Row<'bands'>, 'code'> | null> {
  return maybeOne(db, sql`
    select code from bands
    where client_id = ${clientId} and rank = ${rank}
    ${exceptBandId ? sql`and id <> ${exceptBandId}` : empty}
    order by code
    limit 1`)
}

export async function insertBand(
  db: Queryable,
  b: Pick<Row<'bands'>, 'client_id' | 'code' | 'label' | 'rank'>
): Promise<BandRow> {
  return one<BandRow>(db, sql`
    insert into bands (client_id, code, label, rank)
    values (${b.client_id}, ${b.code}, ${b.label}, ${b.rank})
    returning id, code, label, rank`)
}

export type BandEdit = Partial<Pick<Row<'bands'>, 'code' | 'label' | 'rank'>>

const BAND_EDITABLE = { code: sql`code`, label: sql`label`, rank: sql`rank` } as const

export async function updateBand(db: Queryable, bandId: string, patch: BandEdit): Promise<BandRow> {
  return one<BandRow>(db, sql`
    update bands set ${assignments(BAND_EDITABLE, patch)}
    where id = ${bandId}
    returning id, code, label, rank`)
}

export async function deleteBand(db: Queryable, bandId: string): Promise<void> {
  await exec(db, sql`delete from bands where id = ${bandId}`)
}

// People per band code at a client -- what a rename touches and what blocks a
// delete.
export async function headcountByBandCode(db: Queryable, clientId: string): Promise<Map<string, number>> {
  const rows = await many<{ band_code: string; n: number }>(db, sql`
    select band_code, count(*)::int as n from employees
    where client_id = ${clientId} and band_code is not null
    group by band_code`)
  return new Map(rows.map(r => [r.band_code, r.n]))
}

export async function countOnBandCode(db: Queryable, clientId: string, code: string): Promise<number> {
  return (await one<{ n: number }>(db, sql`
    select count(*)::int as n from employees where client_id = ${clientId} and band_code = ${code}`)).n
}

// ═══ Traveller profiles, TMC side ═══════════════════════════════════════════
// The travel desk maintains the corporate half of a traveller's record (band,
// cost centre, department) and the travel document half on their behalf.
//
// traveler_profile is typed loosely here on purpose: the TMC side MERGES into
// it, and must carry through whatever keys the traveller saved themselves.

export type ProfileJson = Record<string, unknown>

export type TravellerRosterRow = Pick<Row<'employees'>,
  | 'id' | 'full_name' | 'email' | 'role' | 'status' | 'band_code' | 'band_rank' | 'department'
  | 'cost_centre' | 'designation' | 'manager_id' | 'top_of_hierarchy' | 'first_login_completed'
> & { traveler_profile: ProfileJson | null }

export async function travellerRoster(
  db: Queryable,
  clientId: string,
  scope: ListScope
): Promise<Listed<TravellerRosterRow>> {
  return listEmployees<TravellerRosterRow>(
    db,
    sql`id, full_name, email, role, status, band_code, band_rank, department, cost_centre,
        designation, manager_id, top_of_hierarchy, traveler_profile, first_login_completed`,
    sql`client_id = ${clientId}`,
    scope,
    [sql`full_name`, sql`email`, sql`department`, sql`designation`, sql`cost_centre`]
  )
}

export interface ProfileTarget {
  id: string
  client_id: string | null
  traveler_profile: ProfileJson | null
}

export async function profileTarget(db: Queryable, employeeId: string): Promise<ProfileTarget | null> {
  return maybeOne<ProfileTarget>(db, sql`
    select id, client_id, traveler_profile from employees where id = ${employeeId}`)
}

// The profile keyed by email, for matching an uploaded roster to people.
export async function profilesByEmail(
  db: Queryable,
  clientId: string
): Promise<(ProfileTarget & Pick<Row<'employees'>, 'email'>)[]> {
  return many(db, sql`
    select id, client_id, email, traveler_profile from employees
    where client_id = ${clientId}
    order by email, id`)
}

export type RosterExportRow = Pick<Row<'employees'>,
  'email' | 'full_name' | 'band_code' | 'cost_centre' | 'department' | 'designation'
> & { traveler_profile: ProfileJson | null }

export async function rosterForExport(db: Queryable, clientId: string): Promise<RosterExportRow[]> {
  return many<RosterExportRow>(db, sql`
    select email, full_name, band_code, cost_centre, department, designation, traveler_profile
    from employees where client_id = ${clientId}
    order by full_name, id`)
}

export type TravellerEdit = Partial<Pick<Row<'employees'>,
  'full_name' | 'department' | 'designation' | 'cost_centre' | 'band_id' | 'band_code' | 'band_rank'
>> & { traveler_profile?: ProfileJson }

export type TravellerEditResult = Pick<Row<'employees'>,
  'id' | 'full_name' | 'email' | 'band_code' | 'band_rank' | 'department' | 'cost_centre' | 'designation'
> & { traveler_profile: ProfileJson | null }

const TRAVELLER_EDITABLE = {
  full_name: sql`full_name`,
  department: sql`department`,
  designation: sql`designation`,
  cost_centre: sql`cost_centre`,
  band_id: sql`band_id`,
  band_code: sql`band_code`,
  band_rank: sql`band_rank`,
  traveler_profile: sql`traveler_profile`,
} as const

// The caller has already merged traveler_profile with what was there; this
// writes the result whole.
export async function applyTravellerEdit(
  db: Queryable,
  employeeId: string,
  patch: TravellerEdit
): Promise<TravellerEditResult> {
  const values = {
    ...patch,
    traveler_profile: patch.traveler_profile === undefined ? undefined : json(patch.traveler_profile),
  }
  return one<TravellerEditResult>(db, sql`
    update employees set ${assignments(TRAVELLER_EDITABLE, values)}
    where id = ${employeeId}
    returning id, full_name, email, band_code, band_rank, department, cost_centre, designation, traveler_profile`)
}

// ═══ People, as the client screens count them ═══════════════════════════════

// People per client, excluding deactivated -- "how big is this client", not
// how many rows exist.
export async function activeHeadcounts(db: Queryable, clientIds: readonly string[]): Promise<Map<string, number>> {
  if (clientIds.length === 0) return new Map()
  const rows = await many<{ client_id: string; n: number }>(db, sql`
    select client_id, count(*)::int as n from employees
    where client_id = any(${[...clientIds]}) and status <> 'deactivated'
    group by client_id`)
  return new Map(rows.map(r => [r.client_id, r.n]))
}

// TMC-side staff (tmc_admin or tc) at this TMC -- who may be a client's
// account manager. A corporate employee's id satisfies the foreign key too.
export async function isTmcStaff(db: Queryable, employeeId: string, tmcId: string): Promise<boolean> {
  const row = await maybeOne<{ ok: boolean }>(db, sql`
    select true as ok from employees
    where id = ${employeeId} and tmc_id = ${tmcId} and role in ('tmc_admin', 'tc')`)
  return row !== null
}

export type CorporateAdmin = Pick<Row<'employees'>, 'id' | 'full_name' | 'email' | 'status' | 'created_at'>

export async function corporateAdmins(db: Queryable, clientId: string): Promise<CorporateAdmin[]> {
  return many<CorporateAdmin>(db, sql`
    select id, full_name, email, status, created_at from employees
    where client_id = ${clientId} and role = 'admin'
    order by full_name, id`)
}

// An admin of THIS client, re-read so a reset is only ever sent to the address
// on file -- never to one a caller supplied.
export async function corporateAdmin(
  db: Queryable,
  employeeId: string,
  clientId: string
): Promise<Pick<Row<'employees'>, 'id' | 'full_name' | 'email'> | null> {
  return maybeOne(db, sql`
    select id, full_name, email from employees
    where id = ${employeeId} and client_id = ${clientId} and role = 'admin'`)
}

// ═══ Cost centres, as employees carry them ══════════════════════════════════
// employees.cost_centre is the code as text, not a foreign key.

export type CostCentreUsage = Pick<Row<'employees'>, 'cost_centre' | 'department'>

export async function costCentreUsage(db: Queryable, clientId: string): Promise<CostCentreUsage[]> {
  return many<CostCentreUsage>(db, sql`
    select cost_centre, department from employees where client_id = ${clientId} order by id`)
}

export async function countOnCostCentre(db: Queryable, clientId: string, code: string): Promise<number> {
  return (await one<{ n: number }>(db, sql`
    select count(*)::int as n from employees where client_id = ${clientId} and cost_centre = ${code}`)).n
}

// Carries everyone on `from` to `to`; returns how many moved.
export async function moveCostCentre(db: Queryable, clientId: string, from: string, to: string): Promise<number> {
  return exec(db, sql`
    update employees set cost_centre = ${to} where client_id = ${clientId} and cost_centre = ${from}`)
}

// ═══ Policy subject ═════════════════════════════════════════════════════════

// The traveller as the policy check sees them: their client and band code.
// The band's RANK is read from the client's own bands row (bandByCode), not
// from the denormalised band_rank here -- that is the lookup the policy has
// always used.
export async function policySubject(
  db: Queryable,
  employeeId: string
): Promise<Pick<Row<'employees'>, 'client_id' | 'band_code'> | null> {
  return maybeOne(db, sql`select client_id, band_code from employees where id = ${employeeId}`)
}
