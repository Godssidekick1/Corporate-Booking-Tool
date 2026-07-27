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

export async function getCachedSession(): Promise<CachedSession | null> {
  const service = createServiceClient()
  const { data, error } = await service
    .from('amadeus_session')
    .select('session_id, expires_at')
    .eq('id', SESSION_ROW_ID)
    .maybeSingle()

  if (error || !data) return null

  return {
    sessionId: data.session_id,
    expiresAt: new Date(data.expires_at).getTime(),
  }
}

export async function setCachedSession(sessionId: string): Promise<void> {
  const service = createServiceClient()
  const expiresAt = new Date(Date.now() + TTL_MINUTES * 60 * 1000).toISOString()

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
  const service = createServiceClient()
  const { error } = await service
    .from('amadeus_session')
    .delete()
    .eq('id', SESSION_ROW_ID)

  if (error) {
    console.error('clearCachedSession failed:', error)
  }
}