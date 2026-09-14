import type { CalcOn } from './calcOnByKind'

// ── Fare components ──────────────────────────────────────────────────────────
// The two operations every commercial rule performs on a fare: read a basis
// amount, and move the fare by an adjustment.
//
// PURE, no imports beyond a type. This is the file to unit-test first, because
// every rupee the product charges passes through one of these two functions.
//
// A WARNING ABOUT `otherTax`. It comes from Amadeus's Total.OtherTax, and
// Total.FuelSurcharge is a SIBLING field — so `base + otherTax` is NOT reliably
// `total`, and YQ may or may not already be counted inside otherTax. Nothing
// here derives one component from the others for that reason: every value is
// read as sent, and `taxLines` is the authority whenever a specific code
// matters.
// ─────────────────────────────────────────────────────────────────────────────

export interface TaxLine {
  code: string
  amount: number
}

export interface FareComponents {
  base: number
  // Total.OtherTax as sent. See the warning above — do not reconstruct it.
  otherTax: number
  // Total.FuelSurcharge as sent. Present separately from taxLines because the
  // provider reports it both ways and they do not always agree.
  fuelSurcharge: number
  // Per-code detail. Empty when the provider did not itemise, which is why
  // taxOfCode falls back rather than throwing.
  taxLines: TaxLine[]
  total: number
}

// Sum every tax line carrying one of these codes. Case-insensitive: codes come
// from a provider payload and have been seen in both cases.
function taxOfCodes(components: FareComponents, codes: string[]): number {
  const wanted = new Set(codes.map(c => c.toUpperCase()))
  return components.taxLines
    .filter(line => wanted.has(line.code.toUpperCase()))
    .reduce((sum, line) => sum + line.amount, 0)
}

// YQ specifically. Falls back to Total.FuelSurcharge when the response did not
// itemise taxes at all — the two describe the same charge, and having no YQ line
// is far more likely to mean "not itemised" than "no fuel surcharge".
function yq(components: FareComponents): number {
  const line = taxOfCodes(components, ['YQ'])
  if (line > 0) return line
  return components.fuelSurcharge
}

function yr(components: FareComponents): number {
  return taxOfCodes(components, ['YR'])
}

// ── basisAmount ──────────────────────────────────────────────────────────────
// What a rate is applied to.
//
// `excludeTaxCodes` is the processing fee's ExcludeTaxes field: certain taxes
// are commonly carved out of a service charge, most often the local GST-style
// ones. Subtracted AFTER the basis is computed rather than filtered into it, so
// the exclusion works the same way for every basis instead of only for the ones
// built out of tax lines.
// ─────────────────────────────────────────────────────────────────────────────

export function basisAmount(
  components: FareComponents,
  calcOn: CalcOn,
  excludeTaxCodes: string[] = []
): number {
  let amount: number

  switch (calcOn) {
    case 'bf':        amount = components.base; break
    case 'yq':        amount = yq(components); break
    case 'yr':        amount = yr(components); break
    case 'bf_yq':     amount = components.base + yq(components); break
    case 'bf_yq_yr':  amount = components.base + yq(components) + yr(components); break
    case 'tf':        amount = components.total; break
    case 'other_tax': amount = components.otherTax; break
    // Exhaustive over CalcOn today. A value added to the union without a branch
    // here resolves to the base fare rather than to NaN or zero — the smallest
    // wrong answer available, and the one least likely to produce a free ticket.
    default:          amount = components.base
  }

  if (excludeTaxCodes.length > 0) {
    amount -= taxOfCodes(components, excludeTaxCodes)
  }

  // A basis can go negative if somebody excludes more tax than the basis
  // contains. Clamped, because a negative basis turns a markup into a discount
  // silently.
  return Math.max(0, round2(amount))
}

// ── applyAdjustment ──────────────────────────────────────────────────────────
// Move the fare, and return the components the NEXT adjustment will calculate
// against.
//
// THE RULE, stated once so it is not re-decided per source: an adjustment always
// moves `total`, and additionally moves the named component when its CalcOn
// names exactly one (bf, yq, yr, other_tax). Composite bases (bf_yq, bf_yq_yr,
// tf) move `total` alone, because there is no single component to attribute the
// change to and splitting it proportionally would be inventing detail the
// provider never sent.
//
// This is what makes "discount, then markup on the result" mean something
// precise rather than being a sentence in a spec.
// ─────────────────────────────────────────────────────────────────────────────

export function applyAdjustment(
  components: FareComponents,
  calcOn: CalcOn,
  signedAmount: number
): FareComponents {
  const next: FareComponents = {
    ...components,
    taxLines: components.taxLines.map(l => ({ ...l })),
    total: round2(components.total + signedAmount),
  }

  switch (calcOn) {
    case 'bf':
      next.base = round2(next.base + signedAmount)
      break
    case 'other_tax':
      next.otherTax = round2(next.otherTax + signedAmount)
      break
    case 'yq':
      next.fuelSurcharge = round2(next.fuelSurcharge + signedAmount)
      adjustTaxLine(next, 'YQ', signedAmount)
      break
    case 'yr':
      adjustTaxLine(next, 'YR', signedAmount)
      break
    // bf_yq, bf_yq_yr, tf — total only, deliberately.
    default:
      break
  }

  return next
}

function adjustTaxLine(components: FareComponents, code: string, signedAmount: number): void {
  const line = components.taxLines.find(l => l.code.toUpperCase() === code)
  if (line) line.amount = round2(line.amount + signedAmount)
}

// ── rate application ─────────────────────────────────────────────────────────
// A percent of a basis, or a flat amount. Rounded ONCE, here, so a chain of
// adjustments never compounds rounding error — each step rounds its own result
// and nothing re-rounds a rounded number.
export function rateAmount(
  basis: number,
  calcType: 'percent' | 'fixed',
  rate: number
): number {
  return round2(calcType === 'percent' ? (basis * rate) / 100 : rate)
}

// Half-up to two decimals. Written out rather than using toFixed because
// toFixed rounds half-to-even on some values, and a billing figure that
// disagrees with the arithmetic a human does on paper is not worth the brevity.
export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100
}
