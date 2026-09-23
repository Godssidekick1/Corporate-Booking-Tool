import { createClient } from '@/utils/supabase/server'
import { NextRequest } from 'next/server'
import { db } from '@/app/lib/db'
import * as employees from '@/app/lib/repositories/employees'
import * as clients from '@/app/lib/repositories/clients'
import * as tmcs from '@/app/lib/repositories/tmcs'
import * as bookings from '@/app/lib/repositories/bookings'
import { route } from '@/app/lib/http/handler'

// ── /api/tmc/profile ─────────────────────────────────────────────────────────
// The TMC-side user's own account: who they are, what they can reach, and what
// their portfolio looks like.
//
// Separate from /api/employees/me, which serves the TRAVELLER profile — passport,
// meal preference, date of birth. That is a corporate-traveller concern; a TMC
// admin has no reason to record one, and until now the shell linked them
// straight into that form.
//
//   GET   account + access + activity
//   PATCH the one field they own — their display name
// ─────────────────────────────────────────────────────────────────────────────

export const GET = route(async () => {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const employee = await employees.tmcAccount(db, user.id)

  if (!employee) {
    return Response.json({ error: 'Employee record not found' }, { status: 404 })
  }

  // This route is only ever about TMC-side accounts. A corporate user reaching
  // it is a routing mistake, and answering would imply they have a TMC profile.
  if (employee.role !== 'tmc_admin' && employee.role !== 'tc') {
    return Response.json({ error: 'Not a TMC account' }, { status: 403 })
  }

  const isAdmin = employee.role === 'tmc_admin'

  // tmc_admin holds no permission rows — requireTmcPermission short-circuits on
  // the role instead. Reporting an empty list would read as "no access" when it
  // means the opposite, so the flag carries that distinction to the UI.
  //
  // Which clients this person can reach: every client at the TMC for an admin
  // (null = no narrowing), only explicitly granted ones for a counsellor.
  const [tmc, permissions, accessibleIds] = await Promise.all([
    employee.tmc_id ? tmcs.tmcName(db, employee.tmc_id) : Promise.resolve(null),
    isAdmin ? Promise.resolve([]) : employees.permissionKeys(db, employee.id),
    isAdmin ? Promise.resolve(null) : employees.accessibleClientIds(db, employee.id),
  ])

  const reachable = employee.tmc_id
    ? await clients.namesForTmc(db, employee.tmc_id, accessibleIds)
    : []
  const clientIds = reachable.map(c => c.id)

  // Portfolio activity, not personal activity. There is deliberately no
  // "bookings you made" figure: add-passenger writes requested_for identical to
  // employee_id (book-on-behalf does not exist yet), so no booking records which
  // counsellor created it. A personal count would be fabricated.
  const [travellers, bookingCount] = await Promise.all([
    employees.countActiveInClients(db, clientIds),
    bookings.countForClients(db, clientIds),
  ])

  return Response.json({
    ok: true,
    account: accountOf(employee, tmc?.name ?? null),
    access: {
      fullAccess: isAdmin,
      permissions,
      clients: reachable,
    },
    activity: {
      clients: clientIds.length,
      travellers,
      bookings: bookingCount,
      lastSignInAt: lastSignIn(user),
    },
  })
})

function accountOf(employee: employees.TmcAccount, tmcName: string | null) {
  return {
    id: employee.id,
    fullName: employee.full_name,
    email: employee.email,
    role: employee.role,
    status: employee.status,
    joinedAt: employee.created_at,
    tmcName,
  }
}

// Supabase tracks this on the auth user, not on our employees row.
function lastSignIn(user: { last_sign_in_at?: string }): string | null {
  return user.last_sign_in_at ?? null
}

export const PATCH = route(async (req: NextRequest) => {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const employee = await employees.roleAndStatus(db, user.id)

  if (!employee || (employee.role !== 'tmc_admin' && employee.role !== 'tc')) {
    return Response.json({ error: 'Not a TMC account' }, { status: 403 })
  }

  const body: { fullName?: string } = await req.json()

  // Display name only. Role, status, permissions and client access are all
  // granted by someone else — letting a user PATCH their own role here would
  // make the whole permission system self-serve.
  if (!body.fullName?.trim()) {
    return Response.json({ error: 'Name cannot be empty' }, { status: 400 })
  }

  const updated = await employees.rename(db, user.id, body.fullName.trim())

  if (!updated) {
    return Response.json({ error: 'Employee record not found' }, { status: 404 })
  }

  return Response.json({ ok: true, fullName: updated.full_name })
})
