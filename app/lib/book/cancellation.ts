import type { CancellationResponse } from '@/app/lib/amadeus/client'

// ── Cancelling a booking ─────────────────────────────────────────────────────
// What may be cancelled, what the provider's answer means, and who sees which
// part of it. POST /api/book/[bookingId]/cancel acts on these; the booking's
// own page shows them.
//
//   before the airline has it      withdrawn here, no provider call: pending
//   (pending_approval, approved,   approval steps close as 'withdrawn'
//    approval_misconfigured,
//    priced, passenger_added)
//   held, ticketed                 sent to the provider (CancelBooking with the
//                                  booking's ReferenceNo), then recorded
//   cancel_requested, cancelled,   refused: already done, or never booked
//   failed, rejected
//
// Who may cancel: anyone who may act on the booking (the traveller, the
// booker, the travel desk for its clients, a corporate admin at a
// self-booking client). No approval: cancelling never costs the company more.
//
// The money: a traveller and the corporate client see the airline's
// cancellation charges and "refund being processed" -- never the refund
// itself, which is the airline's figure and, set against what the company
// paid, would show the markup. The travel desk sees everything the provider
// said. How much of the sell price goes back to the company is not decided
// yet (docs/go-live-checklist.md).
// ─────────────────────────────────────────────────────────────────────────────

export const WITHDRAWABLE = ['pending_approval', 'approved', 'approval_misconfigured', 'priced', 'passenger_added'] as const
export const WITH_PROVIDER = ['held', 'ticketed'] as const

export const MAX_REASON = 500

export type Cancellability =
  | { kind: 'withdraw' }
  | { kind: 'provider' }
  | { kind: 'refused'; code: string; error: string }

export function cancellability(status: string): Cancellability {
  if ((WITHDRAWABLE as readonly string[]).includes(status)) return { kind: 'withdraw' }
  if ((WITH_PROVIDER as readonly string[]).includes(status)) return { kind: 'provider' }
  if (status === 'cancelled') return { kind: 'refused', code: 'ALREADY_CANCELLED', error: 'This booking is already cancelled.' }
  if (status === 'cancel_requested') {
    return { kind: 'refused', code: 'CANCEL_REQUESTED', error: 'Cancellation has already been requested for this booking.' }
  }
  return { kind: 'refused', code: 'NOT_CANCELLABLE', error: 'This booking was never confirmed, so there is nothing to cancel.' }
}

// What the provider answered, as stored on bookings.cancellation.
export interface CancellationRecord {
  cancelStatus: string | null
  changeRequestId: string | null
  changeRequestStatus: string | null
  refundedAmount: number
  cancellationCharge: number
  serviceTaxOnRaf: number
  transactionId: string | null
  trackIds: string | null
  remarks: string | null
  // Ticketed when cancelled: money may come back. False for a held booking.
  wasTicketed: boolean
}

const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)

// Done ("cancelled") when either status says so; otherwise the provider has
// the request and settles it later. Unknown words count as "requested": a
// booking is only shown cancelled when the provider said it is.
export function providerOutcome(
  r: Partial<CancellationResponse>,
  wasTicketed: boolean
): { status: 'cancelled' | 'cancel_requested'; record: CancellationRecord } {
  const record: CancellationRecord = {
    cancelStatus: text(r.CancelStatus),
    changeRequestId: text(r.ChangeRequestId),
    changeRequestStatus: text(r.ChangeRequestStatus),
    refundedAmount: num(r.RefundedAmount),
    cancellationCharge: num(r.CancellationCharge),
    serviceTaxOnRaf: num(r.ServiceTaxOnRAF),
    transactionId: text(r.TransactionID),
    trackIds: text(r.TrackIds),
    remarks: text(r.Remarks),
    wasTicketed,
  }
  const done = [record.cancelStatus, record.changeRequestStatus].some(s => s?.toLowerCase() === 'cancelled')
  return { status: done ? 'cancelled' : 'cancel_requested', record }
}

// The traveller's and the corporate client's view.
export interface CancellationView {
  cancelledAt: string | null
  cancelledByName: string | null
  reason: string | null
  // The airline's charges for cancelling (charge + tax on it); 0 for a
  // booking cancelled before ticketing.
  charges: number
  // none: nothing was paid to the airline yet. processing: a refund may be
  // due and is being settled.
  refund: 'none' | 'processing'
}

// The travel desk's: everything the provider said.
export interface DeskCancellationView extends CancellationView {
  provider: CancellationRecord | null
}

export function cancellationView(
  b: { cancelled_at: string | null; cancellation_reason: string | null; cancellation: unknown; cancelled_by_name?: string | null },
  desk: boolean
): CancellationView | DeskCancellationView | null {
  if (!b.cancelled_at) return null
  const record = (b.cancellation ?? null) as CancellationRecord | null
  const view: CancellationView = {
    cancelledAt: b.cancelled_at,
    cancelledByName: b.cancelled_by_name ?? null,
    reason: b.cancellation_reason,
    charges: record ? Math.round((record.cancellationCharge + record.serviceTaxOnRaf) * 100) / 100 : 0,
    refund: record?.wasTicketed ? 'processing' : 'none',
  }
  return desk ? { ...view, provider: record } : view
}
