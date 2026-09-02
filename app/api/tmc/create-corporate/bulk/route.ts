import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { onboardClient, OnboardClientInput } from '@/app/lib/onboarding/onboardClient'
import { requireTmcPermission } from '@/app/lib/permissions/requireTmcPermission'
import { NextRequest } from 'next/server'

// ── POST /api/tmc/create-corporate/bulk ──────────────────────────────────────
// Creates ONE client (with admin invite), then bulk-creates its employee
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

  const auth = await requireTmcPermission(service, user.id, 'manage_users')
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
  const clientResult = await onboardClient(
    service,
    tmcId,
    process.env.NEXT_PUBLIC_APP_URL!,
    client
  )

  if (!clientResult.ok || !clientResult.clientId) {
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

  // ── Step 2: load the bands just seeded for this client ────────────────────
  const { data: bands } = await service
    .from('bands')
    .select('id, code, rank')
    .eq('client_id', clientId)

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

    // ── CBT-only client: pure traveler profile, no auth at all ──────────────
    if (isCbtOnly) {
      const { error: employeeError } = await service.from('employees').insert({
        client_id: clientId,
        auth_user_id: null,
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
        employeeResults.push({ email, status: 'failed', error: employeeError.message })
        continue
      }

      employeeResults.push({ email, status: 'created' })
      continue
    }

    // ── SBT / hybrid client: real account, real invite email ────────────────
    let authUserId: string | null = null
    try {
      const { data: authData, error: inviteError } = await service.auth.admin.inviteUserByEmail(
        email,
        {
          redirectTo: `${process.env.NEXT_PUBLIC_APP_URL}/auth/callback?next=/auth/set-password`,
          data: { full_name: fullName, client_id: clientId, role, band_code: band.code },
        }
      )

      if (inviteError) {
        employeeResults.push({ email, status: 'failed', error: inviteError.message })
        continue
      }

      authUserId = authData.user.id

      const { error: employeeError } = await service.from('employees').insert({
        id: authUserId,
        auth_user_id: authUserId,
        client_id: clientId,
        band_id: band.id,
        band_code: band.code,
        band_rank: band.rank,
        email,
        full_name: fullName,
        role,
        status: 'invited',
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
    clientId,
    employeesCreated,
    employeesFailed,
    employeeResults,
  }, { status: 201 })
}