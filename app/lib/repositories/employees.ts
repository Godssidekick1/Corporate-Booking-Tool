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
