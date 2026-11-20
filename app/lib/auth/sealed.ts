import type { Queryable } from '@/app/lib/db'
import * as accounts from '@/app/lib/repositories/accounts'
import {
  CURVE, SEALED_BYTES, SEAL_VERSION, deriveSealKey, fromBase64, sealAad, toBase64, unpadCredentials,
  type Credentials, type SealChallenge,
} from './sealProtocol'

// ── Opening a sealed sign-in on the server ───────────────────────────────────
// The sign-in request carries one sealed blob: the email and password, padded
// to a fixed size and encrypted to a one-off key pair the server issued
// moments earlier (app/lib/auth/sealClient.ts). Opening takes that pair's
// private half out of the database by deleting its row, in one statement: a
// captured request cannot be replayed, two requests cannot both open it, and
// no key is left behind for a later leak to open old captures with. The
// opened credentials go straight to signIn() and are never logged or stored.
// ─────────────────────────────────────────────────────────────────────────────

export const CHALLENGE_SECONDS = 120

const subtle = globalThis.crypto.subtle
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/
// The ciphertext is always the padded size plus the 16-byte tag.
const DATA_BASE64_LENGTH = Math.ceil((SEALED_BYTES + 16) / 3) * 4

export async function createChallenge(db: Queryable): Promise<SealChallenge> {
  // Expired keys go before a new one is made: none lingers past its two minutes.
  await accounts.pruneChallenges(db)
  const pair = await subtle.generateKey(CURVE, true, ['deriveBits'])
  const challengeId = await accounts.insertChallenge(db, await subtle.exportKey('jwk', pair.privateKey), CHALLENGE_SECONDS)
  return { challengeId, serverKey: toBase64(await subtle.exportKey('raw', pair.publicKey)), expiresIn: CHALLENGE_SECONDS }
}

export type Opened =
  | { ok: true; credentials: Credentials }
  // expired: the challenge is unknown, already used, or past its two minutes;
  // invalid: malformed, the wrong size, or tampered with.
  | { ok: false; reason: 'expired' | 'invalid' }

function wellFormed(v: unknown): v is { v: number; challengeId: string; clientKey: string; iv: string; data: string } {
  if (!v || typeof v !== 'object') return false
  const s = v as Record<string, unknown>
  return s.v === SEAL_VERSION
    && typeof s.challengeId === 'string' && UUID.test(s.challengeId)
    && typeof s.clientKey === 'string' && BASE64.test(s.clientKey) && s.clientKey.length <= 100
    && typeof s.iv === 'string' && BASE64.test(s.iv) && s.iv.length === 16
    && typeof s.data === 'string' && BASE64.test(s.data) && s.data.length === DATA_BASE64_LENGTH
}

export async function openSealed(db: Queryable, sealed: unknown): Promise<Opened> {
  if (!wellFormed(sealed)) return { ok: false, reason: 'invalid' }
  // Taken (deleted) before anything else: a failed open still spends it.
  const jwk = await accounts.takeChallenge(db, sealed.challengeId)
  if (!jwk) return { ok: false, reason: 'expired' }
  try {
    const own = await subtle.importKey('jwk', jwk as JsonWebKey, CURVE, false, ['deriveBits'])
    const theirs = await subtle.importKey('raw', fromBase64(sealed.clientKey), CURVE, false, [])
    const key = await deriveSealKey(subtle, own, theirs, sealed.challengeId)
    const plain = new Uint8Array(await subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64(sealed.iv), additionalData: sealAad(sealed.challengeId) }, key, fromBase64(sealed.data),
    ))
    const credentials = unpadCredentials(plain)
    plain.fill(0)
    return credentials ? { ok: true, credentials } : { ok: false, reason: 'invalid' }
  } catch {
    // A bad key, another challenge's seal or a changed byte: AES-GCM refuses all alike.
    return { ok: false, reason: 'invalid' }
  }
}
