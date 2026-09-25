import { randomBytes, createHash } from 'node:crypto'

// ── Opaque tokens ────────────────────────────────────────────────────────────
// Session cookies and the tokens in invite/reset links: 256 random bits,
// base64url (43 characters). The database stores only the SHA-256, as the row
// id. A plain hash is enough here, unlike a password: the input is random, not
// guessable, so there is nothing for a slow hash to protect against.
// ─────────────────────────────────────────────────────────────────────────────

const TOKEN = /^[A-Za-z0-9_-]{43}$/

export function newToken(): { token: string; id: string } {
  const token = randomBytes(32).toString('base64url')
  return { token, id: tokenId(token) }
}

export function tokenId(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

// Cheap shape check, so a garbage cookie or link never costs a query.
export function isToken(value: unknown): value is string {
  return typeof value === 'string' && TOKEN.test(value)
}
