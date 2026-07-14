import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { onboardCompany, OnboardCompanyInput } from '@/app/lib/onboarding/onboardCompany'
import { NextRequest } from 'next/server'

// ── POST /api/tmc/create-corporate/bulk ──────────────────────────────────────
// Creates ONE company (with admin invite), then bulk-creates its employee
// roster from CSV rows in the same request. Employee rows are created via
// direct-create (status: 'active', password-reset email), matching the
// existing "add directly" pattern — a CSV import implies the TMC/admin
// already has clean offline data, not that each employee needs an
// individual invite-acceptance step.
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

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const service = createServiceClient()

  const { data: caller, error: callerError } = await service
    .from('employees')
    .select('role, tmc_id')
    .eq('id', user.id)
    .single()

  if (callerError || !caller) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (caller.role !== 'tmc_admin') {
    return Response.json({ error: 'Only TMC admins can create corporate accounts' }, { status: 403 })
  }
  if (!caller.tmc_id) {
    return Response.json({ error: 'TMC context missing' }, { status: 400 })
  }

  const body = await req.json()
  const company: OnboardCompanyInput = body.company
  const employeeRows: EmployeeCsvRow[] = body.employees ?? []

  if (!company) {
    return Response.json({ error: 'Company details are required' }, { status: 400 })
  }

  if (employeeRows.length > MAX_EMPLOYEES) {
    return Response.json(
      { error: `Maximum ${MAX_EMPLOYEES} employees per upload` },
      { status: 400 }
    )
  }

  // ── Step 1: create the company + admin ─────────────────────────────────────
  const companyResult = await onboardCompany(
    service,
    caller.tmc_id,
    process.env.NEXT_PUBLIC_APP_URL!,
    company
  )

  if (!companyResult.ok || !companyResult.companyId) {
    return Response.json({ error: companyResult.error }, { status: 400 })
  }

  const companyId = companyResult.companyId

  if (employeeRows.length === 0) {
    return Response.json({
      ok: true,
      companyId,
      employeesCreated: 0,
      employeesFailed: 0,
      employeeResults: [],
    }, { status: 201 })
  }

  // ── Step 2: load the bands just seeded for this company ────────────────────
  const { data: bands } = await service
    .from('bands')
    .select('id, code, rank')
    .eq('company_id', companyId)

  const bandMap = Object.fromEntries((bands ?? []).map(b => [b.code, b]))

  // ── Step 3: create each employee, sequentially ──────────────────────────────
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

    const bandCode = row.band?.toUpperCase() || 'L1'
    const band = bandMap[bandCode]
    if (!band) {
      employeeResults.push({ email, status: 'failed', error: `Unknown band: ${bandCode}` })
      continue
    }

    let authUserId: string | null = null
    try {
      const randomPassword = crypto.randomUUID() + crypto.randomUUID()

      const { data: authData, error: createError } = await service.auth.admin.createUser({
        email,
        password: randomPassword,
        email_confirm: true,
        user_metadata: { full_name: fullName, company_id: companyId, role, band_code: band.code },
      })

      if (createError) {
        employeeResults.push({ email, status: 'failed', error: createError.message })
        continue
      }

      authUserId = authData.user.id

      const { error: employeeError } = await service.from('employees').insert({
        id: authUserId,
        company_id: companyId,
        band_id: band.id,
        band_code: band.code,
        band_rank: band.rank,
        email,
        full_name: fullName,
        role,
        status: 'active',
        onboarding_method: 'csv_import',
        first_login_completed: false,
        department: row.department?.trim() || null,
        cost_centre: row.cost_centre?.trim() || null,
      })

      if (employeeError) {
        await service.auth.admin.deleteUser(authUserId)
        employeeResults.push({ email, status: 'failed', error: employeeError.message })
        continue
      }

      await service.auth.admin.generateLink({
        type: 'recovery',
        email,
        options: { redirectTo: `${process.env.NEXT_PUBLIC_APP_URL}/auth/set-password` },
      })

      employeeResults.push({ email, status: 'created' })

    } catch (err) {
      if (authUserId) await service.auth.admin.deleteUser(authUserId)
      const message = err instanceof Error ? err.message : 'Failed to create employee'
      employeeResults.push({ email, status: 'failed', error: message })
    }
  }

  const employeesCreated = employeeResults.filter(r => r.status === 'created').length
  const employeesFailed = employeeResults.filter(r => r.status === 'failed').length

  return Response.json({
    ok: true,
    companyId,
    employeesCreated,
    employeesFailed,
    employeeResults,
  }, { status: 201 })
}