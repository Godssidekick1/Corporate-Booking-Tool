import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { NextRequest } from 'next/server'

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

export async function GET() {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const service = createServiceClient()

  const { data: employee } = await service
    .from('employees')
    .select('id, full_name, email, role, status, tmc_id, created_at')
    .eq('id', user.id)
    .maybeSingle()

  if (!employee) {
    return Response.json({ error: 'Employee record not found' }, { status: 404 })
  }

  // This route is only ever about TMC-side accounts. A corporate user reaching
  // it is a routing mistake, and answering would imply they have a TMC profile.
  if (employee.role !== 'tmc_admin' && employee.role !== 'tc') {
    return Response.json({ error: 'Not a TMC account' }, { status: 403 })
  }

  const [{ data: tmc }, { data: permissionRows }] = await Promise.all([
    service.from('tmcs').select('id, name').eq('id', employee.tmc_id).maybeSingle(),
    service.from('employee_permissions').select('permission_key').eq('employee_id', employee.id),
  ])

  const isAdmin = employee.role === 'tmc_admin'

  // tmc_admin holds no permission rows — requireTmcPermission short-circuits on
  // the role instead. Reporting an empty list would read as "no access" when it
  // means the opposite, so the flag carries that distinction to the UI.
  const permissions = isAdmin ? [] : (permissionRows ?? []).map(p => p.permission_key)

  // Which clients this person can reach: every client at the TMC for an admin,
  // only explicitly granted ones for a counsellor.
  const { data: accessRows } = isAdmin
    ? { data: null }
    : await service
        .from('employee_client_access')
        .select('client_id')
        .eq('employee_id', employee.id)

  let clientQuery = service
    .from('clients')
    .select('id, name')
    .eq('tmc_id', employee.tmc_id)
    .order('name')

  if (!isAdmin) {
    const ids = (accessRows ?? []).map(a => a.client_id)
    if (ids.length === 0) {
      return Response.json({
        ok: true,
        account: accountOf(employee, tmc?.name ?? null),
        access: { fullAccess: false, permissions, clients: [] },
        activity: { clients: 0, travellers: 0, bookings: 0, lastSignInAt: lastSignIn(user) },
      })
    }
    clientQuery = clientQuery.in('id', ids)
  }

  const { data: clients } = await clientQuery
  const clientIds = (clients ?? []).map(c => c.id)

  // Portfolio activity, not personal activity. There is deliberately no
  // "bookings you made" figure: add-passenger writes requested_for identical to
  // employee_id (book-on-behalf does not exist yet), so no booking records which
  // counsellor created it. A personal count would be fabricated.
  const [{ count: travellers }, { count: bookings }] = await Promise.all([
    clientIds.length
      ? service.from('employees').select('id', { count: 'exact', head: true })
          .in('client_id', clientIds).neq('status', 'deactivated')
      : Promise.resolve({ count: 0 }),
    clientIds.length
      ? service.from('bookings').select('id', { count: 'exact', head: true }).in('client_id', clientIds)
      : Promise.resolve({ count: 0 }),
  ])

  return Response.json({
    ok: true,
    account: accountOf(employee, tmc?.name ?? null),
    access: {
      fullAccess: isAdmin,
      permissions,
      clients: clients ?? [],
    },
    activity: {
      clients: clientIds.length,
      travellers: travellers ?? 0,
      bookings: bookings ?? 0,
      lastSignInAt: lastSignIn(user),
    },
  })
}

function accountOf(
  employee: { id: string; full_name: string; email: string; role: string; status: string; created_at: string },
  tmcName: string | null
) {
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

export async function PATCH(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const service = createServiceClient()

  const { data: employee } = await service
    .from('employees')
    .select('id, role')
    .eq('id', user.id)
    .maybeSingle()

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

  const { data: updated, error } = await service
    .from('employees')
    .update({ full_name: body.fullName.trim() })
    .eq('id', user.id)
    .select('id, full_name')
    .single()

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  return Response.json({ ok: true, fullName: updated.full_name })
}
