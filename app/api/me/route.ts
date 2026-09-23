import { createClient } from '@/utils/supabase/server'
import { db } from '@/app/lib/db'
import * as employees from '@/app/lib/repositories/employees'
import * as clients from '@/app/lib/repositories/clients'
import * as tmcs from '@/app/lib/repositories/tmcs'
import { route } from '@/app/lib/http/handler'

// ── GET /api/me ──────────────────────────────────────────────────────────────
// Who the signed-in person is, and enough about their company for the login
// page to route them and the dashboard to show setup progress.
//
// THE ROUTE THAT BROKE ON VERCEL. It used to read `if (employeeError ||
// !employee)` -- a database failure and a missing row, treated identically --
// so an unconfigured database answered "Employee profile not found" and the
// login page told every user it "could not determine your account role". The
// repositories throw on failure now, so a missing row is the ONLY way to reach
// the 404 below; an outage is a 500 that says so.
// ─────────────────────────────────────────────────────────────────────────────

export const GET = route(async () => {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  // Someone can be both: a TMC employee who also runs the platform. Checked for
  // everyone so the nav can offer the link instead of making them remember the
  // URL -- and fetched alongside the profile rather than after it.
  const [employee, platformAdmin] = await Promise.all([
    employees.profile(db, user.id),
    tmcs.platformAdmin(db, user.id),
  ])

  if (!employee) {
    // A platform admin has NO employees row — deliberately, since they are
    // Amadeus staff rather than a member of any tenant. Returning 404 here left
    // them signed in but stranded: the login page reads this to decide where to
    // send someone, found no role, and showed "could not determine your account
    // role". So the one account type that legitimately has no employee profile
    // is answered rather than refused.
    //
    // Everyone else still gets the 404. A missing employees row for an ordinary
    // user is a real broken state and must not be smoothed over.
    if (platformAdmin) {
      return Response.json({
        ok: true,
        employee: null,
        platformAdmin: true,
        client: null,
        employeeCount: 0,
        hasBookings: false,
        permissions: [],
        clientAccess: [],
      })
    }

    return Response.json({ error: 'Employee profile not found' }, { status: 404 })
  }

  const isTmcSide = employee.role === 'tmc_admin' || employee.role === 'tc'

  // Corporate side only: the company, and the setup checklist's counts. The
  // policy count comes from client_policy_groups, where policy actually lives.
  const [client, counts] = !isTmcSide && employee.client_id
    ? await Promise.all([
        clients.summary(db, employee.client_id),
        clients.onboardingCounts(db, employee.client_id),
      ])
    : [null, { employees: 0, bookings: 0, policyGroups: 0 }]

  // For TCs, their granted permissions and client access, so the frontend can
  // render a restricted view of the TMC dashboard and settings. tmc_admin has
  // full access implicitly and never needs these.
  const [permissions, clientAccess] = employee.role === 'tc'
    ? await Promise.all([
        employees.permissionKeys(db, employee.id),
        employees.accessibleClientIds(db, employee.id),
      ])
    : [[], []]

  return Response.json({
    ok: true,
    employee,
    platformAdmin: !!platformAdmin,
    client: client ?? null,
    employeeCount: counts.employees,
    hasBookings: counts.bookings > 0,
    hasPolicy: counts.policyGroups > 0,
    permissions,
    clientAccess,
  })
})
