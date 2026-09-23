import type { Queryable } from '@/app/lib/db'
import * as employees from '@/app/lib/repositories/employees'

export interface TmcCallerCheck {
  authorized: boolean
  role?: string
  tmcId?: string | null
  error?: string
  status?: number
}

// ── requireTmcPermission ─────────────────────────────────────────────────────
// Server-side authorization check for TMC-side routes. tmc_admin always
// passes. A 'tc' caller must have the given permission key, and — if a
// clientId is provided — must also have explicit access to that client.
// Always queries fresh; never trust a permissions array passed in from
// the client.
//
// A DATABASE FAILURE NOW THROWS. It used to come back as { error }, which this
// function read the same way as a missing row -- so an outage told the caller
// "Employee record not found" (404). A route wrapped in route() turns the
// throw into a 500 that says what actually happened.
// ─────────────────────────────────────────────────────────────────────────────

export async function requireTmcPermission(
  db: Queryable,
  userId: string,
  permissionKey: string,
  clientId?: string
): Promise<TmcCallerCheck> {
  const caller = await employees.accessProfile(db, userId)

  if (!caller) {
    return { authorized: false, error: 'Employee record not found', status: 404 }
  }

  if (caller.status === 'deactivated') {
    return { authorized: false, error: 'This account has been deactivated', status: 403 }
  }

  if (!caller.tmc_id || (caller.role !== 'tmc_admin' && caller.role !== 'tc')) {
    return { authorized: false, error: 'Forbidden', status: 403 }
  }

  if (caller.role === 'tmc_admin') {
    return { authorized: true, role: caller.role, tmcId: caller.tmc_id }
  }

  // caller.role === 'tc' — must have the specific permission
  if (!(await employees.hasPermission(db, userId, permissionKey))) {
    return { authorized: false, error: `Missing permission: ${permissionKey}`, status: 403 }
  }

  if (clientId && !(await employees.hasClientAccess(db, userId, clientId))) {
    return { authorized: false, error: 'No access to this client', status: 403 }
  }

  return { authorized: true, role: caller.role, tmcId: caller.tmc_id }
}

// ── getAccessibleClientIds ──────────────────────────────────────────────────
// For list endpoints: returns the client IDs a caller is allowed to see.
// tmc_admin gets null (meaning "all clients for their TMC", no filter needed).
// tc gets the explicit list from employee_client_access (possibly empty).

export async function getAccessibleClientIds(
  db: Queryable,
  userId: string,
  role: string
): Promise<string[] | null> {
  if (role === 'tmc_admin') return null
  return employees.accessibleClientIds(db, userId)
}
