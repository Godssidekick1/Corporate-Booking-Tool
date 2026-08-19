import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { amadeus, AmadeusError, sanitizeAmadeusDiagnostic, CustomerInfo } from '@/app/lib/amadeus/client'
import { NextRequest } from 'next/server'
import { checkBookingAgainstPolicy } from '@/app/lib/rule-engine/checkBookingAgainstPolicy'
import { buildPolicyInputsFromFlight } from '@/app/lib/rule-engine/buildPolicyInputs'
import { startApprovalForBooking, buildReason } from '@/app/lib/approval-engine/resolveApprovalTier'
import type { FlatFlightResult } from '@/app/lib/book/types'

// ── POST /api/book/add-passenger ─────────────────────────────────────────────
// Third step in the booking chain (search → price → add-passenger → book →
// ticket). This is where a `bookings` row is first created — everything
// before this point (search results, pricing) lives only in the frontend's
// state, since nothing has committed yet.
//
// employeeId here books for themself (employee_id == requested_for) — no
// book-on-behalf support yet, matching how /book/search and /book/price
// already work.
//
// Policy + Approval Engine: right after the bookings row is inserted, we run
// checkBookingAgainstPolicy to get a verdict (green/amber/red), then hand
// that to startApprovalForBooking to see whether the employee's assigned
// approval_chain requires a human tier before Book (/api/book/booking) is
// allowed to fire. The booking lands in one of:
//   - 'approved'         — no chain assigned, or the verdict didn't meet any
//                          tier's threshold. Employee can call Book right away.
//   - 'pending_approval' — a tier-1 approvals row was created; employee must
//                          wait for approver_id to act before Book is allowed.
// /api/book/booking's gate (status must be 'approved') enforces this
// server-side regardless of what the frontend does.
// ─────────────────────────────────────────────────────────────────────────────

interface AddPassengerBody {
  // Carried forward from /book/price and the original search result —
  // the frontend is the source of truth for these until this call succeeds.
  key: string              // Key from the Pricing response (/api/book/price) — a
                            // distinct UUID, NOT the search result's FlightKey.
                            // Each step (Availability -> Pricing -> AddPassenger)
                            // hands back its own Key for the next step to use;
                            // they are never the same value.
  pricingKey: string
  provider: string
  resultIndex: string      // ResultIndex from /book/price — needed later to
                            // silently re-run Pricing if this booking's
                            // amadeus_key/session has expired by the time
                            // approval comes through and Booking is called.
  referenceNo: string      // ReferenceNo from /book/price
  totalFare: number        // Grand total from /book/details — priced fare
                            // PLUS any seat selection fees, already summed
                            // client-side. Becomes bookings.total_cost, and
                            // is what's actually charged/policy-checked.
  seatFees?: number        // Just the seat-fee portion of totalFare above,
                            // kept separately so the fare breakdown can
                            // show it as its own line item rather than
                            // silently folding it into a bigger fare number.
  currency: string
  isRefundable: boolean
  fareType: string
  passengerBreakup: unknown
  isNdc?: boolean
  searchKey?: string       // availabilityKey from /book/search, for traceability only
  tripId?: string          // trip this booking belongs to, if started from a trip's workspace
  itinerary: unknown       // the FlatFlightResult the traveler selected, for bookings.itinerary

  // Passenger details for this booking
  customerInfo: CustomerInfo
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const service = createServiceClient()
  const { data: employee } = await service
    .from('employees')
    .select('id, company_id')
    .eq('id', user.id)
    .maybeSingle()

  if (!employee) {
    return Response.json({ error: 'Employee record not found' }, { status: 404 })
  }

  const body: AddPassengerBody = await req.json()
  const {
    key, pricingKey, provider, resultIndex, referenceNo, totalFare, seatFees, currency, isRefundable, fareType,
    passengerBreakup, isNdc, searchKey, tripId, itinerary, customerInfo,
  } = body

  if (!key || !pricingKey || !provider || !referenceNo || totalFare === undefined) {
    return Response.json(
      { error: 'key, pricingKey, provider, referenceNo, and totalFare are required' },
      { status: 400 }
    )
  }

  if (!customerInfo?.PassengerDetails?.length) {
    return Response.json({ error: 'customerInfo.PassengerDetails must include at least one passenger' }, { status: 400 })
  }

  // If this booking is being made under a trip, confirm the trip actually
  // belongs to this employee before tagging the booking with it — otherwise
  // a crafted tripId could attach a booking (and its cost) to someone else's
  // trip.
  if (tripId) {
    const { data: trip } = await service
      .from('trips')
      .select('id, created_by')
      .eq('id', tripId)
      .maybeSingle()

    if (!trip || trip.created_by !== employee.id) {
      return Response.json({ error: 'Trip not found or not owned by you' }, { status: 403 })
    }
  }

  try {
    const result = await amadeus.addPassenger(
      key,
      referenceNo,
      customerInfo,
      String(totalFare),
      String(totalFare),
      String(seatFees ?? 0)
    )

    // Run the Rule Engine BEFORE inserting, so the verdict can be written in
    // the same insert rather than a follow-up update. checkBookingAgainstPolicy
    // never throws for a normal policy pass/fail — only a missing/unconfigured
    // policy comes back as ok:false, which we treat as "not evaluated" rather
    // than blocking the booking outright (a TMC config gap shouldn't strand
    // an employee mid-flow).
    const flight = itinerary as FlatFlightResult | undefined
    let policyStatus = 'not_evaluated'
    let policyVerdict: string | null = null
    let policyVerdictDetail: unknown = null
    let reason = 'Policy could not be evaluated for this booking.'
    // Needed later for startApprovalForBooking's chain lookup (chains are
    // scoped by band + travel_type) — declared here so it's in scope
    // outside the `if (flight)` block below. Falls back to
    // 'flight_domestic' if itinerary is somehow missing, since chains still
    // need SOME travel_type to look up against; a missing itinerary is
    // already an edge case checkBookingAgainstPolicy can't evaluate either.
    let travelTypeForApproval: string = 'flight_domestic'

    if (flight) {
      // customerInfo.PassengerDetails[].SeatListDetails is the final, real
      // seat selection at submit time (flat array per passenger, already
      // stripped of legIndex by the frontend — see toSeatListDetails in the
      // details page). Flattened across all passengers here since only the
      // total fee matters for max_seat_selection_fee.
      const selectedSeatFees = customerInfo.PassengerDetails
        .flatMap(p => p.SeatListDetails ?? [])
        .map(seat => seat.SeatFee)

      const inputs = buildPolicyInputsFromFlight({ flight, totalFare, isRefundable, selectedSeatFees })
      travelTypeForApproval = inputs.travelType
      const ruleResult = await checkBookingAgainstPolicy(service, {
        employeeId: employee.id,
        travelType: inputs.travelType,
        totalCost: inputs.totalCost,
        numericValues: inputs.numericValues,
        booleanValues: inputs.booleanValues,
        tierValues: inputs.tierValues,
      })

      if (ruleResult.ok) {
        policyStatus = 'evaluated'
        policyVerdict = ruleResult.verdict
        policyVerdictDetail = { breaches: ruleResult.breaches, costTier: ruleResult.costTier }
        reason = buildReason(ruleResult.breaches, ruleResult.costTier, totalFare)
      } else {
        // no_policy_group / no_policy_rules — leave policyStatus as
        // 'not_evaluated', but still let the booking proceed to the
        // approval step below, which will find no chain outcome to route to
        // and fall back to auto-approved. This matches checkBookingAgainstPolicy's
        // own doc comment: an unconfigured policy blocks Rule Engine feedback,
        // never the booking itself.
        reason = ruleResult.message
      }
    }

    // Insert immediately after a successful AddPassenger call — this is the
    // first point in the flow where we have a real ReferenceNo tied to real
    // passenger data, so it's the right moment to start persisting state.
    // Booking/Ticket steps update this same row rather than inserting again.
    const { data: booking, error: insertError } = await service
      .from('bookings')
      .insert({
        company_id: employee.company_id,
        employee_id: employee.id,
        requested_for: employee.id,
        booking_type: 'flight',
        status: 'pending_approval',
        total_cost: totalFare,
        provider,
        provider_order_id: referenceNo,
        amadeus_key: key,
        pricing_key: pricingKey,
        result_index: resultIndex ?? null,
        search_key: searchKey ?? null,
        trip_id: tripId ?? null,
        is_ndc: isNdc ?? null,
        itinerary: itinerary ?? null,
        traveler_snapshot: customerInfo,
        fare_breakdown: { currency, isRefundable, fareType, passengerBreakup, seatFees: seatFees ?? 0 },
        policy_status: policyStatus,
        policy_verdict: policyVerdict,
        policy_verdict_detail: policyVerdictDetail,
      })
      .select('id')
      .single()

    if (insertError || !booking) {
      console.error('Failed to persist booking after AddPassenger', insertError)
      return Response.json({
        ok: false,
        error: 'Passenger details were accepted by the airline system, but we could not save this booking. Please contact support with reference ' + referenceNo,
      }, { status: 500 })
    }

    // Resolve whether a human approval tier is required. If not, flip the
    // booking straight to 'approved' so /api/book/booking's gate lets it
    // through immediately. requiresApproval is false for three distinct
    // reasons, all handled the same way here: no chain configured for this
    // band/travel_type, the verdict didn't meet any tier's min_verdict
    // threshold, or the first eligible tier was approver_type 'self' (band
    // exempt from approval — startApprovalForBooking already logged that
    // as its own approvals row with status 'approved').
    let finalStatus = 'pending_approval'
    try {
      const outcome = await startApprovalForBooking(service, {
        bookingId: booking.id,
        companyId: employee.company_id,
        employeeId: employee.id,
        travelType: travelTypeForApproval,
        verdict: (policyVerdict as 'green' | 'amber' | 'red') ?? 'green',
        reason,
      })

      if (!outcome.requiresApproval) {
        finalStatus = 'approved'
        await service.from('bookings').update({ status: 'approved' }).eq('id', booking.id)
      } else if (!outcome.approverId) {
        // Chain exists but couldn't resolve a real approver (no manager_id
        // set, or no finance-role employee in the company). Surface this as
        // its own status rather than silently stalling in 'pending_approval'
        // with no approvals row ever created for anyone to act on.
        finalStatus = 'approval_misconfigured'
        await service.from('bookings').update({ status: 'approval_misconfigured' }).eq('id', booking.id)
      }
    } catch (approvalErr) {
      console.error('Approval chain resolution failed after booking insert', approvalErr)
      // Booking row already exists at 'pending_approval' — fail safe by
      // leaving it there rather than auto-approving on an internal error.
    }

    return Response.json({
      ok: true,
      bookingId: booking.id,
      referenceNo: result.ReferenceNo,
      status: finalStatus,
      policyVerdict,
      policyVerdictDetail,
    })
  } catch (err) {
    if (err instanceof AmadeusError) {
      console.error('AddPassenger error', {
        requestId: err.requestId,
        code: err.code,
        category: err.category,
        request: sanitizeAmadeusDiagnostic(err.requestBody),
        raw: sanitizeAmadeusDiagnostic(err.raw),
      })
      return Response.json({
        error: err.message,
        requestId: err.requestId,
        details: sanitizeAmadeusDiagnostic(err.raw),
      }, { status: 502 })
    }

    console.error('AddPassenger error:', err)
    return Response.json({ error: 'Could not add passenger details' }, { status: 500 })
  }
}