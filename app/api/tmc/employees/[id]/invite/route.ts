import { requireUser } from '@/app/lib/auth/session'
import { sendInvite } from '@/app/lib/auth/flows'
import { requireTmcPermission } from '@/app/lib/permissions/requireTmcPermission'
import { inviteFailure } from '@/app/lib/onboarding/onboardTmc'
import { NextRequest } from 'next/server'
import { db, transaction } from '@/app/lib/db'
import * as employees from '@/app/lib/repositories/employees'
import * as accounts from '@/app/lib/repositories/accounts'
import * as clients from '@/app/lib/repositories/clients'
import { route } from '@/app/lib/http/handler'

// ── POST /api/tmc/employees/[id]/invite ─────────────────────────────────────
// Emails a client's employee an invite to set their password: someone who
// never accepted the first one (it lasts 7 days), or who was added before
// every employee got credentials. Sending a new one retires the old link.
//
// Only for people who cannot sign in yet. Someone with a password resets a
// forgotten one themselves from the sign-in page; the travel desk must not be
// able to start a reset on a corporate user's account.
// ─────────────────────────────────────────────────────────────────────────────

export const POST = route(async (
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const { id } = await params
  const user = await requireUser()

  const target = await employees.reportingTarget(db, id)
  if (!target?.client_id) {
    return Response.json({ error: 'Employee not found' }, { status: 404 })
  }

  const auth = await requireTmcPermission(db, user.id, 'manage_users', target.client_id)
  if (!auth.authorized || !auth.tmcId) {
    return Response.json({ error: auth.error ?? 'Forbidden' }, { status: auth.status ?? 403 })
  }

  const client = await clients.tenancy(db, target.client_id)
  if (!client || client.tmc_id !== auth.tmcId) {
    return Response.json({ error: 'Employee not found for this TMC' }, { status: 404 })
  }

  if (target.status === 'deactivated') {
    return Response.json({ error: `${target.full_name} is deactivated. Reactivate them first.` }, { status: 409 })
  }

  const account = await accounts.byId(db, id)
  if (!account) {
    return Response.json({ error: `${target.full_name} has no account to invite` }, { status: 409 })
  }
  if (account.password_hash) {
    return Response.json(
      { error: `${target.full_name} can already sign in. A forgotten password can be reset from the sign-in page.` },
      { status: 409 }
    )
  }

  try {
    await transaction(tx => sendInvite(tx, id, user.id), { tenantId: auth.tmcId, userId: user.id })
  } catch (err) {
    const failure = inviteFailure(err)
    if (failure) return Response.json({ error: failure.error }, { status: failure.status })
    throw err
  }

  return Response.json({ ok: true, message: `Invite sent to ${account.email}.` })
})
