import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { isPermissionKey } from '@/app/lib/permissions/permissionKeys'
import { withTransaction, orAbort } from '@/app/lib/db/tx'
import { NextRequest } from 'next/server'

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

async function getTmcCaller(userId: string, service: ReturnType<typeof createServiceClient>) {
  const { data: caller } = await service
    .from('employees')
    .select('role, tmc_id')
    .eq('id', userId)
    .single()
  if (!caller || caller.role !== 'tmc_admin' || !caller.tmc_id) return null
  return caller
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const service = createServiceClient()
  const caller = await getTmcCaller(user.id, service)
  if (!caller) {
    return Response.json({ error: 'Only TMC admins can edit TCs' }, { status: 403 })
  }

  const { data: target } = await service
    .from('employees')
    .select('id')
    .eq('id', id)
    .eq('tmc_id', caller.tmc_id)
    .eq('role', 'tc')
    .maybeSingle()

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
    const { data: validClients } = await service
      .from('clients')
      .select('id')
      .eq('tmc_id', caller.tmc_id)
      .in('id', clientIds)

    if ((validClients?.length ?? 0) !== clientIds.length) {
      return Response.json({ error: 'One or more clients not found for your TMC' }, { status: 400 })
    }
  }

  if (status !== undefined && !['active', 'deactivated'].includes(status)) {
    return Response.json({ error: 'Invalid status' }, { status: 400 })
  }

  // branch_id is a plain FK, so another tenant's branch would satisfy the
  // constraint and quietly file this person under someone else's office.
  if (branchId !== undefined && branchId !== null && branchId !== '') {
    const { data: branch } = await service
      .from('branches')
      .select('id')
      .eq('id', branchId)
      .eq('tmc_id', caller.tmc_id)
      .maybeSingle()

    if (!branch) {
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
  // It was worse than that: the two deletes did not check their own error, so
  // a failed delete was ignored and the insert that followed simply added
  // duplicates on top of rows that were supposed to be gone.
  const { error: writeError } = await withTransaction(async (db) => {
    if (permissions !== undefined) {
      await orAbort(db.from('employee_permissions').delete().eq('employee_id', id))
      if (permissions.length > 0) {
        await orAbort(db.from('employee_permissions').insert(
          permissions.map(p => ({ employee_id: id, permission_key: p, granted_by: user.id }))
        ))
      }
    }

    if (clientIds !== undefined) {
      await orAbort(db.from('employee_client_access').delete().eq('employee_id', id))
      if (clientIds.length > 0) {
        await orAbort(db.from('employee_client_access').insert(
          clientIds.map(cid => ({ employee_id: id, client_id: cid, granted_by: user.id }))
        ))
      }
    }

    if (status !== undefined) {
      await orAbort(db.from('employees').update({ status }).eq('id', id))
    }

    // Which office this counsellor works out of. Organisational only — it
    // grants nothing, since client access is employee_client_access above.
    if (branchId !== undefined) {
      const value = branchId === null || branchId === '' ? null : branchId
      await orAbort(db.from('employees').update({ branch_id: value }).eq('id', id))
    }
  })

  if (writeError) {
    return Response.json({ error: writeError.message }, { status: 500 })
  }

  return Response.json({ ok: true })
}