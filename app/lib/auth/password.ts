import { hash, verify } from '@node-rs/argon2'
import { COMMON_PASSWORDS } from './commonPasswords'

// ── Passwords ────────────────────────────────────────────────────────────────
// argon2id, at OWASP's recommended minimum (19 MiB, 2 passes, 1 lane). About
// 30 ms per hash here. That is the point: it makes a stolen hash expensive to
// guess at, and it is invisible at sign-in. A stored hash in any other scheme
// never matches.
// ─────────────────────────────────────────────────────────────────────────────

// algorithm 2 is Algorithm.Argon2id. The package exports it as a const enum,
// which isolatedModules cannot read.
const ARGON2 = { algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const

export const MIN_PASSWORD_LENGTH = 8
// Hashing is deliberately slow, so an unbounded input is a way to make the
// server do unbounded work. Far beyond any passphrase anyone types.
export const MAX_PASSWORD_LENGTH = 256

export async function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2)
}

export async function verifyPassword(stored: string, password: string): Promise<boolean> {
  if (password.length > MAX_PASSWORD_LENGTH) return false
  if (!stored.startsWith('$argon2')) return false
  try {
    return await verify(stored, password)
  } catch {
    // A malformed hash is a wrong password, not a server error.
    return false
  }
}

// For a sign-in with an email that has no account (or no password): do the
// same work a real check would, so response time does not reveal which
// addresses have accounts.
let decoy: Promise<string> | null = null
export async function burnVerifyTime(password: string): Promise<void> {
  decoy ??= hashPassword('decoy password, never matches')
  await verifyPassword(await decoy, password.slice(0, MAX_PASSWORD_LENGTH))
}

// Why a proposed password is refused, or null if it is acceptable. Length, not
// composition rules: forced symbols produce "Password1!", and a blocklist of
// the passwords people actually pick does more (NIST SP 800-63B).
export function passwordProblem(password: string, email?: string | null): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return `Password must be at most ${MAX_PASSWORD_LENGTH} characters.`
  }
  const lower = password.toLowerCase()
  if (COMMON_PASSWORDS.has(lower)) {
    return 'That password is too common. Choose something harder to guess.'
  }
  const address = email?.toLowerCase()
  if (address && (lower === address || lower === address.split('@')[0])) {
    return 'Your password must not be your email address.'
  }
  return null
}
