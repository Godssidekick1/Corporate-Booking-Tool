import { requireUser } from '@/app/lib/auth/session'
import { requireTmcPermission } from '@/app/lib/permissions/requireTmcPermission'
import { validateManagerAssignment } from '@/app/lib/hierarchy/validateManagerAssignment'
import { NextRequest } from 'next/server'
import { db, transaction } from '@/app/lib/db'
import * as employees from '@/app/lib/repositories/employees'
import * as clients from '@/app/lib/repositories/clients'
import * as accounts from '@/app/lib/repositories/accounts'
import * as audit from '@/app/lib/repositories/audit'
import { route } from '@/app/lib/http/handler'
import { CLIENT_ROLES, CLIENT_ROLE_LABEL, isClientRole, type ClientRole } from '@/app/lib/clients/roles'

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
//
// role makes someone a corporate admin (or finance, or back to employee). The
// TMC can do it because the TMC onboards the client, and is who a company
// calls when its only admin has left. A client keeps at least one active
// admin: removing the last one is refused (409), or nobody at the company
// could manage its users and settings. Every change is audited.
// ─────────────────────────────────────────────────────────────────────────────

interface UpdateBody {
  managerId?: string | null
  topOfHierarchy?: boolean
  band?: string
  role?: string
}

export const PATCH = route(async (
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const { id } = await params
  const user = await requireUser()

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

  // ── Role ──────────────────────────────────────────────────────────────────
  let role: ClientRole | undefined
  if (body.role !== undefined) {
    if (!isClientRole(body.role)) {
      return Response.json({ error: `role must be one of ${CLIENT_ROLES.join(', ')}` }, { status: 400 })
    }
    if (body.role !== target.role) {
      if (target.status !== 'active') {
        return Response.json(
          { error: `${target.full_name} is deactivated. Reactivate them before changing their role.` },
          { status: 409 }
        )
      }
      role = body.role
    }
  }

  if (Object.keys(update).length === 0 && role === undefined) {
    // A role sent unchanged is not an error: there is just nothing to do.
    if (body.role !== undefined) return Response.json({ ok: true, employee: { id: target.id, role: target.role } })
    return Response.json({ error: 'Nothing to update' }, { status: 400 })
  }

  // One transaction: the last-admin check holds a lock on the client's admins
  // until the role is written, so two removals at once cannot leave none.
  const clientId = target.client_id
  const outcome = await transaction(async tx => {
    if (role !== undefined && target.role === 'admin') {
      const admins = await employees.lockActiveAdmins(tx, clientId)
      if (admins.filter(a => a !== target.id).length === 0) return { lastAdmin: true as const }
    }
    const updated = Object.keys(update).length ? await employees.applyReportingEdit(tx, id, update) : null
    if (role !== undefined) {
      await employees.setRole(tx, id, role)
      await audit.append(tx, {
        action: 'employee.role_changed', entityType: 'employee', entityId: id, userId: user.id,
        clientId, tmcId: auth.tmcId, metadata: { from: target.role, to: role },
      })
    }
    return { lastAdmin: false as const, updated }
  }, { tenantId: auth.tmcId, userId: user.id })

  if (outcome.lastAdmin) {
    return Response.json({
      error: `${target.full_name} is this company's only corporate admin. Make someone else an admin first, so the company can still manage its users and settings.`,
      code: 'LAST_ADMIN',
    }, { status: 409 })
  }

  // Given a role that needs signing in, but they cannot yet: say so, so the
  // desk sends their invite (POST /api/tmc/employees/[id]/invite).
  let signIn: { canSignIn: boolean; note?: string } | undefined
  if (role !== undefined) {
    const account = await accounts.byId(db, id)
    const canSignIn = Boolean(account?.password_hash)
    signIn = canSignIn || role === 'employee' ? { canSignIn } : {
      canSignIn,
      note: account
        ? `${target.full_name} is now ${CLIENT_ROLE_LABEL[role]} but cannot sign in yet. Send their invite so they can use it.`
        : `${target.full_name} is now ${CLIENT_ROLE_LABEL[role]} but has no sign-in yet.`,
    }
  }

  return Response.json({
    ok: true,
    // The role is in the answer only when the request was about a role; a
    // manager or band edit answers exactly as it always has.
    employee: body.role !== undefined
      ? { ...(outcome.updated ?? { id: target.id }), role: role ?? target.role }
      : outcome.updated,
    ...(signIn ?? {}),
  })
})
