import {
  CURVE, SEAL_VERSION, deriveSealKey, fromBase64, padFields, sealAad, toBase64,
  type Credentials, type SealChallenge, type SealFields, type SealPurpose, type SealedSecret,
} from './sealProtocol'

// ── Sealing passwords in the browser ─────────────────────────────────────────
// No password leaves a page as text: a form's secrets are padded to one fixed
// size and encrypted to a one-off key the server issued moments ago
// (POST /api/auth/signin/challenge, the one challenge endpoint for every
// form). A log of the request holds a blob of constant length that opens
// once, within two minutes, at that form only, and never again. See
// app/lib/auth/sealProtocol.ts.
//
// Web Crypto exists only on a secure origin (HTTPS, or localhost). Without
// it there is no sealing, and no falling back to plain text: the form says it
// needs a secure connection.
// ─────────────────────────────────────────────────────────────────────────────

const ACTION: Record<SealPurpose, string> = {
  signin: 'Sign-in',
  'set-password': 'Setting a password',
  'change-password': 'Changing your password',
  'starting-password': 'Setting a starting password',
}

export class SealUnavailable extends Error {
  constructor(purpose: SealPurpose = 'signin') {
    super(`${ACTION[purpose]} needs a secure connection. Open this site over HTTPS and try again.`)
    this.name = 'SealUnavailable'
  }
}

function subtleCrypto(purpose: SealPurpose): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) throw new SealUnavailable(purpose)
  return subtle
}

// Seals one form's fields to a challenge. Pure (no network): the page fetches
// the challenge, and tests pass one in.
export async function sealFields<P extends SealPurpose>(
  purpose: P, fields: SealFields<P>, challenge: SealChallenge,
): Promise<SealedSecret> {
  const subtle = subtleCrypto(purpose)
  const own = await subtle.generateKey(CURVE, true, ['deriveBits'])
  const server = await subtle.importKey('raw', fromBase64(challenge.serverKey), CURVE, false, [])
  const key = await deriveSealKey(subtle, own.privateKey, server, challenge.challengeId)
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12))
  const plain = padFields(fields)
  const data = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: sealAad(purpose, challenge.challengeId) }, key, plain)
  plain.fill(0)   // the padded copy does not linger in this array
  return {
    v: SEAL_VERSION,
    challengeId: challenge.challengeId,
    clientKey: toBase64(await subtle.exportKey('raw', own.publicKey)),
    iv: toBase64(iv),
    data: toBase64(data),
  }
}

export function sealCredentials(credentials: Credentials, challenge: SealChallenge): Promise<SealedSecret> {
  return sealFields('signin', credentials, challenge)
}

// A page's call: a fresh challenge, then the seal. Every submit gets its own
// (a challenge is spent by the attempt, successful or not).
export async function sealForm<P extends SealPurpose>(purpose: P, fields: SealFields<P>): Promise<SealedSecret> {
  subtleCrypto(purpose)
  const res = await fetch('/api/auth/signin/challenge', { method: 'POST' })
  const challenge = await res.json().catch(() => null) as (SealChallenge & { error?: string }) | null
  if (!res.ok || !challenge?.challengeId) {
    throw new Error(challenge?.error ?? (purpose === 'signin'
      ? 'Could not start a secure sign-in. Please try again.'
      : 'Could not secure your password before sending it. Please try again.'))
  }
  return sealFields(purpose, fields, challenge)
}

export function sealSignIn(credentials: Credentials): Promise<SealedSecret> {
  return sealForm('signin', credentials)
}
