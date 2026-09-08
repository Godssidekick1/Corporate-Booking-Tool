import { createServiceClient } from '@/utils/supabase/service'

type ServiceClient = ReturnType<typeof createServiceClient>

// ── onboardTmc ───────────────────────────────────────────────────────────────
// Creates a TMC and invites its first admin, rolling back if any step fails.
//
// Extracted from /api/internal/create-tmc so the Postman route and the platform
// screen run the SAME code. Two copies of a three-step create-with-rollback is
// how one of them quietly stops rolling back — and a half-created TMC means an
// auth user with no employees row, which nothing in the app can see or repair.
//
// THE ROLLBACK IS NOT TRANSACTIONAL AND CANNOT BE. Creating an auth user is an
// API call to Supabase's auth service, not a row in our database, so it is
// outside any Postgres transaction. What the catch below does is compensate:
// undo what was made, in reverse. That is the best available, and it is why the
// order matters — the auth user is deleted before the TMC, so a failure part-way
// through the compensation still leaves the smaller mess.
// ─────────────────────────────────────────────────────────────────────────────

export interface OnboardTmcInput {
  tmcName: string
  adminEmail: string
  adminName: string
}

export type OnboardTmcResult =
  | { ok: true; tmcId: string; adminUserId: string }
  | { ok: false; error: string; status: number }

// Shared by both entry points so an invite from the screen and an invite from
// Postman land the user in exactly the same place.
//
// redirectTo points at /auth/callback rather than /login: /login is gated by
// proxy.ts's "authenticated user visiting /login -> dashboard" rule, which runs
// before any client page loads, so anyone with an existing session cookie in
// that browser got bounced away before the invite was ever processed.
export function inviteRedirectUrl(): string {
  return `${process.env.NEXT_PUBLIC_APP_URL}/auth/callback?next=/auth/set-password`
}

export async function onboardTmc(
  service: ServiceClient,
  input: OnboardTmcInput
): Promise<OnboardTmcResult> {
  const tmcName = input.tmcName?.trim()
  const adminName = input.adminName?.trim()
  const adminEmail = input.adminEmail?.trim().toLowerCase()

  if (!tmcName || !adminEmail || !adminName) {
    return { ok: false, status: 400, error: 'tmcName, adminEmail and adminName are required' }
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail)) {
    return { ok: false, status: 400, error: `"${adminEmail}" is not a valid email address` }
  }

  // Checked before anything is created, so the common mistake — onboarding the
  // same TMC twice — fails cleanly instead of through the rollback path.
  const { data: clash } = await service
    .from('tmcs')
    .select('id')
    .ilike('name', tmcName)
    .maybeSingle()

  if (clash) {
    return { ok: false, status: 409, error: `A TMC named "${tmcName}" already exists.` }
  }

  let tmcId: string | null = null
  let authUserId: string | null = null

  try {
    const { data: tmc, error: tmcError } = await service
      .from('tmcs')
      .insert({ name: tmcName, status: 'active' })
      .select('id')
      .single()

    if (tmcError) throw new Error(tmcError.message)
    tmcId = tmc.id

    // role and tmc_id go into user_metadata so proxy.ts's role check works on
    // the very first request, without a database round trip.
    const { data: authData, error: inviteError } =
      await service.auth.admin.inviteUserByEmail(adminEmail, {
        redirectTo: inviteRedirectUrl(),
        data: { full_name: adminName, tmc_id: tmcId, role: 'tmc_admin' },
      })

    if (inviteError) throw new Error(inviteError.message)
    authUserId = authData.user.id

    const { error: employeeError } = await service.from('employees').insert({
      id: authUserId,
      tmc_id: tmcId,
      client_id: null,
      full_name: adminName,
      email: adminEmail,
      role: 'tmc_admin',
      status: 'invited',
    })

    if (employeeError) throw new Error(employeeError.message)

    return { ok: true, tmcId: tmcId!, adminUserId: authUserId }
  } catch (err) {
    console.error('[onboardTmc] failed, rolling back', { tmcName, adminEmail, err })

    if (authUserId) await service.auth.admin.deleteUser(authUserId)
    if (tmcId) await service.from('tmcs').delete().eq('id', tmcId)

    return {
      ok: false,
      status: 500,
      error: err instanceof Error ? err.message : 'Failed to create TMC',
    }
  }
}

// ── inviteTmcAdmin ───────────────────────────────────────────────────────────
// A further admin for a TMC that already exists. Same invite shape, no TMC to
// create, so the rollback is just the auth user.
// ─────────────────────────────────────────────────────────────────────────────

export async function inviteTmcAdmin(
  service: ServiceClient,
  tmcId: string,
  fullName: string,
  email: string
): Promise<{ ok: true; userId: string } | { ok: false; error: string; status: number }> {
  const name = fullName?.trim()
  const address = email?.trim().toLowerCase()

  if (!name || !address) {
    return { ok: false, status: 400, error: 'fullName and email are required' }
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
    return { ok: false, status: 400, error: `"${address}" is not a valid email address` }
  }

  const { data: existing } = await service
    .from('employees')
    .select('id')
    .eq('tmc_id', tmcId)
    .eq('email', address)
    .maybeSingle()

  if (existing) {
    return { ok: false, status: 409, error: 'Someone with that email is already at this TMC.' }
  }

  let authUserId: string | null = null

  try {
    const { data: authData, error: inviteError } =
      await service.auth.admin.inviteUserByEmail(address, {
        redirectTo: inviteRedirectUrl(),
        data: { full_name: name, tmc_id: tmcId, role: 'tmc_admin' },
      })

    if (inviteError) throw new Error(inviteError.message)
    authUserId = authData.user.id

    const { error: employeeError } = await service.from('employees').insert({
      id: authUserId,
      tmc_id: tmcId,
      client_id: null,
      full_name: name,
      email: address,
      role: 'tmc_admin',
      status: 'invited',
    })

    if (employeeError) throw new Error(employeeError.message)

    return { ok: true, userId: authUserId }
  } catch (err) {
    console.error('[inviteTmcAdmin] failed, rolling back', { tmcId, address, err })
    if (authUserId) await service.auth.admin.deleteUser(authUserId)
    return {
      ok: false,
      status: 500,
      error: err instanceof Error ? err.message : 'Failed to invite the admin',
    }
  }
}
