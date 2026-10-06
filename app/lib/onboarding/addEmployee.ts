import { createAccount, sendInvite } from '@/app/lib/auth/flows'
import type { Queryable } from '@/app/lib/db'
import * as employees from '@/app/lib/repositories/employees'

// ── addEmployee ──────────────────────────────────────────────────────────────
// One person added to a client: their account, their employee row and, for an
// invite, the email. Shared by every place people are added -- the corporate
// admin's Users screen, the TMC's Traveller profiles, and client onboarding
// (form rows or CSV) -- so the three can't drift apart on who gets an invite
// or what status they start in.
//
// Run it inside the caller's transaction: the email goes LAST, so a refused
// email rolls the account and the row back with it.
//
// Everyone gets credentials, whatever the client's booking mode: at a
// CBT-only client the travel desk books for them, but they still sign in to see
// their trips, bookings and approvals (booking itself is refused by
// clientGates.selfBooking). How the account is set up:
//   invite       -- emailed a link; 'invited' until they choose a password.
//   { password } -- an admin set a starting password to pass on. 'active',
//                   and the password must be changed at first sign-in.
// ─────────────────────────────────────────────────────────────────────────────

// No 'manager': a manager is an employee others report to (manager_id).
export const EMPLOYEE_ROLES = ['employee', 'finance', 'admin'] as const
export type EmployeeRole = typeof EMPLOYEE_ROLES[number]

export type AccountSetup = 'invite' | { password: string }

export interface NewClientEmployee {
  clientId: string
  band: { id: string; code: string; rank: number }
  email: string
  fullName: string
  role: EmployeeRole
  department?: string | null
  costCentre?: string | null
  setup: AccountSetup
  createdBy: string
}

export function isEmployeeRole(role: string): role is EmployeeRole {
  return (EMPLOYEE_ROLES as readonly string[]).includes(role)
}

export async function addEmployee(tx: Queryable, e: NewClientEmployee): Promise<string> {
  const password = typeof e.setup === 'object' ? e.setup.password : undefined
  const invited = e.setup === 'invite'

  const { accountId } = await createAccount(tx, e.email, { password, createdBy: e.createdBy })
  await employees.insert(tx, {
    id: accountId,
    auth_user_id: accountId,
    client_id: e.clientId,
    band_id: e.band.id,
    band_code: e.band.code,
    band_rank: e.band.rank,
    email: e.email,
    full_name: e.fullName,
    role: e.role,
    status: invited ? 'invited' : 'active',
    onboarding_method: invited ? 'invite' : 'direct_create',
    first_login_completed: false,
    department: e.department ?? null,
    cost_centre: e.costCentre ?? null,
  })
  if (invited) await sendInvite(tx, accountId, e.createdBy)
  return accountId
}
