import type { CommercialsRecord } from './composeSellPrice'
import { round2 } from './fareComponents'

// ── What the travel desk sees of a fare ──────────────────────────────────────
// TMC staff booking for someone see how the price is made: the airline's
// fare, the markup inside it, the discount and fee, what the client pays, and
// the TMC's margin. Nobody else is ever sent this: not the traveller, not an
// approver, not a corporate admin booking for a colleague. The routes decide
// who the desk is (bookingActor: via 'tmc'); this only shapes the figures.
// ─────────────────────────────────────────────────────────────────────────────

export interface DeskView {
  airlineTotal: number
  markup: number
  discount: number
  fee: number
  sellTotal: number
  margin: number
}

export function deskView(record: CommercialsRecord | null | undefined): DeskView | null {
  if (!record?.airline) return null
  const sum = (source: string) => round2(record.adjustments
    .filter(a => a.source === source)
    .reduce((n, a) => n + a.amount, 0))
  return {
    airlineTotal: record.airline.total,
    markup: sum('markup'),
    discount: sum('discount'),
    fee: sum('processing_fee'),
    sellTotal: record.sellTotal,
    margin: record.tmcMargin,
  }
}
