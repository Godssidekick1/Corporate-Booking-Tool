// ── Amadeus session store (Supabase-backed) ──────────────────────────────────
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

import { createServiceClient } from '@/utils/supabase/service'

const SESSION_ROW_ID = 1
const TTL_MINUTES = 25 // matches the estimate used elsewhere for this session's expiry window

export interface CachedSession {
  sessionId: string
  expiresAt: number // epoch ms, for cheap comparison against Date.now()
}

// ── L1: in-process memo in front of the Supabase row ─────────────────────────
// MEASURED: a Supabase round trip from here is ~200ms (min 183, median 205 over
// repeated reads). Every single Amadeus call pays it before the request even
// leaves, because getSessionId() reads the session row first — so a booking,
// which makes several provider calls, was spending the better part of a second
// asking the database for a string it had just been told.
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

export async function getCachedSession(): Promise<CachedSession | null> {
  // Checked against the clock, not merely for presence — an expired memo is a
  // stale session id, and handing one out would produce a "Session Expired"
  // from the provider and the retry that costs far more than the read saved.
  if (memo && Date.now() < memo.expiresAt) return memo

  const service = createServiceClient()
  const { data, error } = await service
    .from('amadeus_session')
    .select('session_id, expires_at')
    .eq('id', SESSION_ROW_ID)
    .maybeSingle()

  if (error || !data) return null

  memo = {
    sessionId: data.session_id,
    expiresAt: new Date(data.expires_at).getTime(),
  }
  return memo
}

export async function setCachedSession(sessionId: string): Promise<void> {
  const service = createServiceClient()
  const expiry = Date.now() + TTL_MINUTES * 60 * 1000
  const expiresAt = new Date(expiry).toISOString()

  // Populated before the write, not after: the write is best-effort (see below)
  // and a failed one must not leave this process re-authenticating on every
  // call when it holds a session it knows is good.
  memo = { sessionId, expiresAt: expiry }

  const { error } = await service
    .from('amadeus_session')
    .upsert({
      id: SESSION_ROW_ID,
      session_id: sessionId,
      expires_at: expiresAt,
      updated_at: new Date().toISOString(),
    })

  if (error) {
    // Don't throw here -- a failed cache write shouldn't take down a booking
    // flow that otherwise succeeded. Log and move on; the next call will
    // just re-authenticate, which is correct-but-slow, not broken.
    console.error('setCachedSession failed:', error)
  }
}

export async function clearCachedSession(): Promise<void> {
  // First, and unconditionally. This is called when the provider has told us the
  // session is dead; a memo that survived the delete would hand the same dead id
  // straight back to the retry that is about to run.
  memo = null

  const service = createServiceClient()
  const { error } = await service
    .from('amadeus_session')
    .delete()
    .eq('id', SESSION_ROW_ID)

  if (error) {
    console.error('clearCachedSession failed:', error)
  }
}