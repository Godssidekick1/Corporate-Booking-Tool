import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { NextRequest } from 'next/server'

// ── POST /api/employees ───────────────────────────────────────────────────────
// Adds an employee to the admin's company. Behavior depends on the company's
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
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const service = createServiceClient()

  const { data: caller, error: callerError } = await service
    .from('employees')
    .select('company_id, role')
    .eq('id', user.id)
    .single()

  if (callerError || !caller) {
    return Response.json({ error: 'Employee record not found' }, { status: 404 })
  }

  if (caller.role !== 'admin') {
    return Response.json({ error: 'Only admins can create employees directly' }, { status: 403 })
  }

  const companyId = caller.company_id

  const { data: company, error: companyError } = await service
    .from('companies')
    .select('booking_mode')
    .eq('id', companyId)
    .single()

  if (companyError || !company) {
    return Response.json({ error: 'Company not found' }, { status: 404 })
  }

  const isCbtOnly = company.booking_mode === 'cbt'

  const body: CreateEmployeeBody = await req.json()
  const { email, full_name, role, band, department, cost_centre } = body

  if (!email || !full_name || !role || !band) {
    return Response.json(
      { error: 'email, full_name, role, and band are required' },
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

  const { data: bandRow, error: bandError } = await service
    .from('bands')
    .select('id, code, rank')
    .eq('company_id', companyId)
    .eq('code', band.toUpperCase())
    .single()

  if (bandError || !bandRow) {
    return Response.json({ error: `Band ${band} not found for this company` }, { status: 422 })
  }

  const { data: existing } = await service
    .from('employees')
    .select('id, status')
    .eq('company_id', companyId)
    .eq('email', normalizedEmail)
    .maybeSingle()

  if (existing) {
    return Response.json(
      { error: `An employee with this email already exists (status: ${existing.status})` },
      { status: 409 }
    )
  }

  // ── CBT-only company: pure traveler profile, no auth at all ────────────────
  if (isCbtOnly) {
    const { data: employee, error: employeeError } = await service
      .from('employees')
      .insert({
        company_id: companyId,
        auth_user_id: null,
        band_id: bandRow.id,
        band_code: bandRow.code,
        band_rank: bandRow.rank,
        email: normalizedEmail,
        full_name,
        role: normalizedRole,
        status: 'active', // no acceptance step exists for a profile that can't log in
        onboarding_method: 'direct_create',
        first_login_completed: false,
        department: department ?? null,
        cost_centre: cost_centre ?? null,
      })
      .select('id')
      .single()

    if (employeeError) {
      return Response.json({ error: employeeError.message }, { status: 500 })
    }

    return Response.json({
      ok: true,
      employeeId: employee.id,
      message: `${full_name} added as a traveler profile. This company books via CBT, so no login account was created.`,
    }, { status: 201 })
  }

  // ── SBT / hybrid company: real account, real invite email ─────────────────
  let authUserId: string | null = null

  try {
    const { data: authData, error: inviteError } = await service.auth.admin.inviteUserByEmail(
      normalizedEmail,
      {
        redirectTo: `${process.env.NEXT_PUBLIC_APP_URL}/login`,
        data: {
          full_name,
          company_id: companyId,
          role: normalizedRole,
          band_code: bandRow.code,
        },
      }
    )

    if (inviteError) {
      return Response.json({ error: inviteError.message }, { status: 400 })
    }

    authUserId = authData.user.id

    const { error: employeeError } = await service.from('employees').insert({
      id: authUserId,
      auth_user_id: authUserId,
      company_id: companyId,
      band_id: bandRow.id,
      band_code: bandRow.code,
      band_rank: bandRow.rank,
      email: normalizedEmail,
      full_name,
      role: normalizedRole,
      status: 'invited',
      onboarding_method: 'direct_create',
      first_login_completed: false,
      department: department ?? null,
      cost_centre: cost_centre ?? null,
    })

    if (employeeError) {
      await service.auth.admin.deleteUser(authUserId)
      return Response.json({ error: employeeError.message }, { status: 500 })
    }

    return Response.json({
      ok: true,
      employeeId: authUserId,
      message: `Invite sent to ${full_name} at ${normalizedEmail}.`,
    }, { status: 201 })

  } catch (err) {
    if (authUserId) {
      await service.auth.admin.deleteUser(authUserId)
    }
    const message = err instanceof Error ? err.message : 'Failed to create employee'
    return Response.json({ error: message }, { status: 500 })
  }
}