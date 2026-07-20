import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { NextRequest } from 'next/server'

// ── POST /api/tmc/tcs ────────────────────────────────────────────────────────
// tmc_admin creates a new TC (travel counsellor) — either via email invite
// or direct-create, matching the existing employee-creation pattern.
// Initial permissions and company access are set in the same request so a
// TC is never created with default/unrestricted access even momentarily.
// ─────────────────────────────────────────────────────────────────────────────

const VALID_PERMISSIONS = [
  'manage_policy', 'manage_users', 'manage_approvals',
  'manage_branches', 'view_reports', 'book_on_behalf',
] as const

interface CreateTcBody {
  email: string
  full_name: string
  send_invite: boolean // true = email invite, false = direct-create
  permissions: string[]
  companyIds: string[]
}

export async function GET() {
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

  if (callerError || !caller || caller.role !== 'tmc_admin' || !caller.tmc_id) {
    return Response.json({ error: 'Only TMC admins can view TCs' }, { status: 403 })
  }

  const { data: tcs, error } = await service
    .from('employees')
    .select('id, full_name, email, status, created_at')
    .eq('tmc_id', caller.tmc_id)
    .eq('role', 'tc')
    .order('full_name')

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  const tcIds = (tcs ?? []).map(t => t.id)

  const [{ data: perms }, { data: access }] = await Promise.all([
    service.from('employee_permissions').select('employee_id, permission_key').in('employee_id', tcIds.length ? tcIds : ['00000000-0000-0000-0000-000000000000']),
    service.from('employee_company_access').select('employee_id, company_id').in('employee_id', tcIds.length ? tcIds : ['00000000-0000-0000-0000-000000000000']),
  ])

  const permsByTc = new Map<string, string[]>()
  for (const p of perms ?? []) {
    if (!permsByTc.has(p.employee_id)) permsByTc.set(p.employee_id, [])
    permsByTc.get(p.employee_id)!.push(p.permission_key)
  }

  const accessByTc = new Map<string, string[]>()
  for (const a of access ?? []) {
    if (!accessByTc.has(a.employee_id)) accessByTc.set(a.employee_id, [])
    accessByTc.get(a.employee_id)!.push(a.company_id)
  }

  const enriched = (tcs ?? []).map(tc => ({
    ...tc,
    permissions: permsByTc.get(tc.id) ?? [],
    companyIds: accessByTc.get(tc.id) ?? [],
  }))

  return Response.json({ ok: true, tcs: enriched })
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

  if (callerError || !caller || caller.role !== 'tmc_admin' || !caller.tmc_id) {
    return Response.json({ error: 'Only TMC admins can create TC accounts' }, { status: 403 })
  }

  const body: CreateTcBody = await req.json()
  const { email, full_name, send_invite, permissions = [], companyIds = [] } = body

  if (!email?.trim() || !full_name?.trim()) {
    return Response.json({ error: 'email and full_name are required' }, { status: 400 })
  }

  const normalizedEmail = email.trim().toLowerCase()
  if (!normalizedEmail.includes('@')) {
    return Response.json({ error: 'Invalid email address' }, { status: 400 })
  }

  const invalidPerms = permissions.filter(p => !VALID_PERMISSIONS.includes(p as typeof VALID_PERMISSIONS[number]))
  if (invalidPerms.length > 0) {
    return Response.json({ error: `Invalid permission(s): ${invalidPerms.join(', ')}` }, { status: 400 })
  }

  // Confirm every requested company actually belongs to this TMC
  if (companyIds.length > 0) {
    const { data: validCompanies } = await service
      .from('companies')
      .select('id')
      .eq('tmc_id', caller.tmc_id)
      .in('id', companyIds)

    if ((validCompanies?.length ?? 0) !== companyIds.length) {
      return Response.json({ error: 'One or more companies not found for your TMC' }, { status: 400 })
    }
  }

  const { data: existing } = await service
    .from('employees')
    .select('id')
    .eq('tmc_id', caller.tmc_id)
    .eq('email', normalizedEmail)
    .maybeSingle()

  if (existing) {
    return Response.json({ error: 'A TC with this email already exists' }, { status: 409 })
  }

  let authUserId: string | null = null

  try {
    const { data: authData, error: inviteError } = await service.auth.admin.inviteUserByEmail(
      normalizedEmail,
      {
        redirectTo: `${process.env.NEXT_PUBLIC_APP_URL}/login`,
        data: { full_name, tmc_id: caller.tmc_id, role: 'tc' },
      }
    )
    if (inviteError) throw new Error(inviteError.message)
    authUserId = authData.user.id

    const { error: employeeError } = await service.from('employees').insert({
      id: authUserId,
      auth_user_id: authUserId,
      tmc_id: caller.tmc_id,
      company_id: null,
      full_name: full_name.trim(),
      email: normalizedEmail,
      role: 'tc',
      status: 'invited',
    })

    if (employeeError) throw new Error(employeeError.message)

    if (permissions.length > 0) {
      const { error: permError } = await service.from('employee_permissions').insert(
        permissions.map(p => ({ employee_id: authUserId, permission_key: p, granted_by: user.id }))
      )
      if (permError) throw new Error(permError.message)
    }

    if (companyIds.length > 0) {
      const { error: accessError } = await service.from('employee_company_access').insert(
        companyIds.map(cid => ({ employee_id: authUserId, company_id: cid, granted_by: user.id }))
      )
      if (accessError) throw new Error(accessError.message)
    }

    return Response.json({
      ok: true,
      employeeId: authUserId,
      message: `${full_name} invited as a TC.`,
    }, { status: 201 })

  } catch (err) {
    if (authUserId) await service.auth.admin.deleteUser(authUserId)
    const message = err instanceof Error ? err.message : 'Failed to create TC'
    return Response.json({ error: message }, { status: 500 })
  }
}