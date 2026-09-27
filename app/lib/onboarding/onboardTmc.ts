import { createAccount, sendInvite, AccountExists, MailFailed } from '@/app/lib/auth/flows'
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
// The TMC, the admin's account, their employees row and the invite email are
// ONE transaction, email last. A failure anywhere rolls all of it back, and
// there is nothing left to compensate by hand (the GoTrue account used to
// live outside the database and had to be deleted when a later step failed).
// ─────────────────────────────────────────────────────────────────────────────

export interface OnboardTmcInput {
  tmcName: string
  adminEmail: string
  adminName: string
}

export type OnboardTmcResult =
  | { ok: true; tmcId: string; adminUserId: string }
  | { ok: false; error: string; status: number }

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// An invite that could not be made, as the caller should hear it: the address
// already has an account (409), or the email could not be sent (502).
export function inviteFailure(err: unknown): { status: number; error: string } | null {
  if (err instanceof AccountExists) return { status: 409, error: err.message }
  if (err instanceof MailFailed) return { status: 502, error: err.message }
  return null
}

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

  try {
    const created = await transaction(async (tx) => {
      const { id: tmcId } = await tmcs.insertTmc(tx, tmcName)
      const { accountId } = await createAccount(tx, adminEmail, { createdBy: null })
      await employees.insertTmcAdmin(tx, { id: accountId, tmc_id: tmcId, full_name: adminName, email: adminEmail })
      await sendInvite(tx, accountId, null)
      return { tmcId, adminUserId: accountId }
    })

    return { ok: true, ...created }
  } catch (err) {
    console.error('[onboardTmc] failed, rolled back', { tmcName, adminEmail, err })
    return { ok: false, ...(inviteFailure(err) ?? { status: 500, error: 'Failed to create TMC' }) }
  }
}

// ── inviteTmcAdmin ───────────────────────────────────────────────────────────
// A further admin for a TMC that already exists. Same invite, no TMC to
// create.
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

  try {
    const userId = await transaction(async tx => {
      const { accountId } = await createAccount(tx, address, { createdBy: null })
      await employees.insertTmcAdmin(tx, { id: accountId, tmc_id: tmcId, full_name: name, email: address })
      await sendInvite(tx, accountId, null)
      return accountId
    })
    return { ok: true, userId }
  } catch (err) {
    console.error('[inviteTmcAdmin] failed, rolled back', { tmcId, address, err })
    return { ok: false, ...(inviteFailure(err) ?? { status: 500, error: 'Failed to invite the admin' }) }
  }
}
