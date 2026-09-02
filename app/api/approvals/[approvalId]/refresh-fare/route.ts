import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { NextRequest } from 'next/server'
import { amadeus, AmadeusError } from '@/app/lib/amadeus/client'
import { extractPricingDetails } from '@/app/api/book/price/route'
import { checkBookingAgainstPolicy } from '@/app/lib/rule-engine/checkBookingAgainstPolicy'
import { buildPolicyInputsFromFlight } from '@/app/lib/rule-engine/buildPolicyInputs'
import { buildReason } from '@/app/lib/approval-engine/resolveApprovalTier'

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

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ approvalId: string }> }
) {
  const { approvalId } = await params
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const service = createServiceClient()
  const { data: caller } = await service
    .from('employees')
    .select('id, client_id')
    .eq('id', user.id)
    .maybeSingle()

  if (!caller) {
    return Response.json({ error: 'Employee record not found' }, { status: 404 })
  }

  const { data: approval } = await service
    .from('approvals')
    .select('id, booking_id, approver_id, status')
    .eq('id', approvalId)
    .maybeSingle()

  if (!approval) {
    return Response.json({ error: 'Approval not found' }, { status: 404 })
  }

  if (approval.approver_id !== caller.id) {
    return Response.json({ error: 'You are not the assigned approver for this request' }, { status: 403 })
  }

  if (approval.status !== 'pending') {
    return Response.json({ error: `This approval has already been ${approval.status} — nothing to refresh` }, { status: 409 })
  }

  const { data: booking } = await service
    .from('bookings')
    .select('id, employee_id, status, provider, search_key, pricing_key, result_index, itinerary, fare_breakdown')
    .eq('id', approval.booking_id)
    .maybeSingle()

  if (!booking) {
    return Response.json({ error: 'Booking not found' }, { status: 404 })
  }

  if (booking.status !== 'pending_approval') {
    return Response.json({ error: `This booking is ${booking.status}, not pending approval — nothing to refresh` }, { status: 409 })
  }

  if (!booking.search_key || !booking.pricing_key || !booking.result_index) {
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

    // Seat fees were already chosen and paid for as part of this booking —
    // a re-price doesn't change what seats were selected, only the fare
    // itself, so carry the existing seat fee total forward into the new
    // grand total rather than dropping it.
    const existingSeatFees = (booking.fare_breakdown as { seatFees?: number } | null)?.seatFees ?? 0
    const newTotalFare = (details.totalFare ?? 0) + existingSeatFees

    const flight = booking.itinerary as Parameters<typeof buildPolicyInputsFromFlight>[0]['flight'] | null

    let policyVerdict: string | null = null
    let policyVerdictDetail: unknown = null
    let reason = 'Policy could not be re-evaluated for this booking.'

    if (flight) {
      const inputs = buildPolicyInputsFromFlight({
        flight,
        totalFare: newTotalFare,
        isRefundable: details.isRefundable ?? false,
        selectedSeatFees: existingSeatFees ? [String(existingSeatFees)] : [],
      })

      const ruleResult = await checkBookingAgainstPolicy(service, {
        employeeId: booking.employee_id,
        travelType: inputs.travelType,
        totalCost: inputs.totalCost,
        numericValues: inputs.numericValues,
        booleanValues: inputs.booleanValues,
        tierValues: inputs.tierValues,
      })

      if (ruleResult.ok) {
        policyVerdict = ruleResult.verdict
        policyVerdictDetail = { breaches: ruleResult.breaches, costTier: ruleResult.costTier }
        reason = buildReason(ruleResult.breaches, ruleResult.costTier, newTotalFare)
      } else {
        reason = ruleResult.message
      }
    }

    const { data: updated, error: updateError } = await service
      .from('bookings')
      .update({
        total_cost: newTotalFare,
        amadeus_key: details.key,
        policy_verdict: policyVerdict,
        policy_verdict_detail: policyVerdictDetail,
        fare_breakdown: {
          ...(booking.fare_breakdown as object ?? {}),
          currency: details.currency,
          isRefundable: details.isRefundable,
          fareType: details.fareType,
          passengerBreakup: details.passengerBreakup,
          seatFees: existingSeatFees,
        },
        updated_at: new Date().toISOString(),
      })
      .eq('id', booking.id)
      .select('id, total_cost, policy_verdict, policy_verdict_detail, fare_breakdown')
      .single()

    if (updateError || !updated) {
      console.error('Refreshed fare successfully but failed to save it to the booking', updateError, { bookingId: booking.id })
      return Response.json({ error: 'Got a fresh price but could not save it — please try again.' }, { status: 500 })
    }

    // Also refresh the approval row's own cached verdict/reason so the
    // approvals list (and history, once decided) reflects what was
    // actually acted on, not the stale value from when this approval was
    // first created.
    const { error: approvalUpdateError } = await service
      .from('approvals')
      .update({ verdict: policyVerdict, reason })
      .eq('id', approvalId)

    if (approvalUpdateError) {
      console.error('Refreshed fare but failed to update the approval row\'s cached verdict', approvalUpdateError, { approvalId })
    }

    return Response.json({
      ok: true,
      totalCost: updated.total_cost,
      policyVerdict: updated.policy_verdict,
      policyVerdictDetail: updated.policy_verdict_detail,
      fareBreakdown: updated.fare_breakdown,
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
}