import { NextRequest } from 'next/server'
import { requireUser } from '@/app/lib/auth/session'
import { actingTraveller } from '@/app/lib/book/bookingActor'
import { amadeus, AmadeusError } from '@/app/lib/amadeus/client'
import { providerFailure, isDeskStaff } from '@/app/lib/book/providerErrors'
import {
  cancellability, providerOutcome, cancellationView, MAX_REASON, WITHDRAWABLE, WITH_PROVIDER,
} from '@/app/lib/book/cancellation'
import { db, transaction } from '@/app/lib/db'
import * as employees from '@/app/lib/repositories/employees'
import * as bookingsRepo from '@/app/lib/repositories/bookings'
import * as approvals from '@/app/lib/repositories/approvals'
import * as audit from '@/app/lib/repositories/audit'
import { route } from '@/app/lib/http/handler'

// ── POST /api/book/[bookingId]/cancel ────────────────────────────────────────
// Cancels a booking. Body: { reason?: string } (at most 500 characters; sent
// to the provider as CancellationRemarks). The rules are in
// app/lib/book/cancellation.ts:
//
//   not yet with the airline   withdrawn here, in one transaction with its
//                              open approval steps; no provider call
//   held or ticketed           CancelBooking with the booking's ReferenceNo,
//                              then the answer is recorded
//
// A cancellation under way is claimed on the row first, so a double click or
// a second tab cannot send the provider a second request (409). The claim is
// let go when the provider refuses, so the person can try again.
//
// Once the provider has accepted, failing to record that is NOT a failed
// cancellation: the answer still says what happened, with a warning, the same
// way /api/book/ticket treats a ticket it could not save.
// ─────────────────────────────────────────────────────────────────────────────

export const POST = route(async (
  req: NextRequest,
  { params }: { params: Promise<{ bookingId: string }> }
) => {
  const user = await requireUser()
  const { bookingId } = await params

  const body = await req.json().catch(() => ({})) as { reason?: unknown }
  if (body.reason !== undefined && body.reason !== null && typeof body.reason !== 'string') {
    return Response.json({ error: 'reason must be text' }, { status: 400 })
  }
  const reason = typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim() : null
  if (reason && reason.length > MAX_REASON) {
    return Response.json({ error: `The reason can be at most ${MAX_REASON} characters.` }, { status: 400 })
  }

  const [me, booking] = await Promise.all([
    employees.traveller(db, user.id),
    bookingsRepo.cancelTarget(db, bookingId),
  ])
  if (!me) return Response.json({ error: 'Employee record not found' }, { status: 404 })
  if (!booking) return Response.json({ error: 'Booking not found' }, { status: 404 })

  // The traveller, or anyone who may book for them (app/lib/book/bookingActor.ts).
  const { traveller, onBehalf } = await actingTraveller(db, user, me, booking)
  if (booking.employee_id !== traveller.id) {
    return Response.json({ error: 'Not authorized to act on this booking' }, { status: 403 })
  }
  const desk = onBehalf && isDeskStaff(user)

  const can = cancellability(booking.status)
  if (can.kind === 'refused') {
    return Response.json({ error: can.error, code: can.code, status: booking.status }, { status: 409 })
  }

  const auditEntry = (status: string, extra: Record<string, unknown>) => ({
    action: 'booking.cancelled', entityType: 'booking', entityId: booking.id, userId: user.id,
    clientId: booking.client_id, tmcId: booking.tmc_id,
    metadata: { from_status: booking.status, to_status: status, on_behalf: onBehalf, reason, ...extra },
  })

  // ── Not with the airline yet: withdrawn here ─────────────────────────────────
  if (can.kind === 'withdraw') {
    const withdrawn = await transaction(async tx => {
      const ok = await bookingsRepo.withdraw(tx, booking.id, { by: me.id, reason, statuses: WITHDRAWABLE })
      if (!ok) return null
      const steps = await approvals.withdrawPending(tx, booking.id)
      await audit.append(tx, auditEntry('cancelled', { approval_steps_withdrawn: steps }))
      return { steps }
    })
    if (!withdrawn) {
      return Response.json({ error: 'This booking changed while you were cancelling it. Reload and try again.', code: 'CHANGED' }, { status: 409 })
    }
    return Response.json({
      ok: true, bookingId: booking.id, status: 'cancelled',
      cancellation: { refund: 'none', charges: 0, reason },
    })
  }

  // ── Held or ticketed: the provider cancels ───────────────────────────────────
  const referenceNo = booking.provider_order_id
  if (!referenceNo) {
    console.error('[cancel] booking is with the airline but has no ReferenceNo', { bookingId })
    return Response.json({
      error: 'This booking is missing its airline reference and cannot be cancelled here. Please contact your travel desk.',
    }, { status: 500 })
  }

  if (!(await bookingsRepo.claimCancellation(db, booking.id, WITH_PROVIDER))) {
    return Response.json({
      error: 'A cancellation for this booking is already in progress. Reload in a moment to see the result.',
      code: 'CANCEL_IN_PROGRESS',
    }, { status: 409 })
  }

  let answer
  try {
    answer = await amadeus.cancelBooking(referenceNo, reason ?? (onBehalf ? 'Cancelled by the travel desk' : 'Cancelled by the traveller'))
  } catch (err) {
    await bookingsRepo.releaseCancellation(db, booking.id).catch(e => console.error('[cancel] could not release the claim', e))
    if (err instanceof AmadeusError) return providerFailure(err, 'cancel', user)
    console.error('[cancel] error', err)
    return Response.json({ error: 'Could not cancel this booking. Your booking is unchanged.' }, { status: 500 })
  }

  const { status, record } = providerOutcome(answer, booking.status === 'ticketed')
  const view = cancellationView({
    cancelled_at: new Date().toISOString(), cancellation_reason: reason, cancellation: record,
    cancelled_by_name: null,
  }, desk)

  // Accepted by the provider. Recording it failing must not read as a failed
  // cancellation (see the header).
  try {
    await transaction(async tx => {
      await bookingsRepo.recordCancellation(tx, booking.id, { status, by: me.id, reason, record })
      await audit.append(tx, auditEntry(status, {
        change_request_id: record.changeRequestId, provider_status: record.cancelStatus,
      }))
    })
  } catch (err) {
    console.error('[cancel] the provider cancelled but it could not be recorded', err, { bookingId, record })
    return Response.json({
      ok: true, bookingId: booking.id, status, cancellation: view,
      warning: 'The airline accepted the cancellation, but saving it here failed. Contact your travel desk if the booking still shows as active shortly.',
    })
  }

  return Response.json({ ok: true, bookingId: booking.id, status, cancellation: view })
})
