// ── Amadeus session store (PostgreSQL-backed) ────────────────────────────────
// Replaces an in-memory module-level cache, which is unreliable on Vercel:
// serverless functions don't guarantee a persistent process, so a plain
// variable works by accident on a warm container and silently fails
// otherwise, with no coordination between concurrent containers.
//
// OPEN QUESTION, not yet resolved -- read before wiring this into client.ts:
// This is built as a SINGLETON (one row, shared by every request). That's
// only correct if Amadeus's SessionID is an account-level auth token tied to
// the shared ClientCode (ARR001), not a per-booking-flow correlator. We've
// only ever confirmed SessionID stays stable through ONE flow reusing its
// own value start-to-finish -- we have not confirmed whether two different
// employees' concurrent bookings are meant to share one SessionID or need
// independent ones. If it's the latter, caching one global value here would
// let concurrent bookings collide server-side. Verify before relying on this
// as a true account-wide cache; until then, treat this table as available
// infrastructure, not as confirmed-correct behavior.

import { db } from '@/app/lib/db'
import * as reference from '@/app/lib/repositories/reference'

const TTL_MINUTES = 25 // matches the estimate used elsewhere for this session's expiry window

export interface CachedSession {
  sessionId: string
  expiresAt: number // epoch ms, for cheap comparison against Date.now()
}

// ── L1: in-process memo in front of the row ──────────────────────────────────
// MEASURED: a database round trip from here was ~200ms (min 183, median 205
// over repeated reads). Every single Amadeus call pays it before the request
// even leaves, because getSessionId() reads the session row first — so a
// booking, which makes several provider calls, was spending the better part of
// a second asking the database for a string it had just been told.
//
// This does NOT replace the table, for exactly the reason the header gives: a
// module-level variable is unreliable ACROSS serverless invocations. It is a
// cache in front of it. A cold container misses and reads the row, which is the
// behaviour that made the table necessary; a warm one, which is the common case
// inside a single booking flow, skips the round trip entirely.
//
// Held to the same expiry as the row, and cleared by clearCachedSession(), so
// it cannot outlive the session it describes or survive a deliberate refresh.
let memo: CachedSession | null = null

// ── Best effort, deliberately ────────────────────────────────────────────────
// All three functions catch and log rather than throw. A session cache that
// cannot be read or written costs a re-authentication -- correct but slow --
// and must never take down a booking flow that could otherwise succeed. This
// is a considered exception to "repositories throw": the repository DOES throw,
// and this module decides a cache failure is not a booking failure.

export async function getCachedSession(): Promise<CachedSession | null> {
  // Checked against the clock, not merely for presence — an expired memo is a
  // stale session id, and handing one out would produce a "Session Expired"
  // from the provider and the retry that costs far more than the read saved.
  if (memo && Date.now() < memo.expiresAt) return memo

  try {
    // Expired rows are filtered by the query itself, for the same reason.
    const row = await reference.currentAmadeusSession(db)
    if (!row) return null

    memo = {
      sessionId: row.session_id,
      expiresAt: new Date(row.expires_at).getTime(),
    }
    return memo
  } catch (err) {
    console.error('getCachedSession failed; the caller will re-authenticate:', err)
    return null
  }
}

export async function setCachedSession(sessionId: string): Promise<void> {
  const expiry = Date.now() + TTL_MINUTES * 60 * 1000

  // Populated before the write, not after: the write is best-effort and a
  // failed one must not leave this process re-authenticating on every call when
  // it holds a session it knows is good.
  memo = { sessionId, expiresAt: expiry }

  try {
    await reference.saveAmadeusSession(db, sessionId, new Date(expiry).toISOString())
  } catch (err) {
    console.error('setCachedSession failed:', err)
  }
}

export async function clearCachedSession(): Promise<void> {
  // First, and unconditionally. This is called when the provider has told us the
  // session is dead; a memo that survived the delete would hand the same dead id
  // straight back to the retry that is about to run.
  memo = null

  try {
    await reference.deleteAmadeusSession(db)
  } catch (err) {
    console.error('clearCachedSession failed:', err)
  }
}
