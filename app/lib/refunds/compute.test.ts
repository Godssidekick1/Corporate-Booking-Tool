import { describe, it, expect } from 'vitest'
import { computeRefund, apportion, splitGst, type RefundInputs, type RefundRule } from './compute'

// The Gulf Air booking cancelled on 2026-11-05 (one adult), with a markup,
// fee and discount added so every line has something in it.
const ONE: RefundInputs = {
  airline: { base: 17865, total: 27708, taxLines: [{ code: 'YQ', amount: 4832 }, { code: 'K3', amount: 1135 }, { code: 'OT', amount: 3876 }] },
  markup: 500, processingFee: 300, discount: 200,
  seatFees: { total: 0 },
  passengerBreakup: [{ PaxType: 'ADT', BaseFare: 17865, Tax: 9843, TotalFare: 27708 }],
  passengerCount: 1, passengerIndex: 0,
  provider: { cancellationCharge: 3000, serviceTaxOnRaf: 540 },
}
const REFUND_ALL: RefundRule = { refundMarkup: true, refundProcessingFee: true, tmcCancellationFee: 0, tmcCancellationFeeUnit: 'amount', gstRate: 18 }
const KEEP_ALL: RefundRule = { refundMarkup: false, refundProcessingFee: false, tmcCancellationFee: 250, tmcCancellationFeeUnit: 'amount', gstRate: 18 }

const ded = (c: ReturnType<typeof computeRefund>, key: string) => c.deductions.find(d => d.key === key)!

describe('refund arithmetic', () => {
  it('what was charged: the airline fare and taxes, then the TMC lines, adding up to what the company paid', () => {
    const c = computeRefund(ONE, REFUND_ALL, true)
    expect(c.charged.airlineTotal).toBe(27708)
    expect(c.charged.totalPaid).toBe(27708 + 500 + 300 - 200)
    expect(c.charged.k3).toBe(1135)
    expect(c.charged.lines.map(l => l.key)).toEqual(['base', 'tax:YQ', 'tax:K3', 'tax:OT', 'markup', 'processing_fee', 'discount'])
  })

  it('a rule that refunds markup and fee keeps back only what the airline keeps', () => {
    const c = computeRefund(ONE, REFUND_ALL, true)
    expect(c.result.deductionsTotal).toBe(3540)
    expect(c.result.refundAmount).toBe(28308 - 3540)
    expect(c.result.airlineRefund).toBe(27708 - 3540)
    // The TMC hands back its markup and fee: it keeps nothing but gave the discount.
    expect(c.result.tmcRetained).toBe(28308 - c.result.refundAmount - 3540)
  })

  it('a rule that keeps markup and fee, with a TMC fee and GST on it', () => {
    const c = computeRefund(ONE, KEEP_ALL, true)
    expect(ded(c, 'markup_kept')).toMatchObject({ amount: 500, source: 'rule' })
    expect(ded(c, 'processing_fee_kept')).toMatchObject({ amount: 300, source: 'rule' })
    expect(ded(c, 'tmc_cancellation_fee')).toMatchObject({ amount: 250, source: 'rule' })
    expect(ded(c, 'gst_on_tmc_fee')).toMatchObject({ amount: 45, source: 'computed' })
    expect(c.result.refundAmount).toBe(28308 - (3540 + 250 + 45 + 500 + 300))
  })

  it('GST: CGST and SGST in the same state, IGST across states; unknown means IGST, with a warning', () => {
    expect(computeRefund(ONE, KEEP_ALL, true).gst.onTmcFee).toEqual({ cgst: 22.5, sgst: 22.5, igst: 0 })
    expect(computeRefund(ONE, KEEP_ALL, false).gst.onTmcFee).toEqual({ cgst: 0, sgst: 0, igst: 45 })
    const unknown = computeRefund(ONE, KEEP_ALL, null)
    expect(unknown.gst.onTmcFee.igst).toBe(45)
    expect(unknown.warnings.join(' ')).toMatch(/IGST is assumed/)
    expect(computeRefund(ONE, KEEP_ALL, true).charged.k3Split).toEqual({ cgst: 567.5, sgst: 567.5, igst: 0 })
  })

  it('a percentage TMC fee is a share of what was paid', () => {
    const c = computeRefund(ONE, { ...KEEP_ALL, tmcCancellationFee: 2, tmcCancellationFeeUnit: 'percent' }, true)
    expect(ded(c, 'tmc_cancellation_fee').amount).toBe(566.16)
    expect(ded(c, 'gst_on_tmc_fee').amount).toBe(101.91)
  })

  it('the desk edits a line: it is marked edited, GST follows an edited TMC fee, and negatives are refused', () => {
    const c = computeRefund(ONE, KEEP_ALL, true, { airline_cancellation_charge: 2500, tmc_cancellation_fee: 100 })
    expect(ded(c, 'airline_cancellation_charge')).toMatchObject({ amount: 2500, default: 3000, source: 'edited' })
    expect(ded(c, 'gst_on_tmc_fee').amount).toBe(18)
    expect(computeRefund(ONE, KEEP_ALL, true, { markup_kept: 500 }).deductions.find(d => d.key === 'markup_kept')!.source).toBe('rule')
    expect(() => computeRefund(ONE, KEEP_ALL, true, { airline_penalty: -1 })).toThrow(/zero or more/)
  })

  it('rounds the refund to the rupee and shows the round-off', () => {
    const c = computeRefund(ONE, REFUND_ALL, true, { airline_cancellation_charge: 2999.6 })
    expect(c.result.refundExact).toBe(24768.4)
    expect(c.result.refundAmount).toBe(24768)
    expect(c.result.roundOff).toBe(-0.4)
  })

  it('deductions above what was paid give a zero refund, never a negative one', () => {
    const c = computeRefund(ONE, REFUND_ALL, true, { airline_penalty: 40000 })
    expect(c.result.refundAmount).toBe(0)
    expect(c.warnings.join(' ')).toMatch(/set to zero/)
  })

  it('two passengers: each ticket weighed by its airline fare, and the tickets add up to the booking exactly', () => {
    const two: RefundInputs = {
      ...ONE,
      airline: { base: 20001, total: 30001, taxLines: [{ code: 'YQ', amount: 6001 }, { code: 'K3', amount: 3999 }] },
      markup: 1001, processingFee: 301, discount: 0,
      passengerBreakup: [{ BaseFare: 13334, TotalFare: 20000 }, { BaseFare: 6667, TotalFare: 10001 }],
      passengerCount: 2,
      provider: { cancellationCharge: 1001, serviceTaxOnRaf: 0 },
    }
    const [a, b] = [0, 1].map(i => computeRefund({ ...two, passengerIndex: i }, REFUND_ALL, true))
    expect(a.charged.lines.find(l => l.key === 'base')!.amount).toBe(13334)
    expect(r(a.charged.airlineTotal + b.charged.airlineTotal)).toBe(30001)
    expect(r(a.charged.totalPaid + b.charged.totalPaid)).toBe(30001 + 1001 + 301)
    expect(r(ded(a, 'airline_cancellation_charge').amount + ded(b, 'airline_cancellation_charge').amount)).toBe(1001)
  })

  it('no fare per passenger: split equally, with a warning', () => {
    const c = computeRefund({ ...ONE, passengerBreakup: [], passengerCount: 2 }, REFUND_ALL, true)
    expect(c.share).toBe(0.5)
    expect(c.warnings.join(' ')).toMatch(/split equally/)
  })

  it('apportion and splitGst keep every rupee', () => {
    expect([0, 1, 2].map(i => apportion(100, [1, 1, 1], i))).toEqual([33.33, 33.33, 33.34])
    expect(splitGst(45.01, true)).toEqual({ cgst: 22.51, sgst: 22.5, igst: 0 })
  })
})

const r = (n: number) => Math.round(n * 100) / 100
