import { describe, it, expect } from 'vitest'
import { composeSellPrice, emptyCommercials } from './composeSellPrice'
import type { FareComponents } from './fareComponents'
import type { ResolvedRule, ResolvableRule, ResolvedCommercials } from './resolveCommercials'

// ── composeSellPrice ─────────────────────────────────────────────────────────
// Turns an airline fare plus the rules in force into the number a corporate is
// invoiced. Every assertion here is a billing decision.
//
// THE ORDER IS THE POLICY: discount, then markup, then fee. Each step
// calculates against the OUTPUT of the last, which is what "markup on the
// discounted fare" means precisely rather than as a sentence in a spec.
//
// Two clamps that deliberately differ, and the difference is the point:
//   - a discount larger than the fare IS clamped -- a negative price is nonsense
//   - tmcMargin is NOT clamped -- a negative margin is a real commercial state
//     worth reporting, and hiding it behind zero would conceal a loss-making
//     arrangement at exactly the moment it matters
// ─────────────────────────────────────────────────────────────────────────────

function fare(overrides: Partial<FareComponents> = {}): FareComponents {
  return {
    base: 10000,
    otherTax: 1500,
    fuelSurcharge: 500,
    taxLines: [
      { code: 'YQ', amount: 500 },
      { code: 'K3', amount: 600 },
    ],
    total: 12000,
    ...overrides,
  }
}

let seq = 0
function resolvedRule(overrides: Partial<ResolvableRule> = {}, ambiguous = false): ResolvedRule {
  seq += 1
  const rule: ResolvableRule = {
    id: `rule-${seq}`,
    kind: 'markup',
    category_id: 'cat',
    airline_code: null,
    cabin: null,
    rbd_spec: null,
    fare_type: 'all',
    calc_type: 'percent',
    calc_on: 'bf',
    rate: 10,
    calc_basis: null,
    exclude_tax_codes: null,
    include_ssr: null,
    active: true,
    valid_from: null,
    valid_to: null,
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
  return { rule, kind: 'client', viaName: null, via: 'Direct assignment', beat: [], ambiguous }
}

function resolved(parts: Partial<ResolvedCommercials> = {}): ResolvedCommercials {
  return { markup: null, discount: null, processing_fee: null, trace: [], ...parts }
}

describe('composeSellPrice — no rules', () => {
  it('sells at exactly the airline fare', () => {
    const out = composeSellPrice({ components: fare(), resolved: resolved(), pax: 1, sectors: 1 })

    expect(out.displayedFare).toBe(12000)
    expect(out.sellTotal).toBe(12000)
    expect(out.tmcCost).toBe(12000)
    expect(out.tmcMargin).toBe(0)
    expect(out.adjustments).toEqual([])
  })

  it('copies the airline tax lines rather than sharing them', () => {
    const components = fare()
    const out = composeSellPrice({ components, resolved: resolved(), pax: 1, sectors: 1 })

    out.airline.taxLines[0].amount = 99999
    expect(components.taxLines[0].amount).toBe(500)
  })
})

describe('composeSellPrice — markup', () => {
  it('adds the markup to the fare and to the margin', () => {
    const markup = resolvedRule({ kind: 'markup', calc_on: 'bf', rate: 10 })
    const out = composeSellPrice({ components: fare(), resolved: resolved({ markup }), pax: 1, sectors: 1 })

    // 10% of base 10,000 = 1,000
    expect(out.displayedFare).toBe(13000)
    expect(out.sellTotal).toBe(13000)
    expect(out.tmcMargin).toBe(1000)
    expect(out.tmcCost).toBe(12000)
  })

  it('labels the markup EMBEDDED, never a line', () => {
    // This is the visibility that must never reach the browser. Enforced at the
    // serialisation boundary, but it has to be labelled correctly here first.
    const markup = resolvedRule({ kind: 'markup' })
    const out = composeSellPrice({ components: fare(), resolved: resolved({ markup }), pax: 1, sectors: 1 })

    expect(out.adjustments).toHaveLength(1)
    expect(out.adjustments[0].source).toBe('markup')
    expect(out.adjustments[0].visibility).toBe('embedded')
    expect(out.adjustments[0].sign).toBe(1)
  })

  it('supports a fixed markup as well as a percentage', () => {
    const markup = resolvedRule({ kind: 'markup', calc_type: 'fixed', rate: 750 })
    const out = composeSellPrice({ components: fare(), resolved: resolved({ markup }), pax: 1, sectors: 1 })

    expect(out.displayedFare).toBe(12750)
  })
})

describe('composeSellPrice — discount', () => {
  it('takes the discount off the total and shows it as a LINE', () => {
    const discount = resolvedRule({ kind: 'discount', calc_on: 'tf', rate: 10 })
    const out = composeSellPrice({ components: fare(), resolved: resolved({ discount }), pax: 1, sectors: 1 })

    // 10% of total 12,000 = 1,200
    expect(out.sellTotal).toBe(10800)
    expect(out.adjustments[0].visibility).toBe('line')
    expect(out.adjustments[0].sign).toBe(-1)
  })

  it('CLAMPS a discount larger than the fare', () => {
    // A negative price is nonsense.
    const discount = resolvedRule({ kind: 'discount', calc_type: 'fixed', rate: 99999 })
    const out = composeSellPrice({ components: fare(), resolved: resolved({ discount }), pax: 1, sectors: 1 })

    expect(out.adjustments[0].amount).toBe(12000)
    expect(out.sellTotal).toBe(0)
  })

  it('reports a NEGATIVE margin rather than clamping it', () => {
    // The airline does not fund a discount -- it comes out of our margin. A
    // loss-making arrangement must be visible, not hidden behind zero.
    const discount = resolvedRule({ kind: 'discount', calc_on: 'tf', rate: 10 })
    const markup = resolvedRule({ kind: 'markup', calc_on: 'bf', rate: 2 })
    const out = composeSellPrice({ components: fare(), resolved: resolved({ discount, markup }), pax: 1, sectors: 1 })

    expect(out.tmcMargin).toBeLessThan(0)
  })
})

describe('composeSellPrice — order of operations', () => {
  it('applies the discount BEFORE the markup, so markup calculates on the discounted fare', () => {
    const discount = resolvedRule({ kind: 'discount', calc_on: 'bf', rate: 50 })
    const markup = resolvedRule({ kind: 'markup', calc_on: 'bf', rate: 10 })
    const out = composeSellPrice({ components: fare(), resolved: resolved({ discount, markup }), pax: 1, sectors: 1 })

    // base 10,000 -> 50% discount = 5,000 off, leaving base 5,000
    // markup is 10% of the DISCOUNTED base = 500, not 1,000
    const markupAdj = out.adjustments.find(a => a.source === 'markup')!
    expect(markupAdj.amount).toBe(500)
  })

  it('orders the adjustments discount, markup, fee', () => {
    const discount = resolvedRule({ kind: 'discount', calc_on: 'tf', rate: 5 })
    const markup = resolvedRule({ kind: 'markup', calc_on: 'bf', rate: 5 })
    const processing_fee = resolvedRule({ kind: 'processing_fee', calc_type: 'fixed', rate: 200 })
    const out = composeSellPrice({
      components: fare(),
      resolved: resolved({ discount, markup, processing_fee }),
      pax: 1,
      sectors: 1,
    })

    expect(out.adjustments.map(a => a.source)).toEqual(['discount', 'markup', 'processing_fee'])
  })
})

describe('composeSellPrice — processing fee', () => {
  it('multiplies by passengers, always', () => {
    const processing_fee = resolvedRule({ kind: 'processing_fee', calc_type: 'fixed', rate: 200 })
    const out = composeSellPrice({ components: fare(), resolved: resolved({ processing_fee }), pax: 3, sectors: 2 })

    // Per transaction: 200 x 3 pax x 1 = 600. Sectors do NOT multiply.
    expect(out.adjustments[0].amount).toBe(600)
    expect(out.sellTotal).toBe(12600)
  })

  it('multiplies by sectors ONLY when charged per sector', () => {
    const processing_fee = resolvedRule({
      kind: 'processing_fee', calc_type: 'fixed', rate: 200, calc_basis: 'per_sector',
    })
    const out = composeSellPrice({ components: fare(), resolved: resolved({ processing_fee }), pax: 3, sectors: 2 })

    // 200 x 3 pax x 2 sectors = 1,200
    expect(out.adjustments[0].amount).toBe(1200)
  })

  it('guards pax and sectors at 1 so a missing count cannot zero the fee', () => {
    const processing_fee = resolvedRule({
      kind: 'processing_fee', calc_type: 'fixed', rate: 200, calc_basis: 'per_sector',
    })
    const out = composeSellPrice({ components: fare(), resolved: resolved({ processing_fee }), pax: 0, sectors: 0 })

    expect(out.adjustments[0].amount).toBe(200)
  })

  it('does NOT fold the fee into the fare', () => {
    // Otherwise a later adjustment would calculate a percentage of our own fee.
    const processing_fee = resolvedRule({ kind: 'processing_fee', calc_type: 'fixed', rate: 500 })
    const out = composeSellPrice({ components: fare(), resolved: resolved({ processing_fee }), pax: 1, sectors: 1 })

    // The fare itself is untouched; only the sell total carries the fee.
    expect(out.displayedFare).toBe(12000)
    expect(out.sellTotal).toBe(12500)
  })

  it('honours excluded tax codes in the basis', () => {
    const processing_fee = resolvedRule({
      kind: 'processing_fee', calc_on: 'tf', calc_type: 'percent', rate: 10,
      exclude_tax_codes: ['K3'],
    })
    const out = composeSellPrice({ components: fare(), resolved: resolved({ processing_fee }), pax: 1, sectors: 1 })

    // 10% of (12,000 - 600 K3) = 1,140
    expect(out.adjustments[0].amount).toBe(1140)
  })

  it('records the basis, pax and sector counts on the adjustment', () => {
    const processing_fee = resolvedRule({
      kind: 'processing_fee', calc_type: 'fixed', rate: 100, calc_basis: 'per_sector',
    })
    const out = composeSellPrice({ components: fare(), resolved: resolved({ processing_fee }), pax: 2, sectors: 3 })

    expect(out.adjustments[0].pax).toBe(2)
    expect(out.adjustments[0].sectors).toBe(3)
    expect(out.adjustments[0].calcBasis).toBe('per_sector')
  })
})

describe('composeSellPrice — the whole statement reconciles', () => {
  it('sellTotal equals displayedFare minus discount plus fee', () => {
    const discount = resolvedRule({ kind: 'discount', calc_on: 'tf', rate: 5 })
    const markup = resolvedRule({ kind: 'markup', calc_on: 'bf', rate: 8 })
    const processing_fee = resolvedRule({ kind: 'processing_fee', calc_type: 'fixed', rate: 250 })

    const out = composeSellPrice({
      components: fare(),
      resolved: resolved({ discount, markup, processing_fee }),
      pax: 2,
      sectors: 1,
    })

    const d = out.adjustments.find(a => a.source === 'discount')!.amount
    const f = out.adjustments.find(a => a.source === 'processing_fee')!.amount

    // The reconciliation the confirm page renders and asserts on screen.
    expect(out.sellTotal).toBeCloseTo(out.displayedFare - d + f, 2)
  })

  it('carries ambiguity through from any rule in force', () => {
    // Visible after the fact on the booking, not only at resolution time.
    const markup = resolvedRule({ kind: 'markup' }, true)
    const out = composeSellPrice({ components: fare(), resolved: resolved({ markup }), pax: 1, sectors: 1 })

    expect(out.ambiguous).toBe(true)
  })
})

describe('emptyCommercials', () => {
  it('describes an unmarked-up fare with no adjustments', () => {
    const out = emptyCommercials(fare())

    expect(out.adjustments).toEqual([])
    expect(out.displayedFare).toBe(12000)
    expect(out.sellTotal).toBe(12000)
    expect(out.tmcMargin).toBe(0)
    expect(out.ambiguous).toBe(false)
  })
})
