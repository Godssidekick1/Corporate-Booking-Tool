import { requireUser } from '@/app/lib/auth/session'
import { db } from '@/app/lib/db'
import * as approvals from '@/app/lib/repositories/approvals'
import * as bookings from '@/app/lib/repositories/bookings'
import * as employees from '@/app/lib/repositories/employees'
import { route } from '@/app/lib/http/handler'
import { NextRequest } from 'next/server'
import { amadeus, AmadeusError } from '@/app/lib/amadeus/client'
import { extractPricingDetails } from '@/app/api/book/price/route'
import { priceAgain } from '@/app/lib/book/repriceBooking'
import { travellerFareBreakdown } from '@/app/lib/book/travellerView'

// ── POST /api/approvals/[approvalId]/refresh-fare ────────────────────────
// A pending approval can sit for hours (see the 10-hour "urgent" badge) —
// long enough that the priced fare shown to the approver may no longer be
// real: the fare could have changed, sold out, or moved in or out of
// policy. This lets the assigned approver re-price the booking on demand,
// right before deciding, rather than discovering a stale price only when
// the employee tries to confirm with the airline much later.
//
// Per product decision: a refresh is NOT just a preview — it becomes the
// new official price/key for this booking (bookings.total_cost,
// amadeus_key, policy_verdict all get overwritten with the fresh values),
// so whatever the approver acts on is also what eventually gets booked.
// Also per product decision: if the refreshed verdict would actually need
// a different/stricter approval tier, that's NOT auto-detected here — the
// currently-assigned approver just sees the new number and decides
// themselves, same as before.
// ─────────────────────────────────────────────────────────────────────────────

export const POST = route(async (
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
    return Response.json({ error: `This approval has already been ${approval.status} — nothing to refresh` }, { status: 409 })
  }

  // A trip's sign-off has no fare of its own: its flights were priced, and
  // approved if they needed it, when they were booked.
  if (!approval.booking_id) {
    return Response.json({ error: 'Only a booking’s approval has a fare to refresh' }, { status: 409 })
  }

  const booking = await bookings.refreshTarget(db, approval.booking_id)

  if (!booking) {
    return Response.json({ error: 'Booking not found' }, { status: 404 })
  }

  if (booking.status !== 'pending_approval') {
    return Response.json({ error: `This booking is ${booking.status}, not pending approval — nothing to refresh` }, { status: 409 })
  }

  if (!booking.search_key || !booking.pricing_key || !booking.result_index || !booking.provider) {
    return Response.json({
      error: 'This booking is missing the data needed to re-price it. Approve or reject based on the last known fare, or ask the traveler to re-search.',
    }, { status: 422 })
  }

  try {
    const freshPricing = await amadeus.pricing(
      booking.search_key,
      booking.pricing_key,
      booking.provider,
      booking.result_index
    )

    const details = extractPricingDetails(freshPricing)

    if (!details) {
      return Response.json({ error: 'Pricing succeeded but returned no fare details. Please try again.' }, { status: 502 })
    }

    // The fresh price becomes the booking's official one: commercials and
    // policy again, on the sell total (app/lib/book/repriceBooking.ts).
    const repriced = await priceAgain(db, booking, details)
    const { sellTotal: newSellTotal, reason } = repriced
    const policyVerdict = repriced.verdict

    let updated: bookings.RefreshedBooking
    try {
      updated = await bookings.applyRefreshedFare(db, booking.id, repriced.fare)
    } catch (updateError) {
      console.error('Refreshed fare successfully but failed to save it to the booking', updateError, { bookingId: booking.id })
      return Response.json({ error: 'Got a fresh price but could not save it — please try again.' }, { status: 500 })
    }

    // Also refresh the approval row's own cached verdict/reason so the
    // approvals list (and history, once decided) reflects what was
    // actually acted on, not the stale value from when this approval was
    // first created.
    try {
      await approvals.setVerdict(db, approvalId, policyVerdict, reason)
    } catch (approvalUpdateError) {
      console.error('Refreshed fare but failed to update the approval row\'s cached verdict', approvalUpdateError, { approvalId })
    }

    // THE SELL SIDE ONLY. The approver is an ordinary employee, and the queue
    // already shows them the sell total; answering a refresh with total_cost
    // (the airline figure) and the airline's per-passenger split put the
    // markup one subtraction away in the network response.
    return Response.json({
      ok: true,
      totalCost: newSellTotal,
      policyVerdict: updated.policy_verdict,
      policyVerdictDetail: updated.policy_verdict_detail,
      fareBreakdown: travellerFareBreakdown(updated.fare_breakdown),
      reason,
    })
  } catch (err) {
    if (err instanceof AmadeusError) {
      console.error('Refresh-fare Pricing call failed', { requestId: err.requestId, message: err.message })
      const isStale = /session/i.test(err.message)
      return Response.json({
        error: isStale
          ? 'This search has expired and can no longer be re-priced. The traveler will need to search again.'
          : 'Could not get a fresh price for this fare — it may no longer be available.',
        code: isStale ? 'SEARCH_EXPIRED' : undefined,
      }, { status: 502 })
    }
    console.error('Unexpected error refreshing fare', err)
    return Response.json({ error: 'Something went wrong refreshing this fare. Please try again.' }, { status: 500 })
  }
})
