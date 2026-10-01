import { requireUser } from '@/app/lib/auth/session'
import { sendPasswordReset } from '@/app/lib/auth/flows'
import { requireTmcPermission } from '@/app/lib/permissions/requireTmcPermission'
import { NextRequest } from 'next/server'
import { db, transaction } from '@/app/lib/db'
import * as employees from '@/app/lib/repositories/employees'
import * as clients from '@/app/lib/repositories/clients'
import { route } from '@/app/lib/http/handler'

// ── /api/tmc/clients/[id]/admin-access ───────────────────────────────────────
// GET   the client's corporate admins, so the TMC can see who can let people in
// POST  send one of them a password-reset email
//
// THE OLD SCREEN HAS A "PASSWORD" COLUMN. THIS IS NOT THAT.
// We never display a password, never set one, and never generate one for a TMC
// user to read down the phone. An admin who knows someone's password can act as
// them, and every action would be logged as the client's admin rather than the
// TMC staffer who actually took it. That is precisely the hole
// `must_change_password` exists to close elsewhere in this codebase — reopening it
// here for convenience would be a poor trade.
//
// What a TMC genuinely needs is "this client cannot get in, help them", and a
// reset link does that without anyone learning a credential.
//
// Gated on manage_clients AND on access to this specific client: the permission
// alone is not enough, since a TC holds it for the clients assigned to them.
// ─────────────────────────────────────────────────────────────────────────────

type Ctx = { params: Promise<{ id: string }> }

async function authorise(userId: string, clientId: string) {
  const auth = await requireTmcPermission(db, userId, 'manage_clients', clientId)

  if (!auth.authorized || !auth.tmcId) {
    return { ok: false as const, error: auth.error ?? 'Forbidden', status: auth.status ?? 403 }
  }

  const client = await clients.tenancy(db, clientId)

  if (!client || client.tmc_id !== auth.tmcId) {
    return { ok: false as const, error: 'Client not found for this TMC', status: 404 }
  }

  return { ok: true as const }
}

export const GET = route(async (req: NextRequest, { params }: Ctx) => {
  const { id } = await params
  const user = await requireUser()

  const check = await authorise(user.id, id)
  if (!check.ok) {
    return Response.json({ error: check.error }, { status: check.status })
  }

  // Corporate admins only. A traveller's password is their own business and
  // nothing about this screen should invite a TMC to reach for it.
  return Response.json({ ok: true, admins: await employees.corporateAdmins(db, id) })
})

export const POST = route(async (req: NextRequest, { params }: Ctx) => {
  const { id } = await params
  const user = await requireUser()

  const check = await authorise(user.id, id)
  if (!check.ok) {
    return Response.json({ error: check.error }, { status: check.status })
  }

  const { employeeId }: { employeeId?: string } = await req.json()

  if (!employeeId) {
    return Response.json({ error: 'employeeId is required' }, { status: 400 })
  }

  // Re-read from the database rather than trusting an email in the body. Taking
  // the address from the request would let anyone with this permission send a
  // password reset to an address of their choosing — a way to capture an account
  // rather than help someone back into theirs.
  const admin = await employees.corporateAdmin(db, employeeId, id)

  if (!admin) {
    return Response.json({ error: 'That person is not an admin at this client' }, { status: 404 })
  }

  // The same reset email the login page's "Forgot password" sends, to the
  // address on the account. The account id is the employee id.
  const sent = await transaction(tx => sendPasswordReset(tx, admin.id, user.id))

  if (!sent) {
    return Response.json(
      { error: 'That admin has no sign-in account yet. Invite them instead.' },
      { status: 409 }
    )
  }

  return Response.json({
    ok: true,
    // The address is echoed so the UI can say where it went — a TMC staffer
    // needs to know whether it reached the address the client actually reads.
    message: sent.kind === 'invite'
      ? `${sent.email} has not set a password yet, so a fresh invite was sent instead.`
      : `Password reset sent to ${sent.email}.`,
    sentAt: new Date().toISOString(),
  })
})
