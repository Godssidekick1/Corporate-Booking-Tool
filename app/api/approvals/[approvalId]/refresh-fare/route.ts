import { requireUser } from '@/app/lib/auth/session'
import { db } from '@/app/lib/db'
import * as approvals from '@/app/lib/repositories/approvals'
import * as bookings from '@/app/lib/repositories/bookings'
import * as employees from '@/app/lib/repositories/employees'
import * as audit from '@/app/lib/repositories/audit'
import { route } from '@/app/lib/http/handler'
import { NextRequest } from 'next/server'
import { amadeus, AmadeusError, type PricingResponse } from '@/app/lib/amadeus/client'
import { extractPricingDetails } from '@/app/api/book/price/route'
import { priceAgain } from '@/app/lib/book/repriceBooking'
import { refindFare } from '@/app/lib/book/refindFare'
import { failureKind, plainMessage } from '@/app/lib/book/providerErrors'
import { travellerFareBreakdown } from '@/app/lib/book/travellerView'

// ── POST /api/approvals/[approvalId]/refresh-fare ────────────────────────────
// The assigned approver gets today's price before deciding. A pending
// approval waits hours, far longer than a search's keys live (~25 min), so
// re-pricing with the booking's own keys mostly failed as "expired" (seen
// 2026-11-17). Now, when those keys are stale (or missing), the fare is found
// again in a fresh search (app/lib/book/refindFare.ts) and priced there.
//
// The fresh price becomes the booking's (commercials and policy again), and
// the answer says what changed:
//   continue                the approver decides on the new price (the
//                           fare is within policy, or within its grace)
//   returned_to_traveller   the fare rose AND is now out of policy beyond
//                           its grace: the approver does not decide on a
//                           price the traveller never asked for. The
//                           booking goes back to the traveller
//                           (reapproval_needed), the open steps close, and
//                           the traveller asks again with a reason or
//                           chooses another flight (user, 2026-11-17).
//   fare_gone / flight_gone no longer sold; nothing changes, the approver
//                           decides (usually: reject, see the ready note).
// Never the airline's figure: the approver is an ordinary employee.
// ─────────────────────────────────────────────────────────────────────────────

const inr = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`

export const POST = route(async (
  _req: NextRequest,
  { params }: { params: Promise<{ approvalId: string }> }
) => {
  const { approvalId } = await params
  const user = await requireUser()

  const caller = await employees.traveller(db, user.id)
  if (!caller) return Response.json({ error: 'Employee record not found' }, { status: 404 })

  const approval = await approvals.forDecision(db, approvalId)
  if (!approval) return Response.json({ error: 'Approval not found' }, { status: 404 })
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
  if (!booking) return Response.json({ error: 'Booking not found' }, { status: 404 })
  if (booking.status !== 'pending_approval') {
    return Response.json({ error: `This booking is ${booking.status}, not pending approval — nothing to refresh` }, { status: 409 })
  }

  const previousTotal = Number(booking.sell_total ?? booking.total_cost)

  // ── Today's price: the booking's own keys, else the fare found again ─────
  let pricing: PricingResponse | null = null
  let refound: { searchKey: string; pricingKey: string; resultIndex: string; provider: string } | null = null
  try {
    const haveKeys = !!(booking.search_key && booking.pricing_key && booking.result_index && booking.provider)
    if (haveKeys) {
      try {
        pricing = await amadeus.pricing(booking.search_key!, booking.pricing_key!, booking.provider!, booking.result_index!)
      } catch (err) {
        // Stale keys (the usual case after a long wait): found again below.
        if (!(err instanceof AmadeusError && (failureKind(err) === 'expired' || /session/i.test(err.message)))) throw err
      }
    }
    if (!pricing) {
      const again = await refindFare(booking)
      if (!again.found) {
        return Response.json({
          ok: true, outcome: again.reason, previousTotal,
          message: again.reason === 'flight_gone'
            ? 'This flight is no longer offered on that day. The booking can’t go ahead as it is: rejecting it lets the traveller choose another flight.'
            : 'This fare is no longer sold on this flight. The booking can’t go ahead as it is: rejecting it lets the traveller choose another fare.',
        })
      }
      pricing = again.pricing
      refound = { searchKey: again.searchKey, pricingKey: again.pricingKey, resultIndex: again.resultIndex, provider: again.provider }
    }
  } catch (err) {
    if (err instanceof AmadeusError) {
      console.error('[refresh-fare] could not get a fresh price', { requestId: err.requestId, message: err.message })
      return Response.json({ error: plainMessage(err, 'price') }, { status: 502 })
    }
    throw err
  }

  const details = extractPricingDetails(pricing)
  if (!details) {
    return Response.json({ error: 'The airline answered without a price for this fare. Please try again in a moment.' }, { status: 502 })
  }

  // The fresh price becomes the booking's official one: commercials and
  // policy again, on the sell total (app/lib/book/repriceBooking.ts).
  const repriced = await priceAgain(db, booking, details)
  const newTotal = repriced.sellTotal
  const change = newTotal > previousTotal + 0.5 ? 'up' : newTotal < previousTotal - 0.5 ? 'down' : 'same'

  let updated: bookings.RefreshedBooking
  try {
    updated = await bookings.applyRefreshedFare(db, booking.id, repriced.fare)
    if (refound) await bookings.applyRefoundKeys(db, booking.id, refound)
  } catch (updateError) {
    console.error('[refresh-fare] got a fresh price but could not save it', updateError, { bookingId: booking.id })
    return Response.json({ error: 'Got a fresh price but could not save it — please try again.' }, { status: 500 })
  }

  // ── Up, and now out of policy beyond its grace: back to the traveller ─────
  if (repriced.verdict === 'red' && change === 'up') {
    const note = `The fare rose from ${inr(previousTotal)} to ${inr(newTotal)} and is now outside the travel policy, so it went back to the traveller to ask for approval again.`
    await bookings.setStatus(db, booking.id, 'reapproval_needed')
    await approvals.supersedePendingForBooking(db, booking.id, note)
    try {
      await audit.append(db, {
        action: 'booking.returned_to_traveller', entityType: 'booking', entityId: booking.id, userId: user.id,
        clientId: booking.client_id,
        metadata: { previousTotal, newTotal, reason: repriced.reason, refound: !!refound },
      })
    } catch (auditError) {
      console.error('[refresh-fare] could not audit a booking sent back', auditError)
    }
    return Response.json({
      ok: true, outcome: 'returned_to_traveller', change, previousTotal, newTotal, totalCost: newTotal,
      policyVerdict: updated.policy_verdict, reason: repriced.reason,
      message: `The fare went up from ${inr(previousTotal)} to ${inr(newTotal)} and is now outside the traveller’s policy. It has gone back to them to ask for approval again or choose another flight; nothing is waiting for you.`,
    })
  }

  // The approval row's cached verdict and reason follow the price acted on.
  try {
    await approvals.setVerdict(db, approvalId, repriced.verdict, repriced.reason)
  } catch (approvalUpdateError) {
    console.error('[refresh-fare] refreshed the fare but could not update the approval row', approvalUpdateError, { approvalId })
  }

  // THE SELL SIDE ONLY: never the airline's figure or its per-passenger split.
  return Response.json({
    ok: true, outcome: 'continue', change, previousTotal, newTotal,
    totalCost: newTotal,
    policyVerdict: updated.policy_verdict,
    policyVerdictDetail: updated.policy_verdict_detail,
    fareBreakdown: travellerFareBreakdown(updated.fare_breakdown),
    reason: repriced.reason,
    message: change === 'same'
      ? `The fare is unchanged at ${inr(newTotal)}.`
      : `The fare went ${change} from ${inr(previousTotal)} to ${inr(newTotal)}${repriced.verdict === 'green' ? ' and is within policy' : repriced.verdict === 'amber' ? ' and needs approval (within the policy’s grace)' : ''}.`,
  })
})
