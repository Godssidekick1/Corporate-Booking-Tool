import { sql, many, maybeOne, one, exec, type Queryable } from '@/app/lib/db/sql'
import type { Row } from '@/app/lib/db/types.generated'

// ── Identity ─────────────────────────────────────────────────────────────────
// Owns: accounts, sessions, auth_tokens, auth_attempts.
//
// Data only. What a session or a token MEANS -- how long it lives, who may be
// refused -- is decided in app/lib/auth. Tokens arrive here already hashed:
// nothing in this file ever sees a value a browser holds.
// ─────────────────────────────────────────────────────────────────────────────

// ═══ accounts ═══════════════════════════════════════════════════════════════

export type Account = Pick<Row<'accounts'>,
  'id' | 'email' | 'must_change_password' | 'email_verified_at' | 'last_sign_in_at'>

export type AccountCredentials = Account & Pick<Row<'accounts'>, 'password_hash'>

export async function byEmail(db: Queryable, email: string): Promise<AccountCredentials | null> {
  return maybeOne<AccountCredentials>(db, sql`
    select id, email, password_hash, must_change_password, email_verified_at, last_sign_in_at
    from accounts where email = ${email}`)
}

export async function byId(db: Queryable, id: string): Promise<AccountCredentials | null> {
  return maybeOne<AccountCredentials>(db, sql`
    select id, email, password_hash, must_change_password, email_verified_at, last_sign_in_at
    from accounts where id = ${id}`)
}

export interface NewAccount {
  id: string
  email: string
  // Null for an invite: the person chooses it.
  passwordHash: string | null
  mustChangePassword: boolean
  // An admin-created account is verified by the admin who typed the address.
  verified: boolean
}

export async function insert(db: Queryable, account: NewAccount): Promise<{ id: string }> {
  return one<{ id: string }>(db, sql`
    insert into accounts (id, email, password_hash, must_change_password, email_verified_at, password_changed_at)
    values (
      ${account.id}, ${account.email}, ${account.passwordHash}, ${account.mustChangePassword},
      case when ${account.verified}::boolean then now() end,
      case when ${account.passwordHash}::text is not null then now() end
    )
    returning id`)
}

// A new password, chosen by the person or set by an admin.
export async function setPassword(
  db: Queryable,
  id: string,
  passwordHash: string,
  mustChangePassword: boolean
): Promise<void> {
  await exec(db, sql`
    update accounts set
      password_hash = ${passwordHash},
      must_change_password = ${mustChangePassword},
      password_changed_at = now(),
      updated_at = now()
    where id = ${id}`)
}

// The same password, stored under a stronger hash (an imported bcrypt hash,
// upgraded at sign-in). Not a password change: sessions and
// password_changed_at are left alone.
export async function rehash(db: Queryable, id: string, passwordHash: string): Promise<void> {
  await exec(db, sql`update accounts set password_hash = ${passwordHash}, updated_at = now() where id = ${id}`)
}

export async function markVerified(db: Queryable, id: string): Promise<void> {
  await exec(db, sql`
    update accounts set email_verified_at = coalesce(email_verified_at, now()), updated_at = now()
    where id = ${id}`)
}

export async function recordSignIn(db: Queryable, id: string): Promise<void> {
  await exec(db, sql`update accounts set last_sign_in_at = now() where id = ${id}`)
}

export async function remove(db: Queryable, id: string): Promise<void> {
  await exec(db, sql`delete from accounts where id = ${id}`)
}

// ═══ sessions ═══════════════════════════════════════════════════════════════

export interface NewSession {
  id: string
  accountId: string
  idleSeconds: number
  absoluteSeconds: number
  ip: string | null
  userAgent: string | null
}

export async function insertSession(db: Queryable, s: NewSession): Promise<{ absolute_expires_at: string }> {
  return one<{ absolute_expires_at: string }>(db, sql`
    insert into sessions (id, account_id, idle_expires_at, absolute_expires_at, ip, user_agent)
    values (
      ${s.id}, ${s.accountId},
      now() + make_interval(secs => ${s.idleSeconds}),
      now() + make_interval(secs => ${s.absoluteSeconds}),
      ${s.ip}, ${s.userAgent}
    )
    returning absolute_expires_at`)
}

// Everything a request needs to know about its caller, in one query: the
// session, the account, the employee record and the standing of the client
// and TMC it belongs to. Returns null for a session that is unknown, revoked
// or expired. Whether a LIVE session's owner is still allowed in is decided by
// the caller (app/lib/auth/session.ts), from the statuses returned here.
export interface AccountStanding {
  account_id: string
  email: string
  must_change_password: boolean
  last_sign_in_at: string | null
  employee_id: string | null
  full_name: string | null
  role: string | null
  employee_status: string | null
  client_id: string | null
  tmc_id: string | null
  first_login_completed: boolean | null
  client_status: string | null
  tmc_status: string | null
  is_platform_admin: boolean
}

export interface SessionPrincipalRow extends AccountStanding {
  session_id: string
  last_seen_at: string
}

// The account, its employee record and the standing of that record's client
// and TMC. Shared by the two lookups below.
const STANDING = sql`
  a.id as account_id, a.email, a.must_change_password, a.last_sign_in_at,
  e.id as employee_id, e.full_name, e.role, e.status as employee_status,
  e.client_id, e.tmc_id, e.first_login_completed,
  c.status as client_status, t.status as tmc_status,
  exists (select 1 from platform_admins p where p.user_id = a.id) as is_platform_admin`

const STANDING_JOINS = sql`
  left join employees e on e.id = a.id
  left join clients c on c.id = e.client_id
  left join tmcs t on t.id = e.tmc_id`

export async function principalBySession(db: Queryable, sessionId: string): Promise<SessionPrincipalRow | null> {
  return maybeOne<SessionPrincipalRow>(db, sql`
    select s.id as session_id, s.last_seen_at, ${STANDING}
    from sessions s
    join accounts a on a.id = s.account_id
    ${STANDING_JOINS}
    where s.id = ${sessionId}
      and s.revoked_at is null
      and s.idle_expires_at > now()
      and s.absolute_expires_at > now()`)
}

// The same standing, before any session exists: sign-in and link completion
// refuse a deactivated person before creating one.
export async function standingByAccount(db: Queryable, accountId: string): Promise<AccountStanding | null> {
  return maybeOne<AccountStanding>(db, sql`
    select ${STANDING} from accounts a ${STANDING_JOINS} where a.id = ${accountId}`)
}

// Slides the idle expiry forward, never past the absolute one. Throttled by
// the WHERE clause, so a burst of requests writes at most one row update per
// interval rather than one per request.
export async function touchSession(
  db: Queryable,
  sessionId: string,
  idleSeconds: number,
  everySeconds: number
): Promise<void> {
  await exec(db, sql`
    update sessions set
      last_seen_at = now(),
      idle_expires_at = least(now() + make_interval(secs => ${idleSeconds}), absolute_expires_at)
    where id = ${sessionId}
      and revoked_at is null
      and last_seen_at < now() - make_interval(secs => ${everySeconds})`)
}

export async function revokeSession(db: Queryable, sessionId: string, reason: string): Promise<void> {
  await exec(db, sql`
    update sessions set revoked_at = now(), revoked_reason = ${reason}
    where id = ${sessionId} and revoked_at is null`)
}

// Every live session of an account, except (optionally) the one making the
// request. Returns how many were ended.
export async function revokeAllSessions(
  db: Queryable,
  accountId: string,
  reason: string,
  exceptSessionId: string | null = null
): Promise<number> {
  return exec(db, sql`
    update sessions set revoked_at = now(), revoked_reason = ${reason}
    where account_id = ${accountId}
      and revoked_at is null
      and (${exceptSessionId}::text is null or id <> ${exceptSessionId})`)
}

// ═══ auth_tokens ════════════════════════════════════════════════════════════

export type TokenPurpose = 'invite' | 'reset'

export async function insertToken(
  db: Queryable,
  t: { id: string; accountId: string; purpose: TokenPurpose; ttlSeconds: number; createdBy: string | null }
): Promise<void> {
  await exec(db, sql`
    insert into auth_tokens (id, account_id, purpose, expires_at, created_by)
    values (${t.id}, ${t.accountId}, ${t.purpose}, now() + make_interval(secs => ${t.ttlSeconds}), ${t.createdBy})`)
}

// Only the newest link works: issuing one retires every earlier open one.
export async function retireOpenTokens(db: Queryable, accountId: string): Promise<void> {
  await exec(db, sql`
    update auth_tokens set consumed_at = now()
    where account_id = ${accountId} and consumed_at is null`)
}

export interface OpenToken {
  account_id: string
  purpose: TokenPurpose
  email: string
}

// Reads a token without spending it: the confirm page shows whose account a
// link is for before anything is committed.
export async function openToken(db: Queryable, tokenId: string): Promise<OpenToken | null> {
  return maybeOne<OpenToken>(db, sql`
    select t.account_id, t.purpose, a.email
    from auth_tokens t join accounts a on a.id = t.account_id
    where t.id = ${tokenId} and t.consumed_at is null and t.expires_at > now()`)
}

// Spends a token. Atomic: of two concurrent requests with the same token,
// exactly one gets a row back.
export async function consumeToken(db: Queryable, tokenId: string): Promise<OpenToken | null> {
  return maybeOne<OpenToken>(db, sql`
    update auth_tokens t set consumed_at = now()
    from accounts a
    where a.id = t.account_id
      and t.id = ${tokenId} and t.consumed_at is null and t.expires_at > now()
    returning t.account_id, t.purpose, a.email`)
}

// ═══ auth_attempts ══════════════════════════════════════════════════════════

export async function recordAttempt(db: Queryable, key: string): Promise<void> {
  await exec(db, sql`insert into auth_attempts (key) values (${key})`)
}

export async function countAttempts(db: Queryable, keys: readonly string[], windowSeconds: number): Promise<Record<string, number>> {
  const rows = await many<{ key: string; n: number }>(db, sql`
    select key, count(*)::int as n from auth_attempts
    where key = any(${keys}) and at > now() - make_interval(secs => ${windowSeconds})
    group by key`)
  return Object.fromEntries(keys.map(k => [k, rows.find(r => r.key === k)?.n ?? 0]))
}

export async function clearAttempts(db: Queryable, key: string): Promise<void> {
  await exec(db, sql`delete from auth_attempts where key = ${key}`)
}

export async function pruneAttempts(db: Queryable, olderThanSeconds: number): Promise<void> {
  await exec(db, sql`delete from auth_attempts where at < now() - make_interval(secs => ${olderThanSeconds})`)
}
