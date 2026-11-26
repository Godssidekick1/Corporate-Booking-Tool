import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

// ── secretBox: a secret encrypted at rest, with a key kept outside the database ──
// For the flight provider's password (provider_credentials.password_sealed).
// AES-256-GCM: confidential and tamper-evident. The key is
// PROVIDER_CREDENTIALS_KEY, 32 random bytes in base64, set in the server
// environment and nowhere else, so a database dump or backup holds no usable
// password.
//
//   generate one:  node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
//
// Format: "v1.<key id>.<base64(iv 12 | ciphertext | tag 16)>". The key id (the
// first 8 hex characters of the key's SHA-256) tells a wrong or rotated key
// apart from a damaged value, so the message can say which it is. The purpose
// is bound in as associated data, so a value sealed for one use cannot be
// moved to another.
// ─────────────────────────────────────────────────────────────────────────────

export class SecretKeyMissing extends Error {
  constructor() {
    super('PROVIDER_CREDENTIALS_KEY is not set. Add it to the server environment (.env.local): ' +
      'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"')
    this.name = 'SecretKeyMissing'
  }
}

export class SecretUnreadable extends Error {
  constructor(public readonly reason: 'wrong_key' | 'damaged') {
    super(reason === 'wrong_key'
      ? 'The saved provider password was encrypted with a different PROVIDER_CREDENTIALS_KEY. Restore that key, or enter the password again in the platform console.'
      : 'The saved provider password could not be decrypted (damaged). Enter it again in the platform console.')
    this.name = 'SecretUnreadable'
  }
}

const VERSION = 'v1'

function key(raw = process.env.PROVIDER_CREDENTIALS_KEY): { bytes: Buffer; id: string } {
  const text = (raw ?? '').trim()
  if (!text) throw new SecretKeyMissing()
  const bytes = Buffer.from(text, 'base64')
  if (bytes.length !== 32) {
    throw new Error('PROVIDER_CREDENTIALS_KEY must be 32 random bytes in base64 (44 characters). Generate one with the command in app/lib/crypto/secretBox.ts.')
  }
  return { bytes, id: createHash('sha256').update(bytes).digest('hex').slice(0, 8) }
}

export function hasSecretKey(): boolean {
  try { key(); return true } catch { return false }
}

export function seal(plain: string, purpose: string, rawKey?: string): string {
  const k = key(rawKey)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', k.bytes, iv)
  cipher.setAAD(Buffer.from(purpose))
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return `${VERSION}.${k.id}.${Buffer.concat([iv, body, cipher.getAuthTag()]).toString('base64')}`
}

export function open(sealed: string, purpose: string, rawKey?: string): string {
  const k = key(rawKey)
  const [version, keyId, data] = sealed.split('.')
  if (version !== VERSION || !keyId || !data) throw new SecretUnreadable('damaged')
  if (keyId !== k.id) throw new SecretUnreadable('wrong_key')
  const raw = Buffer.from(data, 'base64')
  if (raw.length < 12 + 16) throw new SecretUnreadable('damaged')
  try {
    const decipher = createDecipheriv('aes-256-gcm', k.bytes, raw.subarray(0, 12))
    decipher.setAAD(Buffer.from(purpose))
    decipher.setAuthTag(raw.subarray(raw.length - 16))
    return Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]).toString('utf8')
  } catch {
    throw new SecretUnreadable('damaged')
  }
}
