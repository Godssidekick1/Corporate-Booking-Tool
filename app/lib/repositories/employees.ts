import { sql, many, maybeOne, type Queryable } from '@/app/lib/db/sql'
import type { Row } from '@/app/lib/db/types.generated'

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
