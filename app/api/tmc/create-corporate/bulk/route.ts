import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { onboardClient, OnboardClientInput } from '@/app/lib/onboarding/onboardClient'
import { requireTmcPermission } from '@/app/lib/permissions/requireTmcPermission'
import { NextRequest } from 'next/server'
import { randomUUID } from 'node:crypto'
import * as employees from '@/app/lib/repositories/employees'
import { route } from '@/app/lib/http/handler'
import { db, isConstraint } from '@/app/lib/db'

// ── POST /api/tmc/create-corporate/bulk ──────────────────────────────────────
// Creates ONE client (with admin invite), then bulk-creates its employee
// roster from CSV rows in the same request. What a row becomes depends on the
// client's booking mode: for a CBT-only client, a traveller profile with no
// account (the TMC books for them); otherwise an invited account, one invite
// email per row. Failures are reported per row and never stop the file.
// ─────────────────────────────────────────────────────────────────────────────

const MAX_EMPLOYEES = 250
const VALID_ROLES = ['employee', 'manager', 'finance', 'admin'] as const

interface EmployeeCsvRow {
  email: string
  full_name: string
  role?: string
  band?: string
  department?: string
  cost_centre?: string
}

interface EmployeeResult {
  email: string
  status: 'created' | 'failed'
  error?: string
}

export const POST = route(async (req: NextRequest) => {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  // manage_clients, not manage_users. This route's privileged act is bringing a
  // new client company into existence; the employee roster is a consequence of
  // that, not the point. manage_users governs people inside a client the TC has
  // already been given, which is a narrower thing and was the wrong gate here —
  // it let anyone who could edit travellers create tenants.
  const auth = await requireTmcPermission(db, user.id, 'manage_clients')
  if (!auth.authorized) {
    return Response.json({ error: auth.error }, { status: auth.status ?? 403 })
  }
  const tmcId = auth.tmcId!

  const body = await req.json()
  const client: OnboardClientInput = body.client
  const employeeRows: EmployeeCsvRow[] = body.employees ?? []

  if (!client) {
    return Response.json({ error: 'Client details are required' }, { status: 400 })
  }

  if (employeeRows.length > MAX_EMPLOYEES) {
    return Response.json(
      { error: `Maximum ${MAX_EMPLOYEES} employees per upload` },
      { status: 400 }
    )
  }

  // ── Step 1: create the client + admin ─────────────────────────────────────
  const clientResult = await onboardClient(tmcId, process.env.NEXT_PUBLIC_APP_URL!, client)

  if (!clientResult.ok || !clientResult.clientId) {
    // 409 and the existing rows, not a flat 400: the caller is meant to show
    // these, ask, and retry with client.confirmDuplicateName — a plain error
    // string would leave the screen saying "already have a client named Acme"
    // with no way to proceed, which is a block rather than the warning intended.
    if (clientResult.duplicates) {
      return Response.json(
        { error: clientResult.error, duplicates: clientResult.duplicates },
        { status: 409 }
      )
    }
    return Response.json({ error: clientResult.error }, { status: 400 })
  }

  const clientId = clientResult.clientId
  const isCbtOnly = client.bookingMode === 'cbt'

  if (employeeRows.length === 0) {
    return Response.json({
      ok: true,
      clientId,
      employeesCreated: 0,
      employeesFailed: 0,
      employeeResults: [],
    }, { status: 201 })
  }

  // ── Step 2: the bands just created for this client ────────────────────────
  // Matched case-insensitively against the client's OWN codes, and a blank
  // band means the least senior one. This used to uppercase the cell and
  // default to the literal 'L1' -- from before clients named their own bands,
  // so a client whose bands are "Band 1".."Band 4" failed every row.
  const bands = await employees.bandsForClient(db, clientId)
  const bandByCode = new Map(bands.map(b => [b.code.toLowerCase(), b]))
  const leastSenior = bands.reduce<typeof bands[number] | null>((low, b) => (!low || b.rank < low.rank ? b : low), null)

  // ── Step 3: create each employee, sequentially ──────────────────────────────
  // One at a time: for SBT each row is an invite, an API call that can fail on
  // its own, and one bad row must not take the rest of the file down with it.
  const authAdmin = createServiceClient().auth.admin
  const employeeResults: EmployeeResult[] = []

  for (const row of employeeRows) {
    const email = row.email?.trim().toLowerCase()
    const fullName = row.full_name?.trim()

    if (!email || !email.includes('@') || !fullName) {
      employeeResults.push({
        email: email || '(missing)',
        status: 'failed',
        error: 'Missing or invalid email/full_name',
      })
      continue
    }

    const role = (row.role?.toLowerCase() || 'employee') as typeof VALID_ROLES[number]
    if (!VALID_ROLES.includes(role)) {
      employeeResults.push({ email, status: 'failed', error: `Invalid role: ${row.role}` })
      continue
    }

    const bandCell = row.band?.trim()
    const band = bandCell ? bandByCode.get(bandCell.toLowerCase()) : leastSenior
    if (!band) {
      employeeResults.push({ email, status: 'failed', error: `Unknown band: ${bandCell}` })
      continue
    }

    const profile = {
      client_id: clientId,
      band_id: band.id,
      band_code: band.code,
      band_rank: band.rank,
      email,
      full_name: fullName,
      role,
      first_login_completed: false,
      department: row.department?.trim() || null,
      cost_centre: row.cost_centre?.trim() || null,
    }

    // ── CBT-only client: pure traveler profile, no auth at all ──────────────
    if (isCbtOnly) {
      try {
        // What happened to them, from the values the check constraint allows:
        // created directly, with no account.
        await employees.insert(db, {
          ...profile, id: randomUUID(), auth_user_id: null, status: 'active', onboarding_method: 'direct_create',
        })
        employeeResults.push({ email, status: 'created' })
      } catch (err) {
        employeeResults.push({ email, status: 'failed', error: rowError(err) })
      }
      continue
    }

    // ── SBT / hybrid client: real account, real invite email ────────────────
    let authUserId: string | null = null
    try {
      const { data: authData, error: inviteError } = await authAdmin.inviteUserByEmail(email, {
        redirectTo: `${process.env.NEXT_PUBLIC_APP_URL}/auth/callback?next=/auth/set-password`,
        data: { full_name: fullName, client_id: clientId, role, band_code: band.code },
      })

      if (inviteError) {
        employeeResults.push({ email, status: 'failed', error: inviteError.message })
        continue
      }

      authUserId = authData.user.id
      await employees.insert(db, {
        ...profile, id: authUserId, auth_user_id: authUserId, status: 'invited', onboarding_method: 'invite',
      })
      employeeResults.push({ email, status: 'created' })
    } catch (err) {
      if (authUserId) await authAdmin.deleteUser(authUserId)
      employeeResults.push({ email, status: 'failed', error: rowError(err) })
    }
  }

  const employeesCreated = employeeResults.filter(r => r.status === 'created').length
  const employeesFailed = employeeResults.filter(r => r.status === 'failed').length

  return Response.json({
    ok: true,
    clientId,
    employeesCreated,
    employeesFailed,
    employeeResults,
  }, { status: 201 })
})

// A row the database refused. The one a person can act on is a duplicate
// email; anything else is reported without the database's own wording.
function rowError(err: unknown): string {
  if (isConstraint(err, 'unique')) return 'Someone with this email already exists'
  console.error('[create-corporate] employee row failed', err)
  return 'Could not create this employee'
}
