import { describe, it, expect } from 'vitest'
import { padCredentials, unpadCredentials, SEALED_BYTES } from './sealProtocol'

// ── The fixed-size framing inside every seal ─────────────────────────────────

describe('padCredentials / unpadCredentials', () => {
  it('always exactly SEALED_BYTES, and back again', () => {
    for (const c of [
      { email: 'a@b.co', password: 'x' },
      { email: 'ravi.kumar@example.test', password: 'correct horse battery' },
      { email: `${'x'.repeat(240)}@example.test`, password: 'ॐ'.repeat(256) },
    ]) {
      const padded = padCredentials(c)
      expect(padded).toHaveLength(SEALED_BYTES)
      expect(unpadCredentials(padded)).toEqual(c)
    }
  })

  it('refuses anything padCredentials would not make', () => {
    const good = padCredentials({ email: 'a@b.co', password: 'secret' })
    const notZero = good.slice(); notZero[SEALED_BYTES - 1] = 7
    const badLength = good.slice(); badLength[0] = 0xff
    expect(unpadCredentials(notZero)).toBeNull()
    expect(unpadCredentials(badLength)).toBeNull()
    expect(unpadCredentials(good.subarray(0, 100))).toBeNull()
    const notJson = new Uint8Array(SEALED_BYTES); notJson[1] = 3; notJson.set([1, 2, 3], 2)
    expect(unpadCredentials(notJson)).toBeNull()
  })

  it('credentials past every limit cannot be sealed', () => {
    expect(() => padCredentials({ email: 'a@b.co', password: 'ॐ'.repeat(500) })).toThrow(/too long/)
  })
})
