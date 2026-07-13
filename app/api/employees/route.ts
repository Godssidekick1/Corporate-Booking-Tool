import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { NextRequest } from 'next/server'

// ── POST /api/employees ───────────────────────────────────────────────────────
// Direct employee creation — no invite email sent by default.
// The employee is created in auth.users with a random password and, if
// send_welcome_email is true, receives a password-reset link to set their own.
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
  send_welcome_email?: boolean
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

  const body: CreateEmployeeBody = await req.json()
  const { email, full_name, role, band, department, cost_centre, send_welcome_email = true } = body

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

  let authUserId: string | null = null

  try {
    const randomPassword = crypto.randomUUID() + crypto.randomUUID()

    const { data: authData, error: createError } = await service.auth.admin.createUser({
      email: normalizedEmail,
      password: randomPassword,
      email_confirm: true,
      user_metadata: {
        full_name,
        company_id: companyId,
        role: normalizedRole,
        band_code: bandRow.code,
      },
    })

    if (createError) {
      return Response.json({ error: createError.message }, { status: 400 })
    }

    authUserId = authData.user.id

    // Direct-create employees skip 'invited' — no acceptance step required,
    // they're immediately usable (optionally with a password reset link below).
    const { error: employeeError } = await service.from('employees').insert({
      id: authUserId,
      company_id: companyId,
      band_id: bandRow.id,
      band_code: bandRow.code,
      band_rank: bandRow.rank,
      email: normalizedEmail,
      full_name,
      role: normalizedRole,
      status: 'active',
      onboarding_method: 'direct_create',
      first_login_completed: false,
      department: department ?? null,
      cost_centre: cost_centre ?? null,
    })

    if (employeeError) {
      await service.auth.admin.deleteUser(authUserId)
      return Response.json({ error: employeeError.message }, { status: 500 })
    }

    if (send_welcome_email) {
      await service.auth.admin.generateLink({
        type: 'recovery',
        email: normalizedEmail,
        options: {
          redirectTo: `${process.env.NEXT_PUBLIC_APP_URL}/auth/set-password`,
        },
      })
    }

    return Response.json({
      ok: true,
      employeeId: authUserId,
      message: `Employee ${full_name} created${send_welcome_email ? '. Password setup email sent.' : '. No email sent — share login instructions manually.'}`,
    }, { status: 201 })

  } catch (err) {
    if (authUserId) {
      await service.auth.admin.deleteUser(authUserId)
    }
    const message = err instanceof Error ? err.message : 'Failed to create employee'
    return Response.json({ error: message }, { status: 500 })
  }
}