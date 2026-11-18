import { requireUser } from '@/app/lib/auth/session'
import { db } from '@/app/lib/db'
import * as approvals from '@/app/lib/repositories/approvals'
import * as bookings from '@/app/lib/repositories/bookings'
import * as employees from '@/app/lib/repositories/employees'
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
// The fresh price becomes the booking's (commercials and policy again). The
// approver always decides on it (user, 2026-11-18): a refresh never sends a
// booking back to the traveller, whatever the price or verdict. The answer
// says what changed:
//   continue                the new price and verdict, how much it moved
//                           since approval was asked for (requested_total),
//                           and since this refresh's previous price
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

  // The approval row's cached verdict and reason follow the price acted on.
  try {
    await approvals.setVerdict(db, approvalId, repriced.verdict, repriced.reason)
  } catch (approvalUpdateError) {
    console.error('[refresh-fare] refreshed the fare but could not update the approval row', approvalUpdateError, { approvalId })
  }

  // Since approval was asked for: what the approver weighs.
  const requested = Number(booking.requested_total ?? previousTotal)
  const sinceRequest = Math.round((newTotal - requested) * 100) / 100
  const percent = requested > 0 ? Math.round((sinceRequest / requested) * 1000) / 10 : null
  const policyWords = repriced.verdict === 'green' ? ' It is within policy.'
    : repriced.verdict === 'amber' ? ' It is within the policy’s grace and needs approval.'
    : repriced.verdict === 'red' ? ' It is outside the traveller’s policy.' : ''

  // THE SELL SIDE ONLY: never the airline's figure or its per-passenger split.
  return Response.json({
    ok: true, outcome: 'continue', change, previousTotal, newTotal,
    totalCost: newTotal,
    requestedTotal: requested,
    sinceRequest: { amount: sinceRequest, percent },
    policyVerdict: updated.policy_verdict,
    policyVerdictDetail: updated.policy_verdict_detail,
    fareBreakdown: travellerFareBreakdown(updated.fare_breakdown),
    reason: repriced.reason,
    message: (Math.abs(sinceRequest) < 0.5
      ? `The fare is unchanged at ${inr(newTotal)}.`
      : `The fare is now ${inr(newTotal)}, ${sinceRequest > 0 ? 'up' : 'down'} ${inr(Math.abs(sinceRequest))}${percent != null ? ` (${Math.abs(percent)}%)` : ''} from ${inr(requested)} when approval was asked for.`) + policyWords,
  })
})
