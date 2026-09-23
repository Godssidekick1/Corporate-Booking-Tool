import { createClient } from '@/utils/supabase/server'
import { requireTmcPermission } from '@/app/lib/permissions/requireTmcPermission'
import { validateManagerAssignment } from '@/app/lib/hierarchy/validateManagerAssignment'
import { NextRequest } from 'next/server'
import { db } from '@/app/lib/db'
import * as employees from '@/app/lib/repositories/employees'
import * as clients from '@/app/lib/repositories/clients'
import { route } from '@/app/lib/http/handler'

// ── PATCH /api/tmc/employees/[id] ────────────────────────────────────────────
// Sets a client employee's reporting line and band.
//
// Both live on the TMC side because both feed things the TMC owns:
//   manager_id       — an approval step of type 'manager' resolves through it
//   band             — policy groups match on band rank
//
// If only the corporate admin could set them, a TMC could configure policy and
// approvals that resolve to nothing and have no way to fix it. Corporate keeps
// a read-only view of both.
//
// topOfHierarchy marks someone with nobody above them, which is different from
// nobody having got round to setting their manager yet. Without it the owner of
// a client is permanently reported as a misconfiguration.
// ─────────────────────────────────────────────────────────────────────────────

interface UpdateBody {
  managerId?: string | null
  topOfHierarchy?: boolean
  band?: string
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

  const target = await employees.reportingTarget(db, id)

  if (!target?.client_id) {
    return Response.json({ error: 'Employee not found' }, { status: 404 })
  }

  // Passing clientId also enforces per-client access for 'tc' callers, not
  // just the manage_users permission itself.
  const auth = await requireTmcPermission(db, user.id, 'manage_users', target.client_id)
  if (!auth.authorized || !auth.tmcId) {
    return Response.json({ error: auth.error ?? 'Forbidden' }, { status: auth.status ?? 403 })
  }

  // A tmc_admin passes the permission check for any clientId, so the tenancy
  // boundary is checked explicitly here.
  const client = await clients.tenancy(db, target.client_id)

  if (!client || client.tmc_id !== auth.tmcId) {
    return Response.json({ error: 'Employee not found for this TMC' }, { status: 404 })
  }

  const body: UpdateBody = await req.json()
  const update: employees.ReportingEdit = {}

  // ── Top of hierarchy ──────────────────────────────────────────────────────
  // Marking someone top clears their manager in the same write. The DB rejects
  // holding both, and doing it here means the caller never has to send two
  // requests in the right order.
  if (body.topOfHierarchy !== undefined) {
    update.top_of_hierarchy = body.topOfHierarchy
    if (body.topOfHierarchy) update.manager_id = null
  }

  // ── Manager ───────────────────────────────────────────────────────────────
  if (body.managerId !== undefined) {
    if (body.managerId && body.topOfHierarchy) {
      return Response.json(
        { error: 'Someone at the top of the hierarchy cannot also report to a manager.' },
        { status: 400 }
      )
    }

    const validation = await validateManagerAssignment(
      db,
      target.id,
      target.client_id,
      body.managerId
    )

    if (!validation.ok) {
      return Response.json({ error: validation.error }, { status: validation.status })
    }

    update.manager_id = validation.managerId
    // Giving someone a manager necessarily means they are not the top.
    if (validation.managerId) update.top_of_hierarchy = false
  }

  // ── Band ──────────────────────────────────────────────────────────────────
  // band_code and band_rank are denormalised alongside band_id, the same way
  // every other writer sets them, so policy resolution and the dashboard stay
  // consistent without a join.
  if (body.band !== undefined) {
    const bandRow = await employees.bandByCode(db, target.client_id, body.band)

    if (!bandRow) {
      return Response.json(
        { error: `Band "${body.band}" is not configured for this client` },
        { status: 422 }
      )
    }

    update.band_id = bandRow.id
    update.band_code = bandRow.code
    update.band_rank = bandRow.rank
  }

  if (Object.keys(update).length === 0) {
    return Response.json({ error: 'Nothing to update' }, { status: 400 })
  }

  const updated = await employees.applyReportingEdit(db, id, update)

  return Response.json({ ok: true, employee: updated })
})
