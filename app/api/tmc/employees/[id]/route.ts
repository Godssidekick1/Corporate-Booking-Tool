import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { requireTmcPermission } from '@/app/lib/permissions/requireTmcPermission'
import { validateManagerAssignment } from '@/app/lib/hierarchy/validateManagerAssignment'
import { NextRequest } from 'next/server'

// ── PATCH /api/tmc/employees/[id] ────────────────────────────────────────────
// Sets a client employee's manager.
//
// This lives on the TMC side because the TMC configures approval routing, and a
// step of type 'manager' resolves through employees.manager_id. If only the
// corporate admin could set it, a TMC could build a chain whose first step
// resolves to nobody and have no way to fix it. Corporate keeps a read-only
// view of the same hierarchy.
//
// Validation is shared with nothing else now, but deliberately lives in
// app/lib/hierarchy/validateManagerAssignment.ts rather than inline: the cycle
// walk is the part that matters, and resolveApproverForTier would chase
// manager_id forever if a loop ever got in.
// ─────────────────────────────────────────────────────────────────────────────

interface UpdateBody {
  managerId?: string | null
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

  const { data: target } = await service
    .from('employees')
    .select('id, company_id, full_name')
    .eq('id', id)
    .maybeSingle()

  if (!target?.company_id) {
    return Response.json({ error: 'Employee not found' }, { status: 404 })
  }

  // Passing companyId also enforces per-company access for 'tc' callers, not
  // just the manage_users permission itself.
  const auth = await requireTmcPermission(service, user.id, 'manage_users', target.company_id)
  if (!auth.authorized || !auth.tmcId) {
    return Response.json({ error: auth.error ?? 'Forbidden' }, { status: auth.status ?? 403 })
  }

  // A tmc_admin passes the permission check for any companyId, so the tenancy
  // boundary is checked explicitly here.
  const { data: company } = await service
    .from('companies')
    .select('id, tmc_id')
    .eq('id', target.company_id)
    .maybeSingle()

  if (!company || company.tmc_id !== auth.tmcId) {
    return Response.json({ error: 'Employee not found for this TMC' }, { status: 404 })
  }

  const body: UpdateBody = await req.json()

  if (body.managerId === undefined) {
    return Response.json({ error: 'managerId is required' }, { status: 400 })
  }

  const validation = await validateManagerAssignment(
    service,
    target.id,
    target.company_id,
    body.managerId
  )

  if (!validation.ok) {
    return Response.json({ error: validation.error }, { status: validation.status })
  }

  const { data: updated, error } = await service
    .from('employees')
    .update({ manager_id: validation.managerId })
    .eq('id', id)
    .select('id, full_name, manager_id')
    .single()

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  return Response.json({ ok: true, employee: updated })
}
