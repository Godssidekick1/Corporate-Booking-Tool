import { db, transaction, type Queryable } from '@/app/lib/db'
import * as accounts from '@/app/lib/repositories/accounts'
import * as audit from '@/app/lib/repositories/audit'
import * as employees from '@/app/lib/repositories/employees'
import { sendMail } from '@/app/lib/mail'
import { inviteEmail, resetEmail } from '@/app/lib/mail/templates'
import { hashPassword, verifyPassword, burnVerifyTime, passwordProblem } from './password'
import { newToken, tokenId, isToken } from './tokens'
import { startSession, refusal, TMC_ROLES, type Principal, type RequestMeta } from './session'
import { appUrl } from './request'
import { newAccountId } from './ids'
import * as throttle from './throttle'

// ── Authentication flows ─────────────────────────────────────────────────────
// Everything that proves who someone is, or changes how they prove it. Routes
// parse and answer HTTP. Each decision lives here once.
//
// Every flow that changes a password ends EVERY existing session of that
// account (a reset, a change, an accepted invite). If a password was
// compromised, the sessions opened with it end too.
//
// Messages are chosen not to reveal which email addresses have accounts:
// unknown address, wrong password and no password yet all read the same, and
// a reset request always "succeeds".
// ─────────────────────────────────────────────────────────────────────────────

export const INVITE_TTL_SECONDS = 7 * 24 * 60 * 60
export const RESET_TTL_SECONDS = 30 * 60

export type Failure = { ok: false; status: number; error: string }

const fail = (status: number, error: string): Failure => ({ ok: false, status, error })

export const MESSAGES = {
  badCredentials: 'Invalid login credentials',
  inactive: 'This account is no longer active. Please contact your travel desk.',
  tooMany: 'Too many attempts. Wait 15 minutes and try again.',
  badLink: 'This link has expired or has already been used. Ask whoever invited you to send a new one, or use "Forgot password" to request a fresh reset link.',
  wrongCurrent: 'Your current password is incorrect.',
  samePassword: 'Choose a password different from your current one.',
  accountExists: 'A user with this email address has already been registered',
  mailFailed: 'The email could not be sent. Check the address and try again, or contact support.',
} as const

export function normalizeEmail(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().toLowerCase() : ''
}

// Where a person lands after signing in.
export function destinationFor(s: Pick<accounts.AccountStanding, 'role' | 'is_platform_admin'>): string {
  if (s.role && TMC_ROLES.includes(s.role)) return '/tmc/dashboard'
  if (s.role) return '/dashboard'
  if (s.is_platform_admin) return '/platform'
  return '/login?error=no_profile'
}

async function record(
  q: Queryable,
  action: string,
  accountId: string,
  actorId: string | null,
  meta: RequestMeta | null,
  extra: Record<string, unknown> = {}
): Promise<void> {
  await audit.append(q, {
    action,
    entityType: 'account',
    entityId: accountId,
    userId: actorId,
    metadata: { ...(meta ? { ip: meta.ip, user_agent: meta.userAgent } : {}), ...extra },
  })
}

// ═══ Sign in / sign out ═════════════════════════════════════════════════════

export interface SignedIn {
  ok: true
  accountId: string
  email: string
  token: string
  expires: Date
  mustChangePassword: boolean
  destination: string
}

export async function signIn(rawEmail: unknown, password: unknown, meta: RequestMeta): Promise<SignedIn | Failure> {
  const email = normalizeEmail(rawEmail)
  if (!email || typeof password !== 'string' || !password) {
    return fail(400, 'email and password are required')
  }

  const emailKey = throttle.keys.signinEmail(email)
  const ipKey = throttle.keys.signinIp(meta.ip)
  if (await throttle.limited([
    { key: emailKey, limit: throttle.LIMITS.signinPerEmail },
    { key: ipKey, limit: throttle.LIMITS.signinPerIp },
  ])) {
    return fail(429, MESSAGES.tooMany)
  }

  const account = await accounts.byEmail(db, email)
  const verified = account?.password_hash
    ? await verifyPassword(account.password_hash, password)
    : (await burnVerifyTime(password), { ok: false, rehash: false })

  if (!account || !verified.ok) {
    await throttle.note(emailKey, ipKey)
    if (account) await record(db, 'auth.signin_failed', account.id, null, meta)
    return fail(401, MESSAGES.badCredentials)
  }

  const standing = await accounts.standingByAccount(db, account.id)
  const refused = standing && refusal(standing)
  if (!standing || refused) {
    await record(db, 'auth.signin_refused', account.id, null, meta, { reason: refused ?? 'no_account' })
    return fail(403, MESSAGES.inactive)
  }

  const rehashed = verified.rehash ? await hashPassword(password) : null
  const session = await transaction(async tx => {
    if (rehashed) await accounts.rehash(tx, account.id, rehashed)
    await accounts.recordSignIn(tx, account.id)
    const s = await startSession(tx, account.id, meta)
    await record(tx, 'auth.signin', account.id, account.id, meta, rehashed ? { upgraded_hash: true } : {})
    return s
  })
  await throttle.clear(emailKey)

  return {
    ok: true,
    accountId: account.id,
    email: account.email,
    ...session,
    mustChangePassword: account.must_change_password,
    destination: destinationFor(standing),
  }
}

export async function signOut(me: Principal, meta: RequestMeta): Promise<void> {
  await transaction(async tx => {
    await accounts.revokeSession(tx, me.sessionId, 'signed_out')
    await record(tx, 'auth.signout', me.id, me.id, meta)
  })
}

// ═══ Links: invites and resets ══════════════════════════════════════════════

function linkFor(token: string, purpose: accounts.TokenPurpose): string {
  // In the FRAGMENT, not the query string: a fragment is never sent to any
  // server, so the token stays out of access logs, proxies and Referer
  // headers. The confirm page reads it in the browser.
  return `${appUrl()}/auth/confirm#type=${purpose}&token=${token}`
}

// Issues a fresh link, retiring any earlier one, and emails it. Runs on the
// caller's connection: inside a transaction, a failed send rolls the whole
// operation back.
async function issueLink(
  q: Queryable,
  account: { id: string; email: string },
  purpose: accounts.TokenPurpose,
  issuedBy: string | null
): Promise<void> {
  const { token, id } = newToken()
  const ttlSeconds = purpose === 'invite' ? INVITE_TTL_SECONDS : RESET_TTL_SECONDS
  await accounts.retireOpenTokens(q, account.id)
  await accounts.insertToken(q, { id, accountId: account.id, purpose, ttlSeconds, createdBy: issuedBy })
  const link = linkFor(token, purpose)
  try {
    await sendMail(purpose === 'invite'
      ? inviteEmail(account.email, link, INVITE_TTL_SECONDS / 86_400)
      : resetEmail(account.email, link, RESET_TTL_SECONDS / 60))
  } catch (err) {
    throw new MailFailed(err)
  }
}

// The mail server refused, or email is not configured. Callers answer it with
// MESSAGES.mailFailed. The server's own text is logged, not shown: it can name
// hosts and accounts.
export class MailFailed extends Error {
  constructor(cause: unknown) {
    super(MESSAGES.mailFailed, { cause })
    this.name = 'MailFailed'
  }
}

// "Forgot password". Always answers the same way, whether or not the address
// has an account, is deactivated, or has asked too often.
export async function requestPasswordReset(rawEmail: unknown, meta: RequestMeta): Promise<{ ok: true } | Failure> {
  const email = normalizeEmail(rawEmail)
  if (!email) return fail(400, 'Enter your email address.')

  const emailKey = throttle.keys.resetEmail(email)
  const ipKey = throttle.keys.resetIp(meta.ip)
  // The IP limit is answered honestly (it says nothing about any account).
  // The per-address one is silent: the request is dropped, the answer is the same.
  if (await throttle.limited([{ key: ipKey, limit: throttle.LIMITS.resetPerIp }])) return fail(429, MESSAGES.tooMany)
  const quiet = await throttle.limited([{ key: emailKey, limit: throttle.LIMITS.resetPerEmail }])
  await throttle.note(emailKey, ipKey)
  if (quiet) return { ok: true }

  const account = await accounts.byEmail(db, email)
  if (!account) return { ok: true }
  // An account that has never had a password was never activated: it is an
  // invite nobody accepted, or someone an admin chose not to invite. A reset
  // would let whoever reads that inbox activate it without the admin. They
  // get in only through an invite; an admin can send a fresh one
  // (sendPasswordReset, below).
  if (!account.password_hash) return { ok: true }
  const standing = await accounts.standingByAccount(db, account.id)
  if (!standing || refusal(standing)) return { ok: true }

  await transaction(async tx => {
    await issueLink(tx, account, 'reset', null)
    await record(tx, 'auth.reset_requested', account.id, null, meta)
  })
  return { ok: true }
}

// An admin helps someone back in: the email is sent on their behalf, and the
// admin never learns or chooses the password. A person who has a password
// gets a reset link. One who never activated gets a fresh invite instead,
// which is how an expired invite is resent. Returns the address and which
// kind went, or null when the person has no account.
export async function sendPasswordReset(
  q: Queryable,
  accountId: string,
  requestedBy: string
): Promise<{ email: string; kind: accounts.TokenPurpose } | null> {
  const account = await accounts.byId(q, accountId)
  if (!account) return null
  const kind: accounts.TokenPurpose = account.password_hash ? 'reset' : 'invite'
  await issueLink(q, account, kind, requestedBy)
  await record(q, kind === 'reset' ? 'auth.reset_sent' : 'auth.invite_sent', account.id, requestedBy, null,
    kind === 'invite' ? { resent: true } : {})
  return { email: account.email, kind }
}

// A reset link only ever applies to an account that already has a password.
// Guards links issued before that rule, and any issued by mistake.
async function linkUsable(open: accounts.OpenToken): Promise<boolean> {
  if (open.purpose !== 'reset') return true
  return Boolean((await accounts.byId(db, open.account_id))?.password_hash)
}

// What a link is for, without spending it: the confirm page shows the address
// before the person commits to a password.
export async function inspectLink(token: unknown, meta: RequestMeta): Promise<{ ok: true; email: string; purpose: accounts.TokenPurpose } | Failure> {
  const ipKey = throttle.keys.linkIp(meta.ip)
  if (await throttle.limited([{ key: ipKey, limit: throttle.LIMITS.linkPerIp }])) return fail(429, MESSAGES.tooMany)
  const found = isToken(token) ? await accounts.openToken(db, tokenId(token)) : null
  const open = found && (await linkUsable(found)) ? found : null
  if (!open) {
    await throttle.note(ipKey)
    return fail(400, MESSAGES.badLink)
  }
  return { ok: true, email: open.email, purpose: open.purpose }
}

// Accepting an invite or completing a reset: choose a password, and be signed
// in. The token is spent only here, on a deliberate submit. An email scanner
// that opens the link spends nothing.
export async function completeLink(token: unknown, password: unknown, meta: RequestMeta): Promise<SignedIn | Failure> {
  const ipKey = throttle.keys.linkIp(meta.ip)
  if (await throttle.limited([{ key: ipKey, limit: throttle.LIMITS.linkPerIp }])) return fail(429, MESSAGES.tooMany)
  if (typeof password !== 'string') return fail(400, 'Choose a password.')

  const id = isToken(token) ? tokenId(token) : null
  const found = id ? await accounts.openToken(db, id) : null
  const open = found && (await linkUsable(found)) ? found : null
  if (!id || !open) {
    await throttle.note(ipKey)
    return fail(400, MESSAGES.badLink)
  }

  const problem = passwordProblem(password, open.email)
  if (problem) return fail(400, problem)

  // Refused BEFORE the token is spent, so a deactivated person's link stays
  // inert rather than being consumed by the attempt.
  const standing = await accounts.standingByAccount(db, open.account_id)
  const refused = standing && refusal(standing)
  if (!standing || refused) return fail(403, MESSAGES.inactive)

  const hashed = await hashPassword(password)
  const result = await transaction(async tx => {
    // Atomic: of two submits racing with one link, exactly one gets here.
    const spent = await accounts.consumeToken(tx, id)
    if (!spent) return null
    await accounts.retireOpenTokens(tx, spent.account_id)
    await accounts.setPassword(tx, spent.account_id, hashed, false)
    await accounts.markVerified(tx, spent.account_id)
    await accounts.revokeAllSessions(tx, spent.account_id, spent.purpose === 'invite' ? 'invite_accepted' : 'password_reset')
    await employees.activateIfInvited(tx, spent.account_id)
    await accounts.recordSignIn(tx, spent.account_id)
    const session = await startSession(tx, spent.account_id, meta)
    await record(tx, spent.purpose === 'invite' ? 'auth.invite_accepted' : 'auth.password_reset', spent.account_id, spent.account_id, meta)
    return session
  })
  if (!result) return fail(400, MESSAGES.badLink)

  return {
    ok: true,
    accountId: open.account_id,
    email: open.email,
    ...result,
    mustChangePassword: false,
    destination: destinationFor(standing),
  }
}

// ═══ Changing a password while signed in ════════════════════════════════════

// Requires the current password: a session left open on a shared machine must
// not be enough to lock the owner out. Also how an admin-set starting password
// is replaced (must_change_password), since the person has just typed it.
export async function changePassword(
  me: Principal,
  current: unknown,
  next: unknown,
  meta: RequestMeta
): Promise<{ ok: true; token: string; expires: Date } | Failure> {
  if (typeof current !== 'string' || typeof next !== 'string' || !current || !next) {
    return fail(400, 'Enter your current password and a new one.')
  }

  const key = throttle.keys.changeAccount(me.id)
  if (await throttle.limited([{ key, limit: throttle.LIMITS.changePerAccount }])) return fail(429, MESSAGES.tooMany)

  const account = await accounts.byId(db, me.id)
  const verified = account?.password_hash
    ? await verifyPassword(account.password_hash, current)
    : { ok: false, rehash: false }
  if (!account || !verified.ok) {
    await throttle.note(key)
    await record(db, 'auth.password_change_failed', me.id, me.id, meta)
    return fail(403, MESSAGES.wrongCurrent)
  }
  if (next === current) return fail(400, MESSAGES.samePassword)
  const problem = passwordProblem(next, account.email)
  if (problem) return fail(400, problem)

  const hashed = await hashPassword(next)
  const session = await transaction(async tx => {
    await accounts.setPassword(tx, me.id, hashed, false)
    // Every session ends, this one included, and this browser gets a fresh
    // one: the old token, if it had leaked, is now worthless.
    await accounts.revokeAllSessions(tx, me.id, 'password_changed')
    const s = await startSession(tx, me.id, meta)
    await record(tx, 'auth.password_changed', me.id, me.id, meta)
    return s
  })
  await throttle.clear(key)
  return { ok: true, ...session }
}

// ═══ Accounts created by an admin ═══════════════════════════════════════════

export class AccountExists extends Error {
  constructor() {
    super(MESSAGES.accountExists)
    this.name = 'AccountExists'
  }
}

// A new account, for someone an admin is adding. Runs on the caller's
// transaction, so the account and the employee record stand or fall together.
//
//   With a password: one the admin chose and hands over themselves. The
//   person must replace it at first sign-in, since until they do the admin
//   knows it.
//   Without one: the person chooses it from an invite (sendInvite, below).
export async function createAccount(
  q: Queryable,
  rawEmail: string,
  opts: { password?: string; createdBy: string | null }
): Promise<{ accountId: string }> {
  const email = normalizeEmail(rawEmail)
  if (await accounts.byEmail(q, email)) throw new AccountExists()
  const direct = typeof opts.password === 'string'
  const { id } = await accounts.insert(q, {
    id: newAccountId(email),
    email,
    passwordHash: direct ? await hashPassword(opts.password!) : null,
    mustChangePassword: direct,
    verified: direct,
  })
  await record(q, 'auth.account_created', id, opts.createdBy, null, { method: direct ? 'direct' : 'invite' })
  return { accountId: id }
}

// Emails an invite link, retiring any earlier one: the first invite, or a
// resend. Call it LAST in the caller's transaction, after the rows the account
// needs exist: a failure here (the mail server refused) rolls everything back,
// and nothing that follows can fail after the email has gone.
export async function sendInvite(q: Queryable, accountId: string, invitedBy: string | null): Promise<void> {
  const account = await accounts.byId(q, accountId)
  if (!account) throw new Error(`[auth] no account ${accountId}`)
  await issueLink(q, account, 'invite', invitedBy)
  await record(q, 'auth.invite_sent', account.id, invitedBy, null)
}

// Deactivation, done: ends every session now rather than at the next request.
export async function endAllSessions(q: Queryable, accountId: string, reason: string, actorId: string): Promise<void> {
  const n = await accounts.revokeAllSessions(q, accountId, reason)
  if (n > 0) await record(q, 'auth.sessions_revoked', accountId, actorId, null, { reason, count: n })
}
