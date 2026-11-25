import { describe, it, expect } from 'vitest'
import { padFields, unpadFields, SEALED_BYTES, SEAL_PURPOSES, sealAad } from './sealProtocol'

// ── The fixed-size framing inside every seal ─────────────────────────────────

describe('padFields / unpadFields', () => {
  it('always exactly SEALED_BYTES, and back again, for every form', () => {
    const longest = 'ॐ'.repeat(256)   // the most a password may be, 3 bytes a character
    const cases = [
      ['signin', { email: 'a@b.co', password: 'x' }],
      ['signin', { email: `${'x'.repeat(240)}@example.test`, password: longest }],
      ['set-password', { token: 'A'.repeat(43), password: longest }],
      ['change-password', { current: longest, next: longest }],   // the largest form
      ['starting-password', { password: 'long-enough-1' }],
    ] as const
    for (const [purpose, fields] of cases) {
      const padded = padFields(fields)
      expect(padded).toHaveLength(SEALED_BYTES)
      expect(unpadFields(purpose, padded)).toEqual(fields)
    }
  })

  it('refuses anything padFields would not make', () => {
    const good = padFields({ email: 'a@b.co', password: 'secret' })
    const notZero = good.slice(); notZero[SEALED_BYTES - 1] = 7
    const badLength = good.slice(); badLength[0] = 0xff
    expect(unpadFields('signin', notZero)).toBeNull()
    expect(unpadFields('signin', badLength)).toBeNull()
    expect(unpadFields('signin', good.subarray(0, 100))).toBeNull()
    const notJson = new Uint8Array(SEALED_BYTES); notJson[1] = 3; notJson.set([1, 2, 3], 2)
    expect(unpadFields('signin', notJson)).toBeNull()
  })

  it('a form gets exactly its own fields: none missing, none extra, all text', () => {
    expect(unpadFields('change-password', padFields({ email: 'a@b.co', password: 'secret' }))).toBeNull()
    expect(unpadFields('signin', padFields({ email: 'a@b.co' }))).toBeNull()
    expect(unpadFields('starting-password', padFields({ password: 'x', extra: 'y' }))).toBeNull()
    const numeric = new TextEncoder().encode(JSON.stringify({ password: 5 }))
    const framed = new Uint8Array(SEALED_BYTES); framed[1] = numeric.length; framed.set(numeric, 2)
    expect(unpadFields('starting-password', framed)).toBeNull()
  })

  it('fields past every limit cannot be sealed', () => {
    expect(() => padFields({ current: 'ॐ'.repeat(400), next: 'ॐ'.repeat(400) })).toThrow(/too long/)
  })

  it('every form is bound into its seal, so no two share associated data', () => {
    const id = '00000000-0000-0000-0000-000000000000'
    const aads = Object.keys(SEAL_PURPOSES).map(p => new TextDecoder().decode(sealAad(p as keyof typeof SEAL_PURPOSES, id)))
    expect(new Set(aads).size).toBe(aads.length)
  })
})
