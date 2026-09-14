// ── Adjustment ───────────────────────────────────────────────────────────────
// One thing that moves money on a booking.
//
// THE EXTENSION POINT. Five sources can adjust a price in this product and only
// three of them do anything today:
//
//   discount        visible line, reduces          LIVE
//   markup          embedded in the fare, adds     LIVE
//   processing_fee  visible line, adds             LIVE
//   deal_code       —                              advisory only: the aggregator
//                                                  has no field to carry a tour
//                                                  code, so a resolved deal code
//                                                  is recorded for manual GDS
//                                                  entry and changes no number
//   fop             —                              no payment gateway exists yet
//
// The last two have a declared slot that contributes zero. That is the whole
// point of modelling this as a list rather than three named fields: wiring
// either of them later is a value change, not a shape change, and nothing
// downstream — the frozen jsonb on bookings, the fare breakdown, the margin
// arithmetic — has to be rewritten to accommodate it.
// ─────────────────────────────────────────────────────────────────────────────

export type AdjustmentSource =
  | 'discount'
  | 'markup'
  | 'processing_fee'
  | 'deal_code'
  | 'fop'

// What the traveller is allowed to learn.
//
//   'line'      its own row in the fare breakdown, with its own label
//   'embedded'  folded into the fare so it cannot be told apart from the
//               airline's own price. Markup, and ONLY markup: the rule is that
//               a traveller must never be able to identify it, which is why
//               nothing carrying this visibility may ever be serialised to the
//               browser — not hidden in the payload, not sent at all
//   'margin'    affects what the TMC earns, never what anyone is charged
export type AdjustmentVisibility = 'line' | 'embedded' | 'margin'

export interface Adjustment {
  source: AdjustmentSource
  visibility: AdjustmentVisibility
  // -1 reduces the total, +1 increases it. Held separately from `amount` so
  // amount is always positive and a breakdown can render "− ₹760" without
  // having to know which sources happen to be reductions.
  sign: -1 | 1
  amount: number

  // Which rule produced this, and how it reached the client. Null for a source
  // that is not rule-driven.
  ruleId: string | null
  // describeVia() output — 'Direct assignment' | 'Bucket · X' | 'Client group · Y'.
  via: string | null

  // How it was worked out, frozen so a counsellor reading a booking six months
  // later can reconstruct the number without the rule still existing.
  calcType?: 'percent' | 'fixed'
  calcOn?: string
  rate?: number

  // processing_fee only.
  calcBasis?: 'per_transaction' | 'per_sector'
  pax?: number
  sectors?: number
}

// The order adjustments are applied in. Stated here as data rather than left
// implicit in the order of statements inside composeSellPrice, so that adding a
// source means editing one list.
export const ADJUSTMENT_ORDER: AdjustmentSource[] = [
  'discount',
  'markup',
  'processing_fee',
  'deal_code',
  'fop',
]

export const ADJUSTMENT_LABELS: Record<AdjustmentSource, string> = {
  discount: 'Discount',
  markup: 'Markup',
  processing_fee: 'Processing fee',
  deal_code: 'Deal code',
  fop: 'Payment method',
}

// The breakdown a traveller may see: the visible lines only, in order.
//
// Used by the routes that serialise a price to the browser. It is a filter over
// the frozen record rather than a second source of truth, so the two cannot
// drift — and it exists as a function so the "never send an embedded
// adjustment" rule is written once instead of remembered at each call site.
export function visibleLines(adjustments: Adjustment[]): Adjustment[] {
  return adjustments.filter(a => a.visibility === 'line' && a.amount !== 0)
}
