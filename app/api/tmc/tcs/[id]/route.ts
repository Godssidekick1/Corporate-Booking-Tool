import { createClient } from '@/utils/supabase/server'
import { isPermissionKey } from '@/app/lib/permissions/permissionKeys'
import { NextRequest } from 'next/server'
import { db, transaction } from '@/app/lib/db'
import * as employees from '@/app/lib/repositories/employees'
import * as clients from '@/app/lib/repositories/clients'
import * as tmcs from '@/app/lib/repositories/tmcs'
import { route } from '@/app/lib/http/handler'

// ── PATCH /api/tmc/tcs/[id] ──────────────────────────────────────────────────
// Replaces a TC's permission set and/or client access list wholesale
// (simpler and safer than incremental add/remove — the admin always submits
// the complete intended state). Status (active/deactivated) can also be set.


interface UpdateTcBody {
  permissions?: string[]
  clientIds?: string[]
  status?: 'active' | 'deactivated'
  branchId?: string | null
}

export const PATCH = route(async (
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const caller = await employees.accessProfile(db, user.id)
  if (!caller || caller.role !== 'tmc_admin' || !caller.tmc_id) {
    return Response.json({ error: 'Only TMC admins can edit TCs' }, { status: 403 })
  }
  const tmcId = caller.tmc_id

  const target = await employees.findCounsellorInTmc(db, id, tmcId)

  if (!target) {
    return Response.json({ error: 'TC not found' }, { status: 404 })
  }

  const body: UpdateTcBody = await req.json()
  const { permissions, clientIds, status, branchId } = body

  // ── Validate everything BEFORE writing anything ──────────────────────────
  // Each check keeps its own status code and message. Hoisting them above the
  // writes means a rejected field cannot leave an earlier field's write
  // committed, and it keeps the transaction below short -- validation does not
  // hold a connection or a row lock while it queries.

  if (permissions !== undefined) {
    const invalid = permissions.filter(p => !isPermissionKey(p))
    if (invalid.length > 0) {
      return Response.json({ error: `Invalid permission(s): ${invalid.join(', ')}` }, { status: 400 })
    }
  }

  if (clientIds !== undefined && clientIds.length > 0) {
    const valid = await clients.idsInTmc(db, tmcId, clientIds)
    if (valid.length !== clientIds.length) {
      return Response.json({ error: 'One or more clients not found for your TMC' }, { status: 400 })
    }
  }

  if (status !== undefined && !['active', 'deactivated'].includes(status)) {
    return Response.json({ error: 'Invalid status' }, { status: 400 })
  }

  // branch_id is a plain FK, so another tenant's branch would satisfy the
  // constraint and quietly file this person under someone else's office.
  if (branchId !== undefined && branchId !== null && branchId !== '') {
    if (!(await tmcs.branchInTmc(db, branchId, tmcId))) {
      return Response.json({ error: 'That branch does not belong to your TMC' }, { status: 422 })
    }
  }

  // ── Then write, all or nothing ───────────────────────────────────────────
  // THE FAILURE THIS PREVENTS: both permissions and client access are replaced
  // wholesale, as DELETE-then-INSERT. Without a transaction, an INSERT that
  // fails after its DELETE succeeded leaves the TC with NO permissions and no
  // client access at all -- silently escalating a validation error into a
  // lockout, with nothing recording what the previous state was.
  //
  // Any repository throw rolls the whole block back; route() answers 500.
  await transaction(async tx => {
    if (permissions !== undefined) {
      await employees.revokeAllPermissions(tx, id)
      await employees.grantPermissions(tx, id, permissions, user.id)
    }

    if (clientIds !== undefined) {
      await employees.revokeAllClientAccess(tx, id)
      await employees.grantClientAccess(tx, id, clientIds, user.id)
    }

    if (status !== undefined) {
      await employees.setStatus(tx, id, status)
    }

    // Which office this counsellor works out of. Organisational only — it
    // grants nothing, since client access is employee_client_access above.
    if (branchId !== undefined) {
      await employees.setBranch(tx, id, branchId === null || branchId === '' ? null : branchId)
    }
  }, { tenantId: tmcId, userId: user.id })

  return Response.json({ ok: true })
})
