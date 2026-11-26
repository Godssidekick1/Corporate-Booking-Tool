import { describe, it, expect } from 'vitest'
import { randomBytes } from 'node:crypto'
import { open, seal, SecretKeyMissing, SecretUnreadable } from './secretBox'

const K1 = randomBytes(32).toString('base64')
const K2 = randomBytes(32).toString('base64')
const P = 'provider_credentials:password'

describe('secretBox (AES-256-GCM, key outside the database)', () => {
  it('seals and opens; never contains the plain text; differs every time', () => {
    const a = seal('s3cret-Pässword', P, K1)
    const b = seal('s3cret-Pässword', P, K1)
    expect(a).not.toContain('s3cret')
    expect(a).not.toBe(b)                       // a fresh IV each time
    expect(open(a, P, K1)).toBe('s3cret-Pässword')
  })

  it('a different key is reported as the wrong key, not as damage', () => {
    const sealed = seal('x', P, K1)
    expect(() => open(sealed, P, K2)).toThrow(SecretUnreadable)
    try { open(sealed, P, K2) } catch (e) { expect((e as SecretUnreadable).reason).toBe('wrong_key') }
  })

  it('a changed byte, another purpose, or a malformed value is refused', () => {
    const sealed = seal('x', P, K1)
    const [v, id, data] = sealed.split('.')
    const bytes = Buffer.from(data, 'base64'); bytes[14] ^= 1
    for (const bad of [`${v}.${id}.${bytes.toString('base64')}`, 'v1.abc', 'nonsense', `v2.${id}.${data}`]) {
      expect(() => open(bad, P, K1)).toThrow(SecretUnreadable)
    }
    expect(() => open(sealed, 'another:purpose', K1)).toThrow(SecretUnreadable)
  })

  it('no key, or a key of the wrong size, says so plainly', () => {
    expect(() => seal('x', P, '')).toThrow(SecretKeyMissing)
    expect(() => seal('x', P, Buffer.from('short').toString('base64'))).toThrow(/32 random bytes/)
  })
})
