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
