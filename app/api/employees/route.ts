import { createClient } from '@/utils/supabase/server'
import { authAdmin } from '@/utils/supabase/admin'
import { NextRequest } from 'next/server'
import { db, isConstraint } from '@/app/lib/db'
import * as employees from '@/app/lib/repositories/employees'
import * as clients from '@/app/lib/repositories/clients'
import { route } from '@/app/lib/http/handler'

// ── POST /api/employees ───────────────────────────────────────────────────────
// Adds an employee to the admin's client. Behavior depends on the client's
// booking_mode:
//
//   sbt / both — the employee needs to log in and book for themselves, so
//   this always sends a real Supabase invite email (inviteUserByEmail).
//   status starts as 'invited' until they accept and set a password.
//
//   cbt — the employee is a traveler profile only. A travel counsellor books
//   on their behalf; they never need to log in. No auth.users row is created
//   at all, no email is sent. employees.auth_user_id stays null for this row.
// ─────────────────────────────────────────────────────────────────────────────

const VALID_ROLES = ['employee', 'manager', 'finance', 'admin'] as const
type ValidRole = typeof VALID_ROLES[number]

interface CreateEmployeeBody {
  email: string
  full_name: string
  role: string
  band: string
  department?: string
  cost_centre?: string
  // 'invite'  — email them an invite; they set their own password.
  // 'direct'  — the admin sets a starting password here and passes it on
  //             out-of-band. No email is sent.
  method?: 'invite' | 'direct'
  password?: string
}

// Short enough to be readable over a phone call, long enough not to be
// trivially guessable. The account is forced to change it on first sign-in
// anyway (see must_set_password below), so this is a transit credential, not
// a lasting one.
const MIN_INITIAL_PASSWORD = 10

export const POST = route(async (req: NextRequest) => {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  // Only for GoTrue: accounts are created and rolled back through the auth
  // admin API. Every table read and write below goes through repositories.
  const auth = authAdmin()

  const caller = await employees.clientScope(db, user.id)

  if (!caller) {
    return Response.json({ error: 'Employee record not found' }, { status: 404 })
  }

  if (caller.role !== 'admin') {
    return Response.json({ error: 'Only admins can create employees directly' }, { status: 403 })
  }

  const clientId = caller.client_id
  const client = clientId ? await clients.bookingMode(db, clientId) : null

  if (!clientId || !client) {
    return Response.json({ error: 'Client not found' }, { status: 404 })
  }

  const body: CreateEmployeeBody = await req.json()
  const { email, full_name, role, band, department, cost_centre, password } = body
  const method = body.method === 'direct' ? 'direct' : 'invite'

  if (!email || !full_name || !role || !band) {
    return Response.json(
      { error: 'email, full_name, role, and band are required' },
      { status: 400 }
    )
  }

  if (method === 'direct' && (!password || password.length < MIN_INITIAL_PASSWORD)) {
    return Response.json(
      { error: `A starting password of at least ${MIN_INITIAL_PASSWORD} characters is required when adding someone directly` },
      { status: 400 }
    )
  }

  const normalizedEmail = email.trim().toLowerCase()
  if (!normalizedEmail.includes('@') || !normalizedEmail.includes('.')) {
    return Response.json({ error: 'Invalid email address' }, { status: 400 })
  }

  const normalizedRole = role.toLowerCase() as ValidRole
  if (!VALID_ROLES.includes(normalizedRole)) {
    return Response.json({ error: `Invalid role: ${role}` }, { status: 400 })
  }

  const bandRow = await employees.bandByCode(db, clientId, band.toUpperCase())

  if (!bandRow) {
    return Response.json({ error: `Band ${band} not found for this client` }, { status: 422 })
  }

  const existing = await employees.findByEmailInClient(db, clientId, normalizedEmail)

  if (existing) {
    return Response.json(
      { error: `An employee with this email already exists (status: ${existing.status})` },
      { status: 409 }
    )
  }

  // Every employee gets a real account now, whatever the client's
  // booking_mode. CBT previously created a profile with auth_user_id null,
  // which meant those people could never sign in at all — not even to see
  // their own trips, approvals or travel profile. A counsellor booking on
  // someone's behalf is a booking arrangement, not a reason to deny them a
  // login.
  const userMetadata = {
    full_name,
    client_id: clientId,
    role: normalizedRole,
    band_code: bandRow.code,
  }

  let authUserId: string | null = null

  try {
    if (method === 'direct') {
      // Created already confirmed, so there is no email step at all — the
      // admin hands the starting password over themselves.
      //
      // must_set_password forces a change on first sign-in (enforced in
      // proxy.ts). Without it the admin would permanently know the
      // employee's password, and could sign in as them.
      const { data: authData, error: createError } = await auth.createUser({
        email: normalizedEmail,
        password,
        email_confirm: true,
        user_metadata: { ...userMetadata, must_set_password: true },
      })

      if (createError) {
        return Response.json({ error: createError.message }, { status: 400 })
      }

      authUserId = authData.user.id
    } else {
      const { data: authData, error: inviteError } = await auth.inviteUserByEmail(
        normalizedEmail,
        {
          redirectTo: `${process.env.NEXT_PUBLIC_APP_URL}/auth/callback?next=/auth/set-password`,
          data: userMetadata,
        }
      )

      if (inviteError) {
        return Response.json({ error: inviteError.message }, { status: 400 })
      }

      authUserId = authData.user.id
    }

    await employees.insert(db, {
      id: authUserId,
      auth_user_id: authUserId,
      client_id: clientId,
      band_id: bandRow.id,
      band_code: bandRow.code,
      band_rank: bandRow.rank,
      email: normalizedEmail,
      full_name,
      role: normalizedRole,
      // A directly-created account can already sign in, so there is no
      // acceptance step left to wait on. An invited one stays 'invited' until
      // they click through (flipped in /api/auth/verify).
      status: method === 'direct' ? 'active' : 'invited',
      onboarding_method: method === 'direct' ? 'direct_create' : 'invite',
      first_login_completed: false,
      department: department ?? null,
      cost_centre: cost_centre ?? null,
    })

    return Response.json({
      ok: true,
      employeeId: authUserId,
      message: method === 'direct'
        ? `${full_name} can sign in now with the password you set. They'll be asked to change it on first sign-in.`
        : `Invite sent to ${full_name} at ${normalizedEmail}.`,
    }, { status: 201 })

  } catch (err) {
    // The auth account exists but its employees row does not: remove the
    // account, or it is a login that belongs to nobody. The database's error
    // text is logged, not returned -- it names constraints and columns.
    if (authUserId) {
      await auth.deleteUser(authUserId)
    }
    // Two admins adding the same person at once: both pass the existence
    // check above, and the unique constraint decides. Same answer as the check.
    if (isConstraint(err, 'unique', 'employees_company_email_unique')) {
      return Response.json({ error: 'An employee with this email already exists' }, { status: 409 })
    }
    console.error('[employees] create failed', err)
    return Response.json({ error: 'Failed to create employee' }, { status: 500 })
  }
})