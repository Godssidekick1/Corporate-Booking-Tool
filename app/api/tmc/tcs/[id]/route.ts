import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { isPermissionKey } from '@/app/lib/permissions/permissionKeys'
import { NextRequest } from 'next/server'

// ── PATCH /api/tmc/tcs/[id] ──────────────────────────────────────────────────
// Replaces a TC's permission set and/or company access list wholesale
// (simpler and safer than incremental add/remove — the admin always submits
// the complete intended state). Status (active/deactivated) can also be set.


interface UpdateTcBody {
  permissions?: string[]
  companyIds?: string[]
  status?: 'active' | 'deactivated'
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
  const { permissions, companyIds, status } = body

  if (permissions !== undefined) {
    const invalid = permissions.filter(p => !isPermissionKey(p))
    if (invalid.length > 0) {
      return Response.json({ error: `Invalid permission(s): ${invalid.join(', ')}` }, { status: 400 })
    }

    await service.from('employee_permissions').delete().eq('employee_id', id)
    if (permissions.length > 0) {
      const { error } = await service.from('employee_permissions').insert(
        permissions.map(p => ({ employee_id: id, permission_key: p, granted_by: user.id }))
      )
      if (error) return Response.json({ error: error.message }, { status: 500 })
    }
  }

  if (companyIds !== undefined) {
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

    await service.from('employee_company_access').delete().eq('employee_id', id)
    if (companyIds.length > 0) {
      const { error } = await service.from('employee_company_access').insert(
        companyIds.map(cid => ({ employee_id: id, company_id: cid, granted_by: user.id }))
      )
      if (error) return Response.json({ error: error.message }, { status: 500 })
    }
  }

  if (status !== undefined) {
    if (!['active', 'deactivated'].includes(status)) {
      return Response.json({ error: 'Invalid status' }, { status: 400 })
    }
    const { error } = await service.from('employees').update({ status }).eq('id', id)
    if (error) return Response.json({ error: error.message }, { status: 500 })
  }

  return Response.json({ ok: true })
}