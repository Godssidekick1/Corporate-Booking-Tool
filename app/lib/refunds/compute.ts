// ── What a cancelled ticket refunds ──────────────────────────────────────────
// Pure arithmetic: the booking's frozen figures, the client's refund rule and
// the desk's edits in, the refund panel's statement out (sections A–D of the
// plan). No database, so every rule is unit tested (compute.test.ts).
//
//   A  charged      what this ticket cost: the airline's fare and taxes, seat
//                   fees, the TMC's markup and fee, the discount, the total
//   B  deductions   what is kept back: the airline's charge and the tax on
//                   it, any penalty, the TMC's cancellation fee and GST on
//                   it, and markup / fee the client's rule does not refund
//   C  GST split    CGST + SGST in the same state, IGST across states
//   D  result       refund to the company (to the rupee, round-off shown),
//                   expected back from the airline, and what the TMC keeps
//
// One refund is one passenger's ticket. Figures stored per booking are
// shared out by each passenger's airline fare, the last ticket taking the
// rounding remainder, so a booking's tickets always add up to the booking.
//
// GST is charged on the TMC's own cancellation fee, the one new charge made
// when cancelling. Markup or fee the TMC keeps is simply not refunded. The
// airline's tax on its own charge (the provider's serviceTaxOnRAF) is its own
// line. Every deduction can be edited by the desk; these rules give the
// starting point, to be confirmed by the TMC's finance team.
// ─────────────────────────────────────────────────────────────────────────────

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

export interface TaxLine { code: string; amount: number }

export interface RefundInputs {
  airline: { base: number; taxLines: TaxLine[]; total: number }
  // From commercials.adjustments: amounts as charged, all positive.
  markup: number
  processingFee: number
  discount: number
  // Seat, meal and bag fees, per passenger where known (traveler_snapshot),
  // else the booking's total, shared out.
  seatFees: { total: number; byPassenger?: number[] }
  // fare_breakdown.passengerBreakup: the AIRLINE's per-passenger figures.
  passengerBreakup: { PaxType?: string; BaseFare?: number; Tax?: number; TotalFare?: number }[]
  passengerCount: number
  passengerIndex: number
  // What the provider reported when cancelling, for the whole booking.
  provider: { cancellationCharge: number; serviceTaxOnRaf: number } | null
  // The fare's cancellation penalty per ticket, when known.
  penalty?: number
}

export interface RefundRule {
  refundMarkup: boolean
  refundProcessingFee: boolean
  tmcCancellationFee: number
  tmcCancellationFeeUnit: 'amount' | 'percent'
  gstRate: number
}

export const DEDUCTIONS = [
  'airline_cancellation_charge', 'airline_charge_tax', 'airline_penalty',
  'tmc_cancellation_fee', 'gst_on_tmc_fee', 'markup_kept', 'processing_fee_kept', 'discount_recalled',
] as const
export type DeductionKey = typeof DEDUCTIONS[number]

export const DEDUCTION_LABELS: Record<DeductionKey, string> = {
  airline_cancellation_charge: 'Airline cancellation charge',
  airline_charge_tax: 'Tax on the airline charge',
  airline_penalty: 'Airline penalty',
  tmc_cancellation_fee: 'TMC cancellation fee',
  gst_on_tmc_fee: 'GST on the TMC cancellation fee',
  markup_kept: 'Markup not refunded',
  processing_fee_kept: 'Processing fee not refunded',
  discount_recalled: 'Discount recalled',
}

export type LineSource = 'booking' | 'airline' | 'rule' | 'computed' | 'edited'

export interface Line { key: string; label: string; amount: number; source: LineSource }

export interface GstSplit { cgst: number; sgst: number; igst: number }

export interface RefundComputation {
  passengerIndex: number
  share: number
  charged: { lines: Line[]; k3: number; k3Split: GstSplit; airlineTotal: number; totalPaid: number }
  deductions: (Line & { key: DeductionKey; default: number })[]
  gst: { rate: number; sameState: boolean | null; onTmcFee: GstSplit }
  result: {
    deductionsTotal: number
    refundExact: number
    roundOff: number
    refundAmount: number
    airlineRefund: number
    tmcRetained: number
  }
  warnings: string[]
}

// This passenger's part of `total`, by `weights`; the last index takes what
// rounding leaves over, so the parts always sum to the total exactly.
export function apportion(total: number, weights: number[], index: number): number {
  const sum = weights.reduce((a, w) => a + w, 0)
  if (!weights.length) return r2(total)
  const parts = weights.map(w => r2(sum > 0 ? total * (w / sum) : total / weights.length))
  if (index === weights.length - 1) return r2(total - parts.slice(0, -1).reduce((a, p) => a + p, 0))
  return parts[index]
}

export function splitGst(amount: number, sameState: boolean | null): GstSplit {
  if (sameState) {
    const cgst = r2(amount / 2)
    return { cgst, sgst: r2(amount - cgst), igst: 0 }
  }
  return { cgst: 0, sgst: 0, igst: r2(amount) }
}

export function computeRefund(
  input: RefundInputs,
  rule: RefundRule,
  sameState: boolean | null,
  overrides: Partial<Record<DeductionKey, number>> = {},
): RefundComputation {
  const warnings: string[] = []
  const count = Math.max(1, input.passengerCount)
  const i = Math.min(Math.max(0, input.passengerIndex), count - 1)

  // How this ticket's share of booking-wide figures is weighed.
  const breakup = input.passengerBreakup.length === count ? input.passengerBreakup : []
  const weights = breakup.length ? breakup.map(p => Math.max(0, Number(p.TotalFare) || 0)) : Array(count).fill(1)
  if (!breakup.length && count > 1) warnings.push('No fare per passenger was recorded: the booking is split equally between its tickets.')
  const share = apportion(1, weights, i)
  const part = (total: number) => apportion(total, weights, i)

  // ── A. Charged ─────────────────────────────────────────────────────────────
  const base = breakup.length && Number.isFinite(Number(breakup[i].BaseFare)) ? r2(Number(breakup[i].BaseFare)) : part(input.airline.base)
  const taxLines = input.airline.taxLines.map(t => ({ code: t.code, amount: part(t.amount) }))
  const seat = input.seatFees.byPassenger?.length === count ? r2(input.seatFees.byPassenger[i] ?? 0) : part(input.seatFees.total)
  const markup = part(input.markup)
  const fee = part(input.processingFee)
  const discount = part(input.discount)
  const k3 = r2(taxLines.filter(t => t.code === 'K3').reduce((a, t) => a + t.amount, 0))
  const airlineTotal = r2(base + taxLines.reduce((a, t) => a + t.amount, 0) + seat)
  const totalPaid = r2(airlineTotal + markup + fee - discount)

  const charged: Line[] = [
    { key: 'base', label: 'Base fare', amount: base, source: 'booking' },
    ...taxLines.map(t => ({ key: `tax:${t.code}`, label: t.code === 'K3' ? 'Airline GST (K3)' : t.code, amount: t.amount, source: 'booking' as const })),
    ...(seat ? [{ key: 'seat_fees', label: 'Seat, meal and bag fees', amount: seat, source: 'booking' as const }] : []),
    { key: 'markup', label: 'Markup', amount: markup, source: 'booking' },
    { key: 'processing_fee', label: 'Processing fee', amount: fee, source: 'booking' },
    { key: 'discount', label: 'Discount', amount: -discount, source: 'booking' },
  ]

  // ── B. Deductions, defaults then edits ─────────────────────────────────────
  const tmcFeeDefault = rule.tmcCancellationFeeUnit === 'percent'
    ? r2(totalPaid * (rule.tmcCancellationFee / 100))
    : r2(rule.tmcCancellationFee)
  const defaults: Record<DeductionKey, { amount: number; source: LineSource }> = {
    airline_cancellation_charge: { amount: input.provider ? part(input.provider.cancellationCharge) : 0, source: 'airline' },
    airline_charge_tax: { amount: input.provider ? part(input.provider.serviceTaxOnRaf) : 0, source: 'airline' },
    airline_penalty: { amount: r2(input.penalty ?? 0), source: 'airline' },
    tmc_cancellation_fee: { amount: tmcFeeDefault, source: 'rule' },
    gst_on_tmc_fee: { amount: 0, source: 'computed' }, // set below, from the fee as it stands
    markup_kept: { amount: rule.refundMarkup ? 0 : markup, source: 'rule' },
    processing_fee_kept: { amount: rule.refundProcessingFee ? 0 : fee, source: 'rule' },
    discount_recalled: { amount: 0, source: 'rule' },
  }

  const amountOf = (key: DeductionKey, fallback: number): { amount: number; edited: boolean } => {
    const o = overrides[key]
    if (o === undefined || o === null) return { amount: fallback, edited: false }
    if (!Number.isFinite(o) || o < 0) throw new RangeError(`${DEDUCTION_LABELS[key]} must be zero or more.`)
    return { amount: r2(o), edited: r2(o) !== fallback }
  }

  const tmcFee = amountOf('tmc_cancellation_fee', defaults.tmc_cancellation_fee.amount).amount
  defaults.gst_on_tmc_fee.amount = r2(tmcFee * (rule.gstRate / 100))

  const deductions = DEDUCTIONS.map(key => {
    const d = defaults[key]
    const { amount, edited } = amountOf(key, d.amount)
    return { key, label: DEDUCTION_LABELS[key], amount, default: d.amount, source: edited ? 'edited' as const : d.source }
  })
  const value = (key: DeductionKey) => deductions.find(d => d.key === key)!.amount

  // ── C. GST ─────────────────────────────────────────────────────────────────
  if (sameState === null) warnings.push('The TMC branch or the client has no GST state: IGST is assumed.')
  const gst = { rate: rule.gstRate, sameState, onTmcFee: splitGst(value('gst_on_tmc_fee'), sameState) }

  // ── D. Result ──────────────────────────────────────────────────────────────
  const deductionsTotal = r2(deductions.reduce((a, d) => a + d.amount, 0))
  let refundExact = r2(totalPaid - deductionsTotal)
  if (refundExact < 0) {
    warnings.push('The deductions are more than was paid: the refund is set to zero.')
    refundExact = 0
  }
  const refundAmount = Math.round(refundExact)
  const airlineKeeps = r2(value('airline_cancellation_charge') + value('airline_charge_tax') + value('airline_penalty'))
  const airlineRefund = r2(Math.max(0, airlineTotal - airlineKeeps))
  // What the company does not get back, less what the airline keeps.
  const tmcRetained = r2(totalPaid - refundAmount - (airlineTotal - airlineRefund))

  return {
    passengerIndex: i,
    share,
    charged: { lines: charged, k3, k3Split: splitGst(k3, sameState), airlineTotal, totalPaid },
    deductions,
    gst,
    result: { deductionsTotal, refundExact, roundOff: r2(refundAmount - refundExact), refundAmount, airlineRefund, tmcRetained },
    warnings,
  }
}
