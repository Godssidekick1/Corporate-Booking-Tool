import { db } from '@/app/lib/db'
import { sql, exec, maybeOne } from '@/app/lib/db/sql'
import * as accounts from '@/app/lib/repositories/accounts'
import { newToken } from '@/app/lib/auth/tokens'

// ── Who the test is signed in as ─────────────────────────────────────────────
// actAs(user) makes the next request arrive with a REAL session cookie for
// that user: tests/setup/auth.ts replaces next/headers' cookies() with one
// that opens a session row in cbt_test for the current user. So every route
// test runs the real session lookup (accounts.principalBySession), including
// its refusal of deactivated people, not a stand-in for it.
//
// A user the template has no account for gets one on the spot: most employees
// in the template never had a login, and tests act as them freely.
// ─────────────────────────────────────────────────────────────────────────────

export interface TestUser {
  id: string
  email?: string | null
}

let current: TestUser | null = null

export function actAs(user: TestUser | null): void {
  current = user
}

export function actingAs(): TestUser | null {
  return current
}

export function resetAuth(): void {
  current = null
}

async function ensureAccount(user: TestUser): Promise<void> {
  if (await maybeOne(db, sql`select 1 from accounts where id = ${user.id}`)) return
  const email = user.email?.trim().toLowerCase()
  const taken = email ? await maybeOne(db, sql`select 1 from accounts where email = ${email}`) : null
  await exec(db, sql`
    insert into accounts (id, email) values (${user.id}, ${email && !taken ? email : `${user.id}@example.test`})
    on conflict do nothing`)
}

// A fresh session for the current user, as the cookie value a browser would
// send. Null when signed out.
export async function sessionTokenForCurrentUser(): Promise<string | null> {
  if (!current) return null
  await ensureAccount(current)
  const { token, id } = newToken()
  await accounts.insertSession(db, {
    id,
    accountId: current.id,
    idleSeconds: 3600,
    absoluteSeconds: 3600,
    ip: '127.0.0.1',
    userAgent: 'vitest',
  })
  return token
}
