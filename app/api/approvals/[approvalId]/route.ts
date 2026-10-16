import { requireUser } from '@/app/lib/auth/session'
import { NextRequest } from 'next/server'
import { advanceApprovalChain } from '@/app/lib/approval-engine/resolveApprovalTier'
import { db, transaction } from '@/app/lib/db'
import * as approvals from '@/app/lib/repositories/approvals'
import * as bookings from '@/app/lib/repositories/bookings'
import * as trips from '@/app/lib/repositories/trips'
import * as employees from '@/app/lib/repositories/employees'
import { route } from '@/app/lib/http/handler'
import type { Verdict } from '@/app/lib/rule-engine/evaluateBooking'

// ── PATCH /api/approvals/[approvalId] ────────────────────────────────────
// The only way an approval actually gets decided. Verifies the caller is
// the row's assigned approver (never trusts a client-passed approver id),
// then:
//   - reject  -> approvals row -> 'rejected', bookings row -> 'rejected'.
//     Terminal — no further tiers get created even if more exist in the
//     chain, since a rejection at any tier kills the whole booking.
//   - approve -> approvals row -> 'approved', then advanceApprovalChain
//     decides what's next: either the next tier's row gets created
//     (bookings stays 'pending_approval', new approver notified) or there
//     is no next tier and bookings flips to 'approved' (employee can now
//     call /api/book/booking).
//
// A trip's sign-off (approvals.trip_id, startApprovalForTrip) is decided the
// same way, with the trip's approval_status in the booking status's place:
// reject -> 'rejected' (the trip can be edited and resubmitted), the last step
// approved -> 'approved'. Its bookings are not touched: each was approved, if
// it needed to be, when it was booked.
// ─────────────────────────────────────────────────────────────────────────────

interface DecisionBody {
  decision: 'approve' | 'reject'
  note?: string
}

export const PATCH = route(async (
  req: NextRequest,
  { params }: { params: Promise<{ approvalId: string }> }
) => {
  const { approvalId } = await params
  const user = await requireUser()

  const caller = await employees.traveller(db, user.id)

  if (!caller) {
    return Response.json({ error: 'Employee record not found' }, { status: 404 })
  }

  const approval = await approvals.forDecision(db, approvalId)

  if (!approval) {
    return Response.json({ error: 'Approval not found' }, { status: 404 })
  }

  if (approval.approver_id !== caller.id) {
    return Response.json({ error: 'You are not the assigned approver for this request' }, { status: 403 })
  }

  if (approval.status !== 'pending') {
    return Response.json({ error: `This approval has already been ${approval.status}` }, { status: 409 })
  }

  const body: DecisionBody = await req.json()
  const { decision, note } = body

  if (decision !== 'approve' && decision !== 'reject') {
    return Response.json({ error: 'decision must be "approve" or "reject"' }, { status: 400 })
  }

  if (approval.trip_id) return decideTrip(approval, approval.trip_id, decision, note ?? null, user.id)

  const booking = approval.booking_id ? await bookings.approvalTarget(db, approval.booking_id) : null

  if (!booking) {
    return Response.json({ error: 'Booking for this approval was not found' }, { status: 404 })
  }

  // Someone else may have already acted on this booking through a
  // different path (e.g. it was cancelled) — approving/rejecting a booking
  // that's no longer 'pending_approval' would be acting on stale state.
  if (booking.status !== 'pending_approval') {
    return Response.json({
      error: `This booking is no longer awaiting approval (current status: "${booking.status}"). No action taken.`,
    }, { status: 409 })
  }

  // ── The decision, the booking status and the next tier, atomically ────────
  // THE STATE THIS ELIMINATES. Every branch below used to be its own HTTP call,
  // and each carried an error message that only makes sense without a
  // transaction: "Your decision was recorded, but the booking status could not
  // be updated. Please contact support." That is a torn write described in
  // prose — the approval says approved, the booking still says
  // pending_approval, and no amount of retrying fixes it because the approval
  // row is already decided and the caller is no longer the pending approver.
  //
  // advanceApprovalChain runs on the SAME connection, so the next tier's
  // approval row is part of the same commit. If raising it fails, the decision
  // is undone too and the approver can simply try again.
  let outcomeStatus: { bookingStatus: string; nextTier?: number }
  try {
    outcomeStatus = await transaction(async (tx) => {
      await approvals.decide(tx, approvalId, decision === 'approve' ? 'approved' : 'rejected', note ?? null)

      const setBooking = async (status: string) => {
        await bookings.setStatus(tx, booking.id, status)
        return status
      }

      if (decision === 'reject') return { bookingStatus: await setBooking('rejected') }

      // Approved — see if the chain has a next tier that this booking's stored
      // verdict actually meets. chain_template_id/verdict were captured on the
      // approval row itself when it was created, so no need to re-derive them.
      if (!approval.chain_template_id) {
        // Shouldn't happen in practice (every approval created by the engine
        // sets chain_template_id), but fail toward finalizing rather than
        // leaving the booking stuck if it somehow does.
        return { bookingStatus: await setBooking('approved') }
      }

      const outcome = await advanceApprovalChain(tx, {
        subject: { booking: booking.id },
        clientId: approval.client_id,
        employeeId: booking.employee_id,
        chainTemplateId: approval.chain_template_id,
        completedTier: approval.tier,
        verdict: (approval.verdict as Verdict) ?? 'green',
        reason: approval.reason ?? 'Within policy',
      })

      if (!outcome.requiresApproval) return { bookingStatus: await setBooking('approved') }
      // Parallel 'all': this one is in, the rest are still deciding. It used to
      // fall through to the next line and mark the booking misconfigured.
      if (outcome.awaitingOthers) return { bookingStatus: 'pending_approval' }
      if (!outcome.approverId) return { bookingStatus: await setBooking('approval_misconfigured') }

      // Next tier's approval row was created — booking stays pending_approval.
      return { bookingStatus: 'pending_approval', nextTier: outcome.tier }
    }, { userId: user.id })
  } catch (writeError) {
    console.error('Approval decision rolled back', writeError, { approvalId, bookingId: booking.id })
    // Honest now, and actionable: nothing was recorded, so retrying is safe.
    return Response.json({
      ok: false,
      error: 'Your decision could not be recorded. Nothing was changed — please try again.',
    }, { status: 500 })
  }

  return Response.json({ ok: true, ...outcomeStatus })
})

// The trip sign-off's decision: the same chain walk, the trip's approval_status
// as the thing it settles. One transaction, like the booking path.
async function decideTrip(
  approval: approvals.ApprovalForDecision,
  tripId: string,
  decision: 'approve' | 'reject',
  note: string | null,
  userId: string
): Promise<Response> {
  const trip = await trips.approvalTarget(db, tripId)
  if (!trip) return Response.json({ error: 'Trip for this approval was not found' }, { status: 404 })
  if (trip.approval_status !== 'pending') {
    return Response.json({
      error: `This trip is no longer awaiting sign-off (it is "${trip.approval_status}"). No action taken.`,
    }, { status: 409 })
  }

  try {
    const result = await transaction(async (tx) => {
      await approvals.decide(tx, approval.id, decision === 'approve' ? 'approved' : 'rejected', note)
      const settle = async (status: 'approved' | 'rejected') => {
        await trips.setApprovalStatus(tx, tripId, status)
        return { tripApprovalStatus: status }
      }
      if (decision === 'reject') return settle('rejected')
      if (!approval.chain_template_id) return settle('approved')

      const outcome = await advanceApprovalChain(tx, {
        subject: { trip: tripId },
        clientId: approval.client_id,
        employeeId: trip.created_by,
        chainTemplateId: approval.chain_template_id,
        completedTier: approval.tier,
        verdict: (approval.verdict as Verdict) ?? 'green',
        reason: approval.reason ?? 'Trip sign-off',
      })
      if (!outcome.requiresApproval) return settle('approved')
      if (outcome.awaitingOthers || outcome.approverId) {
        return { tripApprovalStatus: 'pending' as const, nextTier: outcome.awaitingOthers ? undefined : outcome.tier }
      }
      // The next step has nobody to ask. Approving anyway would skip a step
      // the company configured, so it is flagged, as a booking would be.
      await trips.setApprovalStatus(tx, tripId, 'misconfigured')
      return { tripApprovalStatus: 'misconfigured' as const }
    }, { userId })
    return Response.json({ ok: true, ...result })
  } catch (writeError) {
    console.error('Trip approval decision rolled back', writeError, { approvalId: approval.id, tripId })
    return Response.json({
      ok: false,
      error: 'Your decision could not be recorded. Nothing was changed — please try again.',
    }, { status: 500 })
  }
}
