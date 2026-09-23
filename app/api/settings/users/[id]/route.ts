import { createClient } from '@/utils/supabase/server'
import { NextRequest } from 'next/server'
import { db } from '@/app/lib/db'
import * as employees from '@/app/lib/repositories/employees'
import { route } from '@/app/lib/http/handler'

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

  const caller = await employees.clientScope(db, user.id)

  if (!caller) {
    return Response.json({ error: 'Employee record not found' }, { status: 404 })
  }

  if (caller.role !== 'admin') {
    return Response.json({ error: 'Only admins can edit users' }, { status: 403 })
  }

  // Confirm the target employee belongs to the same client
  const target = caller.client_id
    ? await employees.findWithStatusInClient(db, id, caller.client_id)
    : null

  if (!target) {
    return Response.json({ error: 'Employee not found in your client' }, { status: 404 })
  }

  // Prevent an admin from deactivating themselves and getting locked out
  if (target.id === user.id) {
    return Response.json({ error: 'You cannot edit your own account here' }, { status: 400 })
  }

  const body: UpdateEmployeeBody = await req.json()
  const { role, status, band, managerId } = body

  const update: employees.CorporateEdit = {}

  if (role !== undefined) {
    const normalized = role.toLowerCase() as ValidRole
    if (!VALID_ROLES.includes(normalized)) {
      return Response.json({ error: `Invalid role: ${role}` }, { status: 400 })
    }
    update.role = normalized
  }

  // band is deliberately NOT editable here any more, for the same reason as
  // manager_id below: it drives policy, which the TMC owns. A client moving
  // someone between bands would silently change the limits the TMC configured
  // for them. It now lives at PATCH /api/tmc/employees/[id].
  if (band !== undefined) {
    return Response.json({
      error: 'Bands are maintained by your TMC. Contact them to move someone between bands.',
    }, { status: 403 })
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

  const updated = await employees.applyCorporateEdit(db, id, update)

  return Response.json({ ok: true, employee: updated })
})