import { requireUser } from '@/app/lib/auth/session'
import { createAccount, sendInvite, AccountExists } from '@/app/lib/auth/flows'
import { NextRequest } from 'next/server'
import { db, transaction, isConstraint } from '@/app/lib/db'
import * as employees from '@/app/lib/repositories/employees'
import * as clients from '@/app/lib/repositories/clients'
import { route } from '@/app/lib/http/handler'

// ── POST /api/employees ───────────────────────────────────────────────────────
// Adds an employee to the admin's client. Behavior depends on the client's
// booking_mode:
//
// Every employee gets an account, whatever the client's booking_mode (see
// below). Two ways to set it up:
//
//   invite  — an email with a link; they choose a password. The employee
//             stays 'invited' until they do.
//   direct  — the admin sets a starting password and passes it on; no email.
//             They must replace it at first sign-in.
//
// Account, employee row and invite email are ONE transaction, email last: a
// failure anywhere leaves nothing behind. (With GoTrue the account lived in
// another system and had to be deleted by hand when the row failed.)
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
// anyway (must_change_password), so this is a transit credential, not
// a lasting one.
const MIN_INITIAL_PASSWORD = 10

export const POST = route(async (req: NextRequest) => {
  const user = await requireUser()

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
  try {
    const employeeId = await transaction(async tx => {
      const { accountId } = await createAccount(tx, normalizedEmail, {
        password: method === 'direct' ? password : undefined,
        createdBy: user.id,
      })
      await employees.insert(tx, {
        id: accountId,
        auth_user_id: accountId,
        client_id: clientId,
        band_id: bandRow.id,
        band_code: bandRow.code,
        band_rank: bandRow.rank,
        email: normalizedEmail,
        full_name,
        role: normalizedRole,
        // A directly-created account can already sign in, so there is no
        // acceptance step left to wait on. An invited one stays 'invited' until
        // they choose a password from the invite (/auth/confirm).
        status: method === 'direct' ? 'active' : 'invited',
        onboarding_method: method === 'direct' ? 'direct_create' : 'invite',
        first_login_completed: false,
        department: department ?? null,
        cost_centre: cost_centre ?? null,
      })
      if (method === 'invite') await sendInvite(tx, accountId, user.id)
      return accountId
    })

    return Response.json({
      ok: true,
      employeeId,
      message: method === 'direct'
        ? `${full_name} can sign in now with the password you set. They'll be asked to change it on first sign-in.`
        : `Invite sent to ${full_name} at ${normalizedEmail}.`,
    }, { status: 201 })

  } catch (err) {
    // Rolled back whole. The database's error text is logged, not returned --
    // it names constraints and columns.
    if (err instanceof AccountExists) {
      return Response.json({ error: err.message }, { status: 400 })
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