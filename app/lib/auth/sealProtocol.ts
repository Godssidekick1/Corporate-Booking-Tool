// ── Sealed passwords: what the browser and the server agree on ───────────────
// One-time ECDH P-256 keys on both sides; the shared secret goes through HKDF
// (SHA-256, the challenge id as salt) to an AES-256-GCM key.
//
// Every form that carries a password sends it sealed, never as text (user,
// 2026-11-19..25; PCI DSS 8.3.2): sign-in, setting a password from an invite
// or reset link, changing a password, and an admin's starting password.
//
// Version 3 (2026-11-25):
//   - each form's secrets are sealed together (sign-in: the email too; a link:
//     its token too, since a token whose new password was refused is still
//     usable, and a logged body must not hand it to whoever reads the log);
//   - they are padded to one fixed size before sealing, so every seal is the
//     same length and nothing about a password's length leaks;
//   - the version, the PURPOSE and the challenge id are the AES-GCM associated
//     data: a seal opens only at the form it was made for, with its own
//     challenge, unaltered. The purpose is never sent; the server takes it
//     from the route, so a sign-in seal presented to "change password" fails.
// The server holds the other private key for two minutes and deletes it on
// use (app/lib/auth/sealed.ts), so a captured request opens once, never again.
//
// Shared by app/lib/auth/sealClient.ts (browser) and app/lib/auth/sealed.ts
// (server) so the two cannot drift. No imports: it runs in both places on the
// platform's own Web Crypto.
// ─────────────────────────────────────────────────────────────────────────────

export const SEAL_VERSION = 3
const INFO = new TextEncoder().encode('cbt-seal-v3')
export const CURVE = { name: 'ECDH', namedCurve: 'P-256' } as const

// Each form, and the fields sealed in it.
export const SEAL_PURPOSES = {
  signin: ['email', 'password'],
  'set-password': ['token', 'password'],
  'change-password': ['current', 'next'],
  'starting-password': ['password'],
} as const
export type SealPurpose = keyof typeof SEAL_PURPOSES
export type SealFields<P extends SealPurpose> = Record<(typeof SEAL_PURPOSES)[P][number], string>
export type Credentials = SealFields<'signin'>

// The padded size, one for every form: room for the largest, two passwords of
// 256 characters (the most passwordProblem allows) at up to 3 UTF-8 bytes
// each, with their framing.
export const SEALED_BYTES = 2048

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

// Bound into every seal: which version, which form, which challenge.
export function sealAad(purpose: SealPurpose, challengeId: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`v${SEAL_VERSION}:${purpose}:${challengeId}`)
}

// A form's fields -> exactly SEALED_BYTES: a 2-byte length, the JSON, zeros.
// Throws when they cannot fit (only past the length limits the forms enforce).
export function padFields(fields: Record<string, string>): Uint8Array<ArrayBuffer> {
  const json = new TextEncoder().encode(JSON.stringify(fields))
  if (json.length > SEALED_BYTES - 2) throw new Error('The details entered are too long.')
  const out = new Uint8Array(SEALED_BYTES)
  out[0] = json.length >> 8
  out[1] = json.length & 0xff
  out.set(json, 2)
  return out
}

// The reverse, for one form: null for anything that is not exactly what
// padFields makes from that form's fields (none missing, none extra, every
// one a string).
export function unpadFields<P extends SealPurpose>(purpose: P, bytes: Uint8Array): SealFields<P> | null {
  if (bytes.length !== SEALED_BYTES) return null
  const length = (bytes[0] << 8) | bytes[1]
  if (length < 2 || length > SEALED_BYTES - 2) return null
  for (let i = 2 + length; i < SEALED_BYTES; i++) if (bytes[i] !== 0) return null
  try {
    const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(2, 2 + length))) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const record = parsed as Record<string, unknown>
    const keys: readonly string[] = SEAL_PURPOSES[purpose]
    if (Object.keys(record).length !== keys.length) return null
    if (!keys.every(k => typeof record[k] === 'string')) return null
    return record as SealFields<P>
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
