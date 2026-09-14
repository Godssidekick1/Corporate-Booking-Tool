import { applyAdjustment, basisAmount, rateAmount, round2, type FareComponents, type TaxLine } from './fareComponents'
import type { ResolvedCommercials, ResolvedRule } from './resolveCommercials'
import type { Adjustment } from './adjustment'

// ── composeSellPrice ─────────────────────────────────────────────────────────
// THE PIPELINE. One ordered pass over a running set of fare components, turning
// what the airline quoted into what the corporate is invoiced.
//
// PURE. No database, no clock, no provider. This is the function to unit-test
// before any screen exists, because every rupee the product charges comes out
// of it.
//
//   1  DISCOUNT        visible line, reduces        ── passed to the client
//   2  MARKUP          EMBEDDED in the fare, adds   ── never itemised, never sent
//   3  PROCESSING FEE  visible line, adds           ── x passengers, x sectors
//   4  DEAL CODE       zero today (declared slot)
//   5  FOP             zero today (declared slot)
//
// WHY MARKUP IS CALCULATED ON THE DISCOUNTED AMOUNT. Because the discount is
// shown to the traveller and taken off their total, it is a client benefit
// rather than TMC margin — so marking up the reduced figure is what the stated
// order means and is internally consistent. (Had the discount been margin-only,
// markup would have had to be calculated on the gross fare, or a bigger airline
// discount would silently shrink the markup.)
//
// WHAT THE TRAVELLER SEES, and the test that this hangs together:
//
//     Fare              18,738     <- airlineTotal 18,450 + markup 288
//     Discount           -  760
//     Processing fee     + 1,500
//     ------------------------------
//     Total             19,478
//
// Their arithmetic adds up and the markup never appears as a line.
//
// MARGIN CAN BE NEGATIVE, and is reported that way. We cannot transmit a deal
// code to the aggregator, so the airline does not fund the discount — it comes
// out of the TMC's own margin. A rule granting more discount than markup
// produces a loss-making booking. Computed faithfully and surfaced rather than
// clamped at zero: clamping hides a pricing mistake behind a plausible number,
// which is the worst available outcome this close to money.
// ─────────────────────────────────────────────────────────────────────────────

export interface SellPriceInput {
  components: FareComponents
  resolved: ResolvedCommercials
  // Passengers ALWAYS multiply a processing fee — it is charged per ticket and
  // every passenger gets one. Sectors multiply only when calc_basis says so.
  pax: number
  sectors: number
}

export interface CommercialsRecord {
  airline: {
    total: number
    base: number
    otherTax: number
    fuelSurcharge: number
    taxLines: TaxLine[]
  }
  // ORDERED, and an array rather than named keys precisely so deal codes and
  // forms of payment slot in later without a shape change.
  adjustments: Adjustment[]
  // airlineTotal + markup. The number presented as "the fare".
  displayedFare: number
  // What the corporate is invoiced.
  sellTotal: number
  // What we owe the airline.
  tmcCost: number
  // markup + fee - discount. May be negative; see the header.
  tmcMargin: number
  // True when any rule in force could not be told apart from another. Carried
  // onto the booking so it is visible after the fact, not only at resolution.
  ambiguous: boolean
}

function toAdjustment(
  resolved: ResolvedRule,
  source: Adjustment['source'],
  visibility: Adjustment['visibility'],
  sign: -1 | 1,
  amount: number,
  extra: Partial<Adjustment> = {}
): Adjustment {
  return {
    source,
    visibility,
    sign,
    amount,
    ruleId: resolved.rule.id,
    via: resolved.via,
    calcType: resolved.rule.calc_type,
    calcOn: resolved.rule.calc_on,
    rate: resolved.rule.rate,
    ...extra,
  }
}

export function composeSellPrice(input: SellPriceInput): CommercialsRecord {
  const { components, resolved, pax, sectors } = input

  const airline = {
    total: round2(components.total),
    base: round2(components.base),
    otherTax: round2(components.otherTax),
    fuelSurcharge: round2(components.fuelSurcharge),
    taxLines: components.taxLines.map(l => ({ ...l })),
  }

  const adjustments: Adjustment[] = []
  // The running set. Each step calculates against the output of the last, which
  // is what "discount, then markup" means precisely rather than as a sentence.
  let running = components

  let discountAmount = 0
  let markupAmount = 0
  let feeAmount = 0

  // ── 1. Discount ────────────────────────────────────────────────────────────
  if (resolved.discount) {
    const rule = resolved.discount.rule
    const basis = basisAmount(running, rule.calc_on)
    discountAmount = rateAmount(basis, rule.calc_type, rule.rate)

    // A discount larger than the fare would invert the booking. Clamped here,
    // unlike margin: a negative PRICE is nonsense, a negative MARGIN is a real
    // commercial state worth reporting.
    discountAmount = Math.min(discountAmount, running.total)

    adjustments.push(toAdjustment(resolved.discount, 'discount', 'line', -1, discountAmount))
    running = applyAdjustment(running, rule.calc_on, -discountAmount)
  }

  // ── 2. Markup ──────────────────────────────────────────────────────────────
  // 'embedded' is the visibility that must never reach the browser. Enforced at
  // the serialisation boundary by visibleLines(), not here — this function's job
  // is to compute the number correctly and label it honestly.
  if (resolved.markup) {
    const rule = resolved.markup.rule
    const basis = basisAmount(running, rule.calc_on)
    markupAmount = rateAmount(basis, rule.calc_type, rule.rate)

    adjustments.push(toAdjustment(resolved.markup, 'markup', 'embedded', 1, markupAmount))
    running = applyAdjustment(running, rule.calc_on, markupAmount)
  }

  // ── 3. Processing fee ──────────────────────────────────────────────────────
  if (resolved.processing_fee) {
    const rule = resolved.processing_fee.rule
    const basis = basisAmount(running, rule.calc_on, rule.exclude_tax_codes ?? [])
    const perUnit = rateAmount(basis, rule.calc_type, rule.rate)

    // Passengers always. Sectors only when charged per sector. Guarded at 1 so a
    // missing count cannot zero the fee — a booking always has at least one
    // passenger and one sector.
    const paxCount = Math.max(1, pax)
    const sectorCount = rule.calc_basis === 'per_sector' ? Math.max(1, sectors) : 1
    feeAmount = round2(perUnit * paxCount * sectorCount)

    adjustments.push(
      toAdjustment(resolved.processing_fee, 'processing_fee', 'line', 1, feeAmount, {
        calcBasis: rule.calc_basis ?? undefined,
        pax: paxCount,
        sectors: sectorCount,
      })
    )
    // Deliberately does NOT call applyAdjustment: the fee is not part of the
    // fare. It is a service charge added alongside it, and folding it back into
    // the components would let a later adjustment calculate a percentage of our
    // own fee.
  }

  // ── 4 and 5. Deal code and form of payment ─────────────────────────────────
  // No adjustment is pushed. Deal codes are advisory — the aggregator has no
  // field to carry a tour code, so a resolved deal code is recorded for manual
  // GDS entry and moves nothing. Forms of payment wait on a payment gateway.
  // Both are already frozen onto the booking by their own stamps; when either
  // starts moving money it pushes an Adjustment here and nothing downstream
  // changes.

  const displayedFare = round2(airline.total + markupAmount)
  const sellTotal = round2(displayedFare - discountAmount + feeAmount)

  return {
    airline,
    adjustments,
    displayedFare,
    sellTotal,
    tmcCost: airline.total,
    tmcMargin: round2(markupAmount + feeAmount - discountAmount),
    ambiguous: Boolean(
      resolved.markup?.ambiguous ||
      resolved.discount?.ambiguous ||
      resolved.processing_fee?.ambiguous
    ),
  }
}

// ── emptyCommercials ─────────────────────────────────────────────────────────
// What a booking gets when no rule reaches the client, or when resolution
// failed. Written rather than left null so every booking carries the same shape
// and a reader never has to distinguish "no rules" from "not computed" by the
// absence of a column.
export function emptyCommercials(components: FareComponents): CommercialsRecord {
  const total = round2(components.total)
  return {
    airline: {
      total,
      base: round2(components.base),
      otherTax: round2(components.otherTax),
      fuelSurcharge: round2(components.fuelSurcharge),
      taxLines: components.taxLines.map(l => ({ ...l })),
    },
    adjustments: [],
    displayedFare: total,
    sellTotal: total,
    tmcCost: total,
    tmcMargin: 0,
    ambiguous: false,
  }
}
