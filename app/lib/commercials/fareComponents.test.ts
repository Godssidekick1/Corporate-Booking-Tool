import { describe, it, expect } from 'vitest'
import {
  basisAmount,
  applyAdjustment,
  rateAmount,
  round2,
  type FareComponents,
} from './fareComponents'

// ── fareComponents ───────────────────────────────────────────────────────────
// The module's own header says it is "the file to unit-test first, because
// every rupee the product charges passes through one of these two functions".
// These are those tests.
//
// The fare shape below is modelled on a real Amadeus response, including the
// trap the module warns about: Total.FuelSurcharge is a SIBLING of
// Total.OtherTax, so base + otherTax does NOT equal total.
//   base 12,358 + otherTax 2,246 = 14,604, but total is 15,702.
//   The missing 1,098 is the fuel surcharge.
// ─────────────────────────────────────────────────────────────────────────────

function fare(overrides: Partial<FareComponents> = {}): FareComponents {
  return {
    base: 12358,
    otherTax: 2246,
    fuelSurcharge: 1098,
    taxLines: [
      { code: 'YQ', amount: 1098 },
      { code: 'K3', amount: 746 },
      { code: 'IN', amount: 1500 },
    ],
    total: 15702,
    ...overrides,
  }
}

describe('basisAmount', () => {
  it('reads each single component', () => {
    expect(basisAmount(fare(), 'bf')).toBe(12358)
    expect(basisAmount(fare(), 'tf')).toBe(15702)
    expect(basisAmount(fare(), 'other_tax')).toBe(2246)
    expect(basisAmount(fare(), 'yq')).toBe(1098)
  })

  it('sums composite bases', () => {
    expect(basisAmount(fare(), 'bf_yq')).toBe(12358 + 1098)
  })

  it('treats a missing YR as zero rather than failing', () => {
    // No YR line in the fixture: absent, not an error.
    expect(basisAmount(fare(), 'yr')).toBe(0)
    expect(basisAmount(fare(), 'bf_yq_yr')).toBe(12358 + 1098 + 0)
  })

  it('falls back to fuelSurcharge when taxes were not itemised', () => {
    // No YQ line at all -- far more likely to mean "not itemised" than
    // "no fuel surcharge", so the sibling field is the answer.
    const notItemised = fare({ taxLines: [] })
    expect(basisAmount(notItemised, 'yq')).toBe(1098)
  })

  it('matches tax codes case-insensitively', () => {
    const lowercase = fare({ taxLines: [{ code: 'yq', amount: 900 }] })
    expect(basisAmount(lowercase, 'yq')).toBe(900)
  })

  it('subtracts excluded tax codes from any basis', () => {
    // The processing fee's ExcludeTaxes: local GST-style charges are commonly
    // carved out of a service charge.
    expect(basisAmount(fare(), 'tf', ['K3'])).toBe(15702 - 746)
    expect(basisAmount(fare(), 'tf', ['K3', 'IN'])).toBe(15702 - 746 - 1500)
  })

  it('clamps a negative basis to zero', () => {
    // Excluding more tax than the basis holds would otherwise turn a markup
    // into a discount silently.
    const small = fare({ base: 100, taxLines: [{ code: 'K3', amount: 500 }] })
    expect(basisAmount(small, 'bf', ['K3'])).toBe(0)
  })
})

describe('applyAdjustment', () => {
  it('always moves the total', () => {
    expect(applyAdjustment(fare(), 'bf', 500).total).toBe(16202)
    expect(applyAdjustment(fare(), 'tf', 500).total).toBe(16202)
    expect(applyAdjustment(fare(), 'bf_yq', 500).total).toBe(16202)
  })

  it('also moves the named component for a single-component basis', () => {
    expect(applyAdjustment(fare(), 'bf', 500).base).toBe(12858)
    expect(applyAdjustment(fare(), 'other_tax', 500).otherTax).toBe(2746)
  })

  it('moves the total ALONE for a composite basis', () => {
    // No single component to attribute the change to; splitting it
    // proportionally would invent detail the provider never sent.
    const after = applyAdjustment(fare(), 'bf_yq', 500)
    expect(after.base).toBe(12358)
    expect(after.otherTax).toBe(2246)
    expect(after.fuelSurcharge).toBe(1098)
    expect(after.total).toBe(16202)
  })

  it('moves both fuelSurcharge and the YQ line together', () => {
    const after = applyAdjustment(fare(), 'yq', 200)
    expect(after.fuelSurcharge).toBe(1298)
    expect(after.taxLines.find(l => l.code === 'YQ')?.amount).toBe(1298)
  })

  it('does not mutate the fare it was given', () => {
    // Adjustments chain -- discount, then markup on the result. If this
    // mutated, every earlier step would be rewritten by every later one.
    const original = fare()
    const snapshot = JSON.parse(JSON.stringify(original))
    applyAdjustment(original, 'yq', 999)
    expect(original).toEqual(snapshot)
  })

  it('handles a negative adjustment (a discount) the same way', () => {
    const after = applyAdjustment(fare(), 'bf', -1000)
    expect(after.base).toBe(11358)
    expect(after.total).toBe(14702)
  })

  it('chains, with each step calculating against the previous result', () => {
    // 10% discount on base, then 5% markup on the DISCOUNTED base.
    const start = fare()
    const discounted = applyAdjustment(start, 'bf', -rateAmount(basisAmount(start, 'bf'), 'percent', 10))
    expect(discounted.base).toBe(round2(12358 * 0.9))

    const markedUp = applyAdjustment(discounted, 'bf', rateAmount(basisAmount(discounted, 'bf'), 'percent', 5))
    expect(markedUp.base).toBe(round2(discounted.base * 1.05))
  })
})

describe('rateAmount', () => {
  it('computes a percentage of the basis', () => {
    expect(rateAmount(10000, 'percent', 5)).toBe(500)
    expect(rateAmount(12358, 'percent', 2.5)).toBe(308.95)
  })

  it('returns a fixed rate regardless of basis', () => {
    expect(rateAmount(10000, 'fixed', 1200)).toBe(1200)
    expect(rateAmount(1, 'fixed', 1200)).toBe(1200)
  })
})

describe('round2', () => {
  it('rounds half UP, the way a human does on paper', () => {
    // Deliberately not toFixed, which rounds half-to-even on some values.
    expect(round2(0.125)).toBe(0.13)
    expect(round2(2.675)).toBe(2.68)
    expect(round2(1.005)).toBe(1.01)
  })

  it('leaves already-rounded values alone', () => {
    expect(round2(15702)).toBe(15702)
    expect(round2(0.1 + 0.2)).toBe(0.3)
  })

  it('rounds negatives consistently', () => {
    expect(round2(-1.005)).toBe(-1)
    expect(round2(-2.344)).toBe(-2.34)
  })
})
