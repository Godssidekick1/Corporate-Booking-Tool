// ── The sealed sign-in: what the browser and the server agree on ─────────────
// One-time ECDH P-256 keys on both sides; the shared secret goes through HKDF
// (SHA-256, the challenge id as salt) to an AES-256-GCM key.
//
// Version 2 (2026-11-20), as tight as the design allows:
//   - BOTH the email and the password are sealed: the request shows nothing
//     readable (emails are personal data, and a proxy logging bodies would
//     otherwise collect them).
//   - they are padded to one fixed size before sealing, so every sign-in is
//     the same length and nothing about the password's length leaks;
//   - the challenge id and version are the AES-GCM associated data: a seal
//     opens only with its own challenge, unaltered.
// The server holds the other private key for two minutes and deletes it on
// use (app/lib/auth/sealed.ts), so a captured request opens once, never again.
//
// Shared by app/lib/auth/sealClient.ts (browser) and app/lib/auth/sealed.ts
// (server) so the two cannot drift. No imports: it runs in both places on the
// platform's own Web Crypto.
// ─────────────────────────────────────────────────────────────────────────────

export const SEAL_VERSION = 2
const INFO = new TextEncoder().encode('cbt-signin-seal-v2')
export const CURVE = { name: 'ECDH', namedCurve: 'P-256' } as const

// The padded size: room for the longest allowed email (254) and password
// (256 characters, up to 3 UTF-8 bytes each) with their framing.
export const SEALED_BYTES = 1280

// What the browser sends: this, and nothing else.
export interface SealedSecret {
  v: number
  challengeId: string
  clientKey: string   // the browser's one-off public key, raw, base64
  iv: string          // 12 bytes, base64
  data: string        // AES-GCM ciphertext with its tag, base64 (always SEALED_BYTES + 16)
}

// The server's answer to "a challenge, please".
export interface SealChallenge {
  challengeId: string
  serverKey: string   // the server's one-off public key, raw, base64
  expiresIn: number   // seconds
}

export interface Credentials {
  email: string
  password: string
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

// Bound into every seal: which challenge, which version.
export function sealAad(challengeId: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`v${SEAL_VERSION}:${challengeId}`)
}

// Credentials -> exactly SEALED_BYTES: a 2-byte length, the JSON, zeros.
// Throws when they cannot fit (only past the length limits sign-in enforces).
export function padCredentials(c: Credentials): Uint8Array<ArrayBuffer> {
  const json = new TextEncoder().encode(JSON.stringify({ e: c.email, p: c.password }))
  if (json.length > SEALED_BYTES - 2) throw new Error('The email or password is too long.')
  const out = new Uint8Array(SEALED_BYTES)
  out[0] = json.length >> 8
  out[1] = json.length & 0xff
  out.set(json, 2)
  return out
}

// The reverse; null for anything that is not exactly what padCredentials makes.
export function unpadCredentials(bytes: Uint8Array): Credentials | null {
  if (bytes.length !== SEALED_BYTES) return null
  const length = (bytes[0] << 8) | bytes[1]
  if (length < 2 || length > SEALED_BYTES - 2) return null
  for (let i = 2 + length; i < SEALED_BYTES; i++) if (bytes[i] !== 0) return null
  try {
    const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(2, 2 + length))) as { e?: unknown; p?: unknown }
    if (typeof parsed.e !== 'string' || typeof parsed.p !== 'string') return null
    return { email: parsed.e, password: parsed.p }
  } catch {
    return null
  }
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
