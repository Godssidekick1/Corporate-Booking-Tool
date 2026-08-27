import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { NextRequest } from 'next/server'

// ── PATCH /api/settings/users/[id] ───────────────────────────────────────────
// Admin edits an existing employee: role change and/or status toggle
// (active <-> deactivated). Cannot be used to set status to 'invited' —
// that only happens via the invite route itself.

const VALID_ROLES = ['employee', 'manager', 'finance', 'admin'] as const
type ValidRole = typeof VALID_ROLES[number]

const EDITABLE_STATUSES = ['active', 'deactivated'] as const

interface UpdateEmployeeBody {
  role?: string
  status?: string
  band?: string
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

  const { data: caller, error: callerError } = await service
    .from('employees')
    .select('company_id, role')
    .eq('id', user.id)
    .single()

  if (callerError || !caller) {
    return Response.json({ error: 'Employee record not found' }, { status: 404 })
  }

  if (caller.role !== 'admin') {
    return Response.json({ error: 'Only admins can edit users' }, { status: 403 })
  }

  // Confirm the target employee belongs to the same company
  const { data: target, error: targetError } = await service
    .from('employees')
    .select('id, company_id, status')
    .eq('id', id)
    .eq('company_id', caller.company_id)
    .maybeSingle()

  if (targetError || !target) {
    return Response.json({ error: 'Employee not found in your company' }, { status: 404 })
  }

  // Prevent an admin from deactivating themselves and getting locked out
  if (target.id === user.id) {
    return Response.json({ error: 'You cannot edit your own account here' }, { status: 400 })
  }

  const body: UpdateEmployeeBody = await req.json()
  const { role, status, band, managerId } = body

  const update: Record<string, string | number | null> = {}

  if (role !== undefined) {
    const normalized = role.toLowerCase() as ValidRole
    if (!VALID_ROLES.includes(normalized)) {
      return Response.json({ error: `Invalid role: ${role}` }, { status: 400 })
    }
    update.role = normalized
  }

  if (band !== undefined) {
    const { data: bandRow, error: bandError } = await service
      .from('bands')
      .select('id, code, rank')
      .eq('company_id', caller.company_id)
      .eq('code', band.toUpperCase())
      .single()

    if (bandError || !bandRow) {
      return Response.json({ error: `Band ${band} not found for this company` }, { status: 422 })
    }

    update.band_id = bandRow.id
    update.band_code = bandRow.code
    update.band_rank = bandRow.rank
  }

  if (status !== undefined) {
    if (!EDITABLE_STATUSES.includes(status as typeof EDITABLE_STATUSES[number])) {
      return Response.json(
        { error: `Status must be one of: ${EDITABLE_STATUSES.join(', ')}` },
        { status: 400 }
      )
    }
    // Can't "reactivate" someone who never accepted their invite —
    // they should still be 'invited' until they do.
    if (status === 'active' && target.status === 'invited') {
      return Response.json(
        { error: 'This employee has not accepted their invite yet.' },
        { status: 400 }
      )
    }
    update.status = status
  }

  // manager_id is deliberately NOT editable here any more. The TMC configures
  // approval routing, and 'manager' steps resolve through manager_id — so the
  // TMC has to be able to set it, or it could build a chain whose first step
  // resolves to nobody and have no way to fix it. It now lives at
  // PATCH /api/tmc/employees/[id], and corporate sees the hierarchy read-only.
  if (managerId !== undefined) {
    return Response.json({
      error: 'Reporting lines are maintained by your TMC. Contact them to change a manager.',
    }, { status: 403 })
  }

  if (Object.keys(update).length === 0) {
    return Response.json({ error: 'No fields to update' }, { status: 400 })
  }

  const { data: updated, error: updateError } = await service
    .from('employees')
    .update(update)
    .eq('id', id)
    .select('id, full_name, email, role, status, band_code, manager_id')
    .single()

  if (updateError) {
    return Response.json({ error: updateError.message }, { status: 500 })
  }

  return Response.json({ ok: true, employee: updated })
}