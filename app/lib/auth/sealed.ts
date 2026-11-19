import type { Queryable } from '@/app/lib/db'
import * as accounts from '@/app/lib/repositories/accounts'
import { CURVE, SEAL_VERSION, deriveSealKey, fromBase64, sealedAad, toBase64, type SealChallenge } from './sealProtocol'

// ── Opening a sealed password on the server ──────────────────────────────────
// The sign-in request carries a sealed password, not the password
// (app/lib/auth/sealClient.ts). The server issued a one-off key pair for it
// moments earlier; opening uses that pair's private half once and marks it
// used, so a logged or captured request cannot be replayed, and a second
// attempt with the same challenge finds nothing. The opened password goes
// straight to signIn() and is never logged or stored.
// ─────────────────────────────────────────────────────────────────────────────

export const CHALLENGE_SECONDS = 120

const subtle = globalThis.crypto.subtle
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

export async function createChallenge(db: Queryable): Promise<SealChallenge> {
  const pair = await subtle.generateKey(CURVE, true, ['deriveBits'])
  const challengeId = await accounts.insertChallenge(db, await subtle.exportKey('jwk', pair.privateKey), CHALLENGE_SECONDS)
  // Expired challenges go as new ones arrive: no job to schedule.
  if (Math.random() < 0.05) await accounts.pruneChallenges(db)
  return { challengeId, serverKey: toBase64(await subtle.exportKey('raw', pair.publicKey)), expiresIn: CHALLENGE_SECONDS }
}

export type Opened =
  | { ok: true; secret: string }
  // expired: the challenge is unknown, used or past its two minutes;
  // invalid: malformed, tampered with, or sealed for another email.
  | { ok: false; reason: 'expired' | 'invalid' }

function wellFormed(v: unknown): v is { v: number; challengeId: string; clientKey: string; iv: string; data: string } {
  if (!v || typeof v !== 'object') return false
  const s = v as Record<string, unknown>
  return s.v === SEAL_VERSION
    && typeof s.challengeId === 'string' && UUID.test(s.challengeId)
    && typeof s.clientKey === 'string' && BASE64.test(s.clientKey) && s.clientKey.length <= 200
    && typeof s.iv === 'string' && BASE64.test(s.iv) && s.iv.length <= 32
    && typeof s.data === 'string' && BASE64.test(s.data) && s.data.length <= 2048
}

export async function openSealed(db: Queryable, sealed: unknown, email: string): Promise<Opened> {
  if (!wellFormed(sealed)) return { ok: false, reason: 'invalid' }
  // Taken before anything else: a failed open still spends the challenge.
  const jwk = await accounts.takeChallenge(db, sealed.challengeId)
  if (!jwk) return { ok: false, reason: 'expired' }
  try {
    const own = await subtle.importKey('jwk', jwk as JsonWebKey, CURVE, false, ['deriveBits'])
    const theirs = await subtle.importKey('raw', fromBase64(sealed.clientKey), CURVE, false, [])
    const key = await deriveSealKey(subtle, own, theirs, sealed.challengeId)
    const plain = await subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64(sealed.iv), additionalData: sealedAad(email) }, key, fromBase64(sealed.data),
    )
    return { ok: true, secret: new TextDecoder().decode(plain) }
  } catch {
    // A bad key, a wrong email or a changed byte: AES-GCM refuses all alike.
    return { ok: false, reason: 'invalid' }
  }
}
