import type { RefundDetail } from '@/app/lib/repositories/refunds'
import type { CommercialsRecord } from '@/app/lib/commercials/composeSellPrice'
import type { CancellationRecord } from '@/app/lib/book/cancellation'
import { gstCodeForState } from '@/app/lib/data/locations'
import { computeRefund, type RefundInputs, type RefundRule, type RefundComputation, type DeductionKey } from './compute'

// ── From a stored booking to the refund panel ───────────────────────────────
// Reads what the booking froze (commercials, the per-passenger fare, the
// traveller snapshot, the provider's cancellation answer) and the client's
// refund rule into compute.ts, and lays out the panel's ticket summary.
// A processed refund is never recomputed: its frozen lines are the record.
// ─────────────────────────────────────────────────────────────────────────────

interface Pax { FirstName?: string; MiddleName?: string; LastName?: string; PaxType?: string; SeatListDetails?: { SeatFee?: string | number }[] }

const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0 }

// The same GST state, compared by GST code so "Haryana" and "06" agree.
// Null when either side has none recorded.
export function sameGstState(a: string | null | undefined, b: string | null | undefined): boolean | null {
  const code = (s: string | null | undefined) => {
    const v = (s ?? '').trim()
    if (!v) return null
    if (/^\d{2}$/.test(v)) return v
    return gstCodeForState(v) ?? v.toLowerCase()
  }
  const [x, y] = [code(a), code(b)]
  return x && y ? x === y : null
}

export function refundRule(c: RefundDetail['client']): RefundRule {
  return {
    refundMarkup: c.refund_markup,
    refundProcessingFee: c.refund_processing_fee,
    tmcCancellationFee: num(c.tmc_cancellation_fee),
    tmcCancellationFeeUnit: c.tmc_cancellation_fee_unit === 'percent' ? 'percent' : 'amount',
    gstRate: num(c.gst_rate),
  }
}

export function refundInputs(d: RefundDetail): RefundInputs {
  const b = d.booking
  const commercials = b.commercials as unknown as CommercialsRecord | null
  const pax = ((b.traveler_snapshot as { PassengerDetails?: Pax[] } | null)?.PassengerDetails ?? [])
  const fare = (b.fare_breakdown ?? {}) as { seatFees?: number; passengerBreakup?: RefundInputs['passengerBreakup'] }
  const adj = (source: string) => (commercials?.adjustments ?? [])
    .filter(a => a.source === source).reduce((sum, a) => sum + num(a.amount), 0)
  const cancellation = b.cancellation as unknown as CancellationRecord | null
  // Bookings made before commercials were frozen carry only the total.
  const airlineTotal = num(commercials?.airline.total ?? b.total_cost ?? b.sell_total)
  return {
    airline: commercials
      ? { base: num(commercials.airline.base), total: airlineTotal, taxLines: commercials.airline.taxLines ?? [] }
      : { base: airlineTotal, total: airlineTotal, taxLines: [] },
    markup: adj('markup'),
    processingFee: adj('processing_fee'),
    discount: adj('discount'),
    seatFees: {
      total: num(fare.seatFees),
      byPassenger: pax.length ? pax.map(p => (p.SeatListDetails ?? []).reduce((s, x) => s + num(x.SeatFee), 0)) : undefined,
    },
    passengerBreakup: fare.passengerBreakup ?? [],
    passengerCount: Math.max(1, pax.length),
    passengerIndex: d.passenger_index,
    provider: cancellation
      ? { cancellationCharge: num(cancellation.cancellationCharge), serviceTaxOnRaf: num(cancellation.serviceTaxOnRaf) }
      : null,
  }
}

export function computeFor(d: RefundDetail, overrides: Partial<Record<DeductionKey, number>> = {}): RefundComputation {
  return computeRefund(refundInputs(d), refundRule(d.client), sameGstState(d.client.branch_gst_state, d.client.gst_state ?? d.client.state), overrides)
}

// Where the money goes back, from how the ticket was paid.
export function defaultMode(d: RefundDetail): 'corporate_card' | 'agency_credit' | 'traveller_card' | 'other' {
  const payer = (d.booking.resolved_fop as { payer?: string } | null)?.payer
  return payer === 'corporate' ? 'corporate_card' : payer === 'traveller' ? 'traveller_card' : payer === 'agency' ? 'agency_credit' : 'other'
}

export interface FrozenLines {
  computation: RefundComputation
  overrides: Partial<Record<DeductionKey, number>>
}

// The ticket's summary strip, for the panel's header.
export function ticketSummary(d: RefundDetail) {
  const b = d.booking
  const pax = ((b.traveler_snapshot as { PassengerDetails?: Pax[] } | null)?.PassengerDetails ?? [])[d.passenger_index] ?? {}
  const it = (b.itinerary ?? {}) as {
    airline?: { code?: string; name?: string }; cabin?: string
    origin?: { code?: string; dateTime?: string }; destination?: { code?: string }
    legs?: { bookingCode?: string; airlineCode?: string; flightNumber?: string }[]
  }
  const cancellation = b.cancellation as unknown as CancellationRecord | null
  return {
    passenger: [pax.FirstName, pax.MiddleName, pax.LastName].filter(Boolean).join(' ') || null,
    paxType: pax.PaxType ?? null,
    pnr: b.pnr,
    airlinePnr: b.airline_pnr,
    ticketNumber: d.ticket_number,
    reference: b.provider_order_id,
    sector: [it.origin?.code, it.destination?.code].filter(Boolean).join(' → ') || null,
    departure: it.origin?.dateTime ?? null,
    airline: it.airline?.code ? { code: it.airline.code, name: it.airline.name ?? it.airline.code } : null,
    flights: (it.legs ?? []).map(l => `${l.airlineCode ?? ''}${l.flightNumber ?? ''}`).filter(Boolean),
    cabin: it.cabin ?? null,
    rbd: [...new Set((it.legs ?? []).map(l => l.bookingCode).filter(Boolean))].join(', ') || null,
    bookedAt: b.created_at,
    cancelledAt: b.cancelled_at,
    cancelledBy: b.cancelled_by_name,
    cancellationReason: b.cancellation_reason,
    providerStatus: [cancellation?.cancelStatus, cancellation?.changeRequestStatus].filter(Boolean).join(' / ') || null,
    bookingStatus: b.status,
  }
}
