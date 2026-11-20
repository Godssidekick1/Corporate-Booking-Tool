import {
  CURVE, SEAL_VERSION, deriveSealKey, fromBase64, padCredentials, sealAad, toBase64,
  type Credentials, type SealChallenge, type SealedSecret,
} from './sealProtocol'

// ── Sealing the sign-in in the browser ───────────────────────────────────────
// Neither the email nor the password leaves the page as text: both are padded
// to one fixed size and encrypted to a one-off key the server issued moments
// ago (POST /api/auth/signin/challenge). A log of the request holds a blob of
// constant length that opens once, within two minutes, and never again. See
// app/lib/auth/sealProtocol.ts.
//
// Web Crypto exists only on a secure origin (HTTPS, or localhost). Without
// it there is no sealing, and no falling back to plain text: the sign-in says
// it needs a secure connection.
// ─────────────────────────────────────────────────────────────────────────────

export class SealUnavailable extends Error {
  constructor() {
    super('Sign-in needs a secure connection. Open this site over HTTPS and try again.')
    this.name = 'SealUnavailable'
  }
}

function subtleCrypto(): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) throw new SealUnavailable()
  return subtle
}

// Seals credentials to a challenge. Pure (no network): the page fetches the
// challenge, and tests pass one in.
export async function sealCredentials(credentials: Credentials, challenge: SealChallenge): Promise<SealedSecret> {
  const subtle = subtleCrypto()
  const own = await subtle.generateKey(CURVE, true, ['deriveBits'])
  const server = await subtle.importKey('raw', fromBase64(challenge.serverKey), CURVE, false, [])
  const key = await deriveSealKey(subtle, own.privateKey, server, challenge.challengeId)
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12))
  const plain = padCredentials(credentials)
  const data = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: sealAad(challenge.challengeId) }, key, plain)
  plain.fill(0)   // the padded copy does not linger in this array
  return {
    v: SEAL_VERSION,
    challengeId: challenge.challengeId,
    clientKey: toBase64(await subtle.exportKey('raw', own.publicKey)),
    iv: toBase64(iv),
    data: toBase64(data),
  }
}

// The page's call: a fresh challenge, then the seal.
export async function sealSignIn(credentials: Credentials): Promise<SealedSecret> {
  subtleCrypto()
  const res = await fetch('/api/auth/signin/challenge', { method: 'POST' })
  const challenge = await res.json().catch(() => null) as (SealChallenge & { error?: string }) | null
  if (!res.ok || !challenge?.challengeId) throw new Error(challenge?.error ?? 'Could not start a secure sign-in. Please try again.')
  return sealCredentials(credentials, challenge)
}
