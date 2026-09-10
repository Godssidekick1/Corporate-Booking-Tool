import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { requireTmcPermission } from '@/app/lib/permissions/requireTmcPermission'
import { inviteRedirectUrl } from '@/app/lib/onboarding/onboardTmc'
import { NextRequest } from 'next/server'

// ── /api/tmc/clients/[id]/admin-access ───────────────────────────────────────
// GET   the client's corporate admins, so the TMC can see who can let people in
// POST  send one of them a password-reset email
//
// THE OLD SCREEN HAS A "PASSWORD" COLUMN. THIS IS NOT THAT.
// We never display a password, never set one, and never generate one for a TMC
// user to read down the phone. An admin who knows someone's password can act as
// them, and every action would be logged as the client's admin rather than the
// TMC staffer who actually took it. That is precisely the hole
// `must_set_password` exists to close elsewhere in this codebase — reopening it
// here for convenience would be a poor trade.
//
// What a TMC genuinely needs is "this client cannot get in, help them", and a
// reset link does that without anyone learning a credential.
//
// Gated on manage_clients AND on access to this specific client: the permission
// alone is not enough, since a TC holds it for the clients assigned to them.
// ─────────────────────────────────────────────────────────────────────────────

async function authorise(userId: string, clientId: string) {
  const service = createServiceClient()
  const auth = await requireTmcPermission(service, userId, 'manage_clients', clientId)

  if (!auth.authorized || !auth.tmcId) {
    return { ok: false as const, error: auth.error ?? 'Forbidden', status: auth.status ?? 403 }
  }

  const { data: client } = await service
    .from('clients')
    .select('id, name, tmc_id')
    .eq('id', clientId)
    .maybeSingle()

  if (!client || client.tmc_id !== auth.tmcId) {
    return { ok: false as const, error: 'Client not found for this TMC', status: 404 }
  }

  return { ok: true as const, service, client }
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const check = await authorise(user.id, id)
  if (!check.ok) {
    return Response.json({ error: check.error }, { status: check.status })
  }

  // Corporate admins only. A traveller's password is their own business and
  // nothing about this screen should invite a TMC to reach for it.
  const { data: admins } = await check.service
    .from('employees')
    .select('id, full_name, email, status, created_at')
    .eq('client_id', id)
    .eq('role', 'admin')
    .order('full_name')

  return Response.json({ ok: true, admins: admins ?? [] })
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

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
  const { data: admin } = await check.service
    .from('employees')
    .select('id, full_name, email, role, client_id')
    .eq('id', employeeId)
    .eq('client_id', id)
    .eq('role', 'admin')
    .maybeSingle()

  if (!admin) {
    return Response.json({ error: 'That person is not an admin at this client' }, { status: 404 })
  }

  // Same destination as the reset flow on the login page: /auth/callback does a
  // server-side code exchange and is exempt from the proxy rule that bounces an
  // authenticated user away from /login before any client code runs.
  const { error: resetError } = await check.service.auth.resetPasswordForEmail(
    admin.email,
    { redirectTo: inviteRedirectUrl() }
  )

  if (resetError) {
    return Response.json({ error: resetError.message }, { status: 500 })
  }

  return Response.json({
    ok: true,
    // The address is echoed so the UI can say where it went — a TMC staffer
    // needs to know whether it reached the address the client actually reads.
    message: `Password reset sent to ${admin.email}.`,
    sentAt: new Date().toISOString(),
  })
}
