import { db } from '@/app/lib/db'
import * as rateLimits from '@/app/lib/repositories/rateLimits'

// ── Rate limits ──────────────────────────────────────────────────────────────
// For endpoints that are expensive or reachable without signing in: one
// counter per key per minute (rate_limits). The sign-in, reset and link limits
// are separate (app/lib/auth/throttle.ts) and stricter.
//
//   const limited = await rateLimited('search', user.id)
//   if (limited) return limited
//
// Not applied to every route on purpose: each check is a database write, and
// the ordinary screens are paged and cheap. Fails OPEN -- if the counter
// cannot be written, the request goes ahead, because refusing every search
// when the counter table has a problem would be an outage of our own making.
// ─────────────────────────────────────────────────────────────────────────────

export const PER_MINUTE = {
  // A paid Amadeus call each. A person searching does a handful a minute.
  search: 30,
  // The coverage reports. A read is two indexed queries on the stored report;
  // only the first read after a change rebuilds it. Sized for someone typing
  // in the search box (one request per pause), not for the rebuild.
  coverage: 120,
  // Whole-table imports and exports.
  csv: 10,
  // The public ticket / QR link, per IP: no sign-in in front of it.
  ticket: 60,
} as const

export type LimitName = keyof typeof PER_MINUTE

export async function rateLimited(name: LimitName, who: string | null): Promise<Response | null> {
  // No identity (an unknown IP): nothing to count against. Sharing one bucket
  // for everyone unidentified would let one client lock out the rest.
  if (!who) return null
  let n: number
  try {
    n = await rateLimits.hit(db, `${name}:${who}`)
    if (Math.random() < 0.01) await rateLimits.prune(db)
  } catch (err) {
    console.error('[rate-limit] could not count, allowing the request', err)
    return null
  }
  if (n <= PER_MINUTE[name]) return null
  const retryAfter = 60 - new Date().getSeconds()
  return Response.json(
    { error: 'Too many requests. Please wait a moment and try again.' },
    { status: 429, headers: { 'Retry-After': String(retryAfter) } }
  )
}
