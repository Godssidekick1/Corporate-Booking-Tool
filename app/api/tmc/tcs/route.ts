import { createClient } from '@/utils/supabase/server'
import { authAdmin } from '@/utils/supabase/admin'
import { isPermissionKey } from '@/app/lib/permissions/permissionKeys'
import { parsePageParams, pagedResponse } from '@/app/lib/pagination'
import { NextRequest } from 'next/server'
import { db, transaction } from '@/app/lib/db'
import * as employees from '@/app/lib/repositories/employees'
import * as clients from '@/app/lib/repositories/clients'
import * as tmcs from '@/app/lib/repositories/tmcs'
import { route } from '@/app/lib/http/handler'

// ── POST /api/tmc/tcs ────────────────────────────────────────────────────────
// tmc_admin creates a new TC (travel counsellor) — either via email invite
// or direct-create, matching the existing employee-creation pattern.
// Initial permissions and client access are set in the same request so a
// TC is never created with default/unrestricted access even momentarily.
// ─────────────────────────────────────────────────────────────────────────────


interface CreateTcBody {
  email: string
  full_name: string
  send_invite: boolean // true = email invite, false = direct-create
  permissions: string[]
  clientIds: string[]
}

function groupBy<T>(rows: readonly T[], key: (r: T) => string, value: (r: T) => string): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const r of rows) {
    const k = key(r)
    if (!out.has(k)) out.set(k, [])
    out.get(k)!.push(value(r))
  }
  return out
}

export const GET = route(async (req: NextRequest) => {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const caller = await employees.accessProfile(db, user.id)

  if (!caller || caller.role !== 'tmc_admin' || !caller.tmc_id) {
    return Response.json({ error: 'Only TMC admins can view TCs' }, { status: 403 })
  }

  const params = parsePageParams(req.nextUrl.searchParams)
  const ids = req.nextUrl.searchParams.get('ids')?.split(',').filter(Boolean) ?? []

  const { rows: tcs, total } = await employees.counsellors(
    db,
    caller.tmc_id,
    ids.length > 0 ? { ids } : { search: params.search, page: params }
  )

  const tcIds = tcs.map(t => t.id)
  // Branch names for this page's counsellors -- one lookup over the ids
  // actually on screen.
  const branchIds = [...new Set(tcs.map(t => t.branch_id).filter((b): b is string => Boolean(b)))]

  const [perms, access, branchName] = await Promise.all([
    employees.permissionsFor(db, tcIds),
    employees.clientAccessFor(db, tcIds),
    tmcs.branchNames(db, branchIds),
  ])

  const permsByTc = groupBy(perms, p => p.employee_id, p => p.permission_key)
  const accessByTc = groupBy(access, a => a.employee_id, a => a.client_id)

  const enriched = tcs.map(tc => ({
    ...tc,
    permissions: permsByTc.get(tc.id) ?? [],
    clientIds: accessByTc.get(tc.id) ?? [],
    branchName: tc.branch_id ? branchName.get(tc.branch_id) ?? null : null,
  }))

  return Response.json(pagedResponse(enriched, total, params))
})

export const POST = route(async (req: NextRequest) => {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const caller = await employees.accessProfile(db, user.id)

  if (!caller || caller.role !== 'tmc_admin' || !caller.tmc_id) {
    return Response.json({ error: 'Only TMC admins can create TC accounts' }, { status: 403 })
  }
  const tmcId = caller.tmc_id

  const body: CreateTcBody = await req.json()
  const { email, full_name, permissions = [], clientIds = [] } = body

  if (!email?.trim() || !full_name?.trim()) {
    return Response.json({ error: 'email and full_name are required' }, { status: 400 })
  }

  const normalizedEmail = email.trim().toLowerCase()
  if (!normalizedEmail.includes('@')) {
    return Response.json({ error: 'Invalid email address' }, { status: 400 })
  }

  const invalidPerms = permissions.filter(p => !isPermissionKey(p))
  if (invalidPerms.length > 0) {
    return Response.json({ error: `Invalid permission(s): ${invalidPerms.join(', ')}` }, { status: 400 })
  }

  // Confirm every requested client actually belongs to this TMC
  if (clientIds.length > 0) {
    const valid = await clients.idsInTmc(db, tmcId, clientIds)
    if (valid.length !== clientIds.length) {
      return Response.json({ error: 'One or more clients not found for your TMC' }, { status: 400 })
    }
  }

  if (await employees.findByEmailInTmc(db, tmcId, normalizedEmail)) {
    return Response.json({ error: 'A TC with this email already exists' }, { status: 409 })
  }

  // Only for GoTrue: the account is invited, and rolled back, through the auth
  // admin API. Table writes go through repositories.
  const auth = authAdmin()

  const { data: authData, error: inviteError } = await auth.inviteUserByEmail(
    normalizedEmail,
    {
      redirectTo: `${process.env.NEXT_PUBLIC_APP_URL}/auth/callback?next=/auth/set-password`,
      data: { full_name, tmc_id: tmcId, role: 'tc' },
    }
  )
  // GoTrue's message is meant for people ("already been registered") and is
  // passed on as it always was. Database errors below are not.
  if (inviteError || !authData.user) {
    return Response.json({ error: inviteError?.message ?? 'Failed to create TC' }, { status: 500 })
  }
  const employeeId = authData.user.id

  try {
    // One transaction for the row and its grants: a counsellor must never
    // exist with only some of what they were given -- or, if a grant fails,
    // at all, since the auth account is removed below.
    await transaction(async tx => {
      await employees.insertCounsellor(tx, {
        id: employeeId, tmc_id: tmcId, full_name: full_name.trim(), email: normalizedEmail,
      })
      await employees.grantPermissions(tx, employeeId, permissions, user.id)
      await employees.grantClientAccess(tx, employeeId, clientIds, user.id)
    }, { tenantId: tmcId, userId: user.id })

    return Response.json({
      ok: true,
      employeeId,
      message: `${full_name} invited as a TC.`,
    }, { status: 201 })

  } catch (err) {
    await auth.deleteUser(employeeId)
    console.error('[tmc/tcs] create failed', err)
    return Response.json({ error: 'Failed to create TC' }, { status: 500 })
  }
})
