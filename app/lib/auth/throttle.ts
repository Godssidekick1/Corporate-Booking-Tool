import { db } from '@/app/lib/db'
import * as accounts from '@/app/lib/repositories/accounts'

// ── Throttling ───────────────────────────────────────────────────────────────
// Sliding 15-minute windows over auth_attempts, keyed by what is limited.
//
// PER EMAIL, not per account: an address with no account is limited exactly
// like one with an account, so the limit itself does not reveal which
// addresses exist. PER IP as well, so one source cannot walk a list of
// addresses. A successful sign-in clears its email's count.
// ─────────────────────────────────────────────────────────────────────────────

export const WINDOW_SECONDS = 15 * 60

export const LIMITS = {
  // Failed sign-ins.
  signinPerEmail: 5,
  signinPerIp: 30,
  // Reset emails requested.
  resetPerEmail: 3,
  resetPerIp: 10,
  // Invite/reset links presented, valid or not.
  linkPerIp: 30,
  // Wrong current password on a password change, per account.
  changePerAccount: 5,
} as const

// A null key is a limit that does not apply: an IP limit when the IP is
// unknown. Sharing one 'unknown' bucket instead would let 30 failures from
// anywhere lock out everyone.
export interface Limit {
  key: string | null
  limit: number
}

// True when any of the limits has been reached.
export async function limited(limits: readonly Limit[]): Promise<boolean> {
  const live = limits.filter((l): l is { key: string; limit: number } => l.key !== null)
  if (live.length === 0) return false
  const counts = await accounts.countAttempts(db, live.map(l => l.key), WINDOW_SECONDS)
  return live.some(l => counts[l.key] >= l.limit)
}

export async function note(...keys: (string | null)[]): Promise<void> {
  for (const key of keys) if (key !== null) await accounts.recordAttempt(db, key)
  // Pruning as it goes keeps the table at roughly a day of rows, with no
  // scheduled job to operate.
  if (Math.random() < 0.02) await accounts.pruneAttempts(db, 24 * 60 * 60)
}

export async function clear(key: string): Promise<void> {
  await accounts.clearAttempts(db, key)
}

export const keys = {
  signinEmail: (email: string) => `signin:email:${email}`,
  signinIp: (ip: string | null) => (ip ? `signin:ip:${ip}` : null),
  resetEmail: (email: string) => `reset:email:${email}`,
  resetIp: (ip: string | null) => (ip ? `reset:ip:${ip}` : null),
  linkIp: (ip: string | null) => (ip ? `link:ip:${ip}` : null),
  changeAccount: (id: string) => `change:account:${id}`,
}
