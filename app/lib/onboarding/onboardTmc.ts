import { createServiceClient } from '@/utils/supabase/service'
import { db, transaction } from '@/app/lib/db'
import * as tmcs from '@/app/lib/repositories/tmcs'
import * as employees from '@/app/lib/repositories/employees'

// ── onboardTmc ───────────────────────────────────────────────────────────────
// Creates a TMC and invites its first admin, rolling back if any step fails.
//
// Extracted from /api/internal/create-tmc so the Postman route and the platform
// screen run the SAME code. Two copies of a three-step create-with-rollback is
// how one of them quietly stops rolling back — and a half-created TMC means an
// auth user with no employees row, which nothing in the app can see or repair.
//
// The TMC and its admin's row are one transaction, with the invite between
// them (the invite needs the TMC's id). A failure anywhere rolls the database
// back by itself. The invite is an API call to Supabase's auth service, outside
// any Postgres transaction, so it alone is compensated by hand: if it
// succeeded and a later step failed, the account is deleted.
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

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// The auth service refused the invite; its message is the useful one to show.
class InviteRefused extends Error {}

export async function onboardTmc(input: OnboardTmcInput): Promise<OnboardTmcResult> {
  const tmcName = input.tmcName?.trim()
  const adminName = input.adminName?.trim()
  const adminEmail = input.adminEmail?.trim().toLowerCase()

  if (!tmcName || !adminEmail || !adminName) {
    return { ok: false, status: 400, error: 'tmcName, adminEmail and adminName are required' }
  }

  if (!EMAIL.test(adminEmail)) {
    return { ok: false, status: 400, error: `"${adminEmail}" is not a valid email address` }
  }

  // Checked before anything is created, so the common mistake — onboarding the
  // same TMC twice — fails cleanly instead of through the rollback path.
  //
  // An existence check. The shim version was maybeSingle() over an ilike,
  // which ERRORED once a name existed twice -- the error was discarded, the
  // check read "no clash", and another copy was created. That is how one
  // database came to hold seventeen "AMEX".
  if (await tmcs.nameTaken(db, tmcName)) {
    return { ok: false, status: 409, error: `A TMC named "${tmcName}" already exists.` }
  }

  const auth = createServiceClient().auth.admin
  let authUserId: string | null = null

  try {
    const tmcId = await transaction(async (tx) => {
      const { id } = await tmcs.insertTmc(tx, tmcName)

      // role and tmc_id go into user_metadata so proxy.ts's role check works on
      // the very first request, without a database round trip.
      const { data: authData, error: inviteError } = await auth.inviteUserByEmail(adminEmail, {
        redirectTo: inviteRedirectUrl(),
        data: { full_name: adminName, tmc_id: id, role: 'tmc_admin' },
      })
      if (inviteError) throw new InviteRefused(inviteError.message)
      authUserId = authData.user.id

      await employees.insertTmcAdmin(tx, { id: authUserId, tmc_id: id, full_name: adminName, email: adminEmail })
      return id
    })

    return { ok: true, tmcId, adminUserId: authUserId! }
  } catch (err) {
    console.error('[onboardTmc] failed, rolled back', { tmcName, adminEmail, err })
    if (authUserId) await auth.deleteUser(authUserId)

    return {
      ok: false,
      status: 500,
      error: err instanceof InviteRefused ? err.message : 'Failed to create TMC',
    }
  }
}

// ── inviteTmcAdmin ───────────────────────────────────────────────────────────
// A further admin for a TMC that already exists. Same invite shape, no TMC to
// create, so the rollback is just the auth user.
// ─────────────────────────────────────────────────────────────────────────────

export async function inviteTmcAdmin(
  tmcId: string,
  fullName: string,
  email: string
): Promise<{ ok: true; userId: string } | { ok: false; error: string; status: number }> {
  const name = fullName?.trim()
  const address = email?.trim().toLowerCase()

  if (!name || !address) {
    return { ok: false, status: 400, error: 'fullName and email are required' }
  }
  if (!EMAIL.test(address)) {
    return { ok: false, status: 400, error: `"${address}" is not a valid email address` }
  }

  if (await employees.findByEmailInTmc(db, tmcId, address)) {
    return { ok: false, status: 409, error: 'Someone with that email is already at this TMC.' }
  }

  const auth = createServiceClient().auth.admin
  let authUserId: string | null = null

  try {
    const { data: authData, error: inviteError } = await auth.inviteUserByEmail(address, {
      redirectTo: inviteRedirectUrl(),
      data: { full_name: name, tmc_id: tmcId, role: 'tmc_admin' },
    })
    if (inviteError) throw new InviteRefused(inviteError.message)
    authUserId = authData.user.id

    await employees.insertTmcAdmin(db, { id: authUserId, tmc_id: tmcId, full_name: name, email: address })

    return { ok: true, userId: authUserId }
  } catch (err) {
    console.error('[inviteTmcAdmin] failed, rolling back', { tmcId, address, err })
    if (authUserId) await auth.deleteUser(authUserId)
    return {
      ok: false,
      status: 500,
      error: err instanceof InviteRefused ? err.message : 'Failed to invite the admin',
    }
  }
}
