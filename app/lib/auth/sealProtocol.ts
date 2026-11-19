// ── The sealed password: what the browser and the server agree on ────────────
// One-time ECDH P-256 keys on both sides; the shared secret goes through HKDF
// (SHA-256, the challenge id as salt) to an AES-256-GCM key; the email is the
// additional authenticated data, so a sealed password opens only for the
// address it was sealed with. Shared by app/lib/auth/sealClient.ts (browser)
// and app/lib/auth/sealed.ts (server) so the two cannot drift. No imports:
// it runs in both places on the platform's own Web Crypto.
// ─────────────────────────────────────────────────────────────────────────────

export const SEAL_VERSION = 1
const INFO = new TextEncoder().encode('cbt-signin-seal-v1')
export const CURVE = { name: 'ECDH', namedCurve: 'P-256' } as const

// What the browser sends instead of the password.
export interface SealedSecret {
  v: number
  challengeId: string
  clientKey: string   // the browser's one-off public key, raw, base64
  iv: string          // 12 bytes, base64
  data: string        // AES-GCM ciphertext with its tag, base64
}

// The server's answer to "a challenge, please".
export interface SealChallenge {
  challengeId: string
  serverKey: string   // the server's one-off public key, raw, base64
  expiresIn: number   // seconds
}

export function toBase64(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let s = ''
  for (const b of view) s += String.fromCharCode(b)
  return btoa(s)
}

export function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const s = atob(text)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

// The email as bound into the seal: as the server will compare it.
export function sealedAad(email: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(email.trim().toLowerCase())
}

// Both sides: our private key + their public key -> the same AES-GCM key.
export async function deriveSealKey(
  subtle: SubtleCrypto, ownPrivate: CryptoKey, theirPublic: CryptoKey, challengeId: string,
): Promise<CryptoKey> {
  const secret = await subtle.deriveBits({ name: 'ECDH', public: theirPublic }, ownPrivate, 256)
  const hkdfKey = await subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey'])
  return subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode(challengeId), info: INFO },
    hkdfKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  )
}
