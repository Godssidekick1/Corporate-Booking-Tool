import { cookies } from 'next/headers'
import type { NextResponse } from 'next/server'
import { db, type Queryable } from '@/app/lib/db'
import * as accounts from '@/app/lib/repositories/accounts'
import { newToken, tokenId, isToken } from './tokens'

// ── Sessions ─────────────────────────────────────────────────────────────────
// Who is making this request, answered by ONE query per request
// (accounts.principalBySession): session -> account -> employee -> client and
// TMC standing -> platform admin.
//
// The cookie carries a random token and nothing else. It holds no role, no
// tenant and no flags, so there is nothing in it a user can edit to their
// advantage. The role, the must-change-password flag and the account's
// standing are read from the database every time. GoTrue's JWT carried
// user_metadata, which the user could rewrite on themselves (a self-granted
// tmc_admin role, a cleared must_set_password).
//
// A live session is REFUSED, and revoked on the spot, when its owner may no
// longer be here: employee deactivated, client deactivated, or TMC staff whose
// TMC is. So deactivation takes effect on the very next request, everywhere,
// with no route having to remember to check.
// ─────────────────────────────────────────────────────────────────────────────

// __Host- makes the browser refuse the cookie unless it is Secure, host-only
// and Path=/. Plain HTTP in development cannot meet that, so dev uses a plain
// name.
const SECURE = process.env.NODE_ENV === 'production'
export const SESSION_COOKIE = SECURE ? '__Host-cbt_session' : 'cbt_session'

// Idle: signed out after a day without a request. Absolute: after two weeks
// whatever happens, so a stolen cookie has a bounded life.
export const IDLE_SECONDS = 24 * 60 * 60
export const ABSOLUTE_SECONDS = 14 * 24 * 60 * 60
// How often a busy session writes its last_seen_at.
const TOUCH_EVERY_SECONDS = 5 * 60

export interface PrincipalEmployee {
  id: string
  fullName: string | null
  role: string | null
  status: string | null
  clientId: string | null
  tmcId: string | null
  firstLoginCompleted: boolean | null
}

export interface Principal {
  // The account id. It is also the employees.id and platform_admins.user_id of
  // the same person.
  id: string
  email: string
  sessionId: string
  mustChangePassword: boolean
  lastSignInAt: string | null
  // Null for a platform admin, who belongs to no tenant.
  employee: PrincipalEmployee | null
  isPlatformAdmin: boolean
}

// Thrown by requireUser(); route() answers it with 401.
export class Unauthenticated extends Error {
  constructor() {
    super('Not authenticated')
    this.name = 'Unauthenticated'
  }
}

export const TMC_ROLES: readonly string[] = ['tmc_admin', 'tc']

// Why a live session's owner may no longer be signed in, or null if they may.
export function refusal(row: accounts.AccountStanding): string | null {
  if (row.employee_status === 'deactivated') return 'employee_deactivated'
  if (row.client_id && row.client_status === 'inactive') return 'client_deactivated'
  if (row.role && TMC_ROLES.includes(row.role) && row.tmc_status === 'inactive') return 'tmc_deactivated'
  return null
}

export async function principalForToken(token: string | undefined | null): Promise<Principal | null> {
  if (!isToken(token)) return null
  const sessionId = tokenId(token)
  const row = await accounts.principalBySession(db, sessionId)
  if (!row) return null

  const refused = refusal(row)
  if (refused) {
    await accounts.revokeSession(db, sessionId, refused)
    return null
  }

  await accounts.touchSession(db, sessionId, IDLE_SECONDS, TOUCH_EVERY_SECONDS)

  return {
    id: row.account_id,
    email: row.email,
    sessionId,
    mustChangePassword: row.must_change_password,
    lastSignInAt: row.last_sign_in_at,
    employee: row.employee_id
      ? {
          id: row.employee_id,
          fullName: row.full_name,
          role: row.role,
          status: row.employee_status,
          clientId: row.client_id,
          tmcId: row.tmc_id,
          firstLoginCompleted: row.first_login_completed,
        }
      : null,
    isPlatformAdmin: row.is_platform_admin,
  }
}

// The caller of the current request, or null. For route handlers, server
// components and layouts. proxy.ts reads the cookie off the request itself.
export async function currentUser(): Promise<Principal | null> {
  const jar = await cookies()
  return principalForToken(jar.get(SESSION_COOKIE)?.value)
}

// For route handlers: the caller, or a 401 from route().
export async function requireUser(): Promise<Principal> {
  const me = await currentUser()
  if (!me) throw new Unauthenticated()
  return me
}

export interface RequestMeta {
  ip: string | null
  userAgent: string | null
}

// A new session for an account whose credentials have just been proven. The
// token is returned once, to go straight into the cookie.
export async function startSession(
  q: Queryable,
  accountId: string,
  meta: RequestMeta
): Promise<{ token: string; expires: Date }> {
  const { token, id } = newToken()
  const row = await accounts.insertSession(q, {
    id,
    accountId,
    idleSeconds: IDLE_SECONDS,
    absoluteSeconds: ABSOLUTE_SECONDS,
    ip: meta.ip,
    userAgent: meta.userAgent?.slice(0, 512) ?? null,
  })
  return { token, expires: new Date(row.absolute_expires_at) }
}

export function setSessionCookie(res: NextResponse, token: string, expires: Date): void {
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: SECURE,
    sameSite: 'lax',
    path: '/',
    expires,
  })
}

export function clearSessionCookie(res: NextResponse): void {
  res.cookies.set(SESSION_COOKIE, '', {
    httpOnly: true,
    secure: SECURE,
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  })
}
