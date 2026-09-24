import { createClient } from '@/utils/supabase/server'
import { db } from '@/app/lib/db'
import { createServiceClient } from '@/utils/supabase/service'
import { amadeus, AmadeusError, sanitizeAmadeusDiagnostic, CustomerInfo } from '@/app/lib/amadeus/client'
import { NextRequest } from 'next/server'
import { checkBookingAgainstPolicy, type RuleEngineResult } from '@/app/lib/rule-engine/checkBookingAgainstPolicy'
import { buildPolicyInputsFromFlight } from '@/app/lib/rule-engine/buildPolicyInputs'
import { startApprovalForBooking, buildReason } from '@/app/lib/approval-engine/resolveApprovalTier'
import { stampDealCodes } from '@/app/lib/deal-codes/stampBooking'
import { stampFop } from '@/app/lib/fop/stampFop'
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
    .select('id, client_id')
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

  // ── The quote ──────────────────────────────────────────────────────────────
  // The browser is no longer the source of truth for price, and cannot be: with
  // markup embedded in the fare it holds an inflated figure, and sending that to
  // the airline would quote our own markup to them. The server persisted the
  // airline-side numbers at /api/book/price; this recovers them.
  //
  // `totalFare` still arrives in the body and is deliberately IGNORED for money.
  // It is left in the payload rather than removed so an older client does not
  // 400 mid-deploy, and so the log below can show when the two disagree — which
  // is exactly the signal that markup is working.
  const { data: quote } = await service
    .from('price_quotes')
    .select('airline_components, commercials, sell_total, employee_id')
    .eq('amadeus_key', key)
    .eq('reference_no', referenceNo)
    .maybeSingle()

  if (!quote || quote.employee_id !== employee.id) {
    // Refused rather than falling back to the browser's number. The fallback is
    // the bug: it would send a marked-up fare to the airline. Re-pricing is one
    // click and always correct.
    return Response.json({
      error: 'This price is no longer held. Please go back and price this flight again.',
      code: 'QUOTE_EXPIRED',
    }, { status: 409 })
  }

  const airlineComponents = quote.airline_components as { total?: number } | null
  const airlineTotal = Number(airlineComponents?.total ?? 0)
  const seatFeeTotal = Number(seatFees ?? 0)

  // What the airline is owed, and what the corporate is invoiced. Seat fees are
  // an airline charge, so they land on both sides unmarked-up.
  const airlineGrandTotal = airlineTotal + seatFeeTotal
  const sellGrandTotal = Number(quote.sell_total ?? airlineTotal) + seatFeeTotal

  if (Math.abs(Number(totalFare) - sellGrandTotal) > 1) {
    // Not an error — a search can be minutes old and rules are date-windowed.
    // Logged because a persistent gap means the two are computing differently.
    console.info('[add-passenger] browser total differs from the held quote', {
      browser: totalFare, quoted: sellGrandTotal,
    })
  }

  try {
    const result = await amadeus.addPassenger(
      key,
      referenceNo,
      customerInfo,
      // THE AIRLINE FIGURE, never the sell price. This is the line the whole
      // price_quotes table exists to make correct.
      String(airlineGrandTotal),
      String(airlineGrandTotal),
      String(seatFeeTotal)
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

      // Policy is checked against the SELL total — what the company actually
      // spends — not the airline figure. A markup the traveller cannot see is
      // still money leaving the corporate's budget, and a limit that ignored it
      // would approve trips the company never agreed to fund.
      const inputs = buildPolicyInputsFromFlight({
        flight, totalFare: sellGrandTotal, isRefundable, selectedSeatFees,
      })
      travelTypeForApproval = inputs.travelType

      // The passenger has ALREADY reached the airline at this point. A failure
      // to check policy must not escape to the catch below, which would answer
      // with a generic error and never write the booking row -- stranding the
      // passenger at the airline with no record on our side. Treated as "not
      // evaluated", exactly as an unconfigured policy is.
      let ruleResult: RuleEngineResult | null = null
      try {
        ruleResult = await checkBookingAgainstPolicy(db, {
          employeeId: employee.id,
          travelType: inputs.travelType,
          totalCost: inputs.totalCost,
          numericValues: inputs.numericValues,
          booleanValues: inputs.booleanValues,
          tierValues: inputs.tierValues,
        })
      } catch (policyErr) {
        console.error('[add-passenger] policy check failed; booking recorded as not evaluated', policyErr)
      }

      if (!ruleResult) {
        // Left as 'not_evaluated' with the default reason.
      } else if (ruleResult.ok) {
        policyStatus = 'evaluated'
        policyVerdict = ruleResult.verdict
        policyVerdictDetail = { breaches: ruleResult.breaches, costTier: ruleResult.costTier }
        reason = buildReason(ruleResult.breaches, ruleResult.costTier, sellGrandTotal)
      } else {
        // no_band / no_policy_group / overlapping_policy_groups /
        // no_policy_rules — leave policyStatus as 'not_evaluated', but
        // still let the booking proceed to the approval step below, which
        // will find no chain outcome to route to and fall back to
        // auto-approved. This matches checkBookingAgainstPolicy's own doc
        // comment: an unconfigured policy blocks Rule Engine feedback,
        // never the booking itself.
        reason = ruleResult.message
      }
    }

    // Which negotiated codes applied, frozen at booking time. Never throws and
    // never blocks: deal codes are advisory today, since the aggregator API has
    // no field to carry one. Recorded so a counsellor can key it into the GDS
    // and finance can reconcile the rate.
    // Both are advisory and neither can block: the aggregator has no field for
    // a tour code, and its Payment object's contract is undocumented. Resolved
    // in parallel since neither depends on the other.
    const [resolvedDealCodes, resolvedFop] = await Promise.all([
      stampDealCodes(db, employee.client_id, flight ?? null),
      stampFop(db, employee.client_id, flight ?? null),
    ])

    // Insert immediately after a successful AddPassenger call — this is the
    // first point in the flow where we have a real ReferenceNo tied to real
    // passenger data, so it's the right moment to start persisting state.
    // Booking/Ticket steps update this same row rather than inserting again.
    const { data: booking, error: insertError } = await service
      .from('bookings')
      .insert({
        resolved_deal_codes: resolvedDealCodes,
        resolved_fop: resolvedFop,
        client_id: employee.client_id,
        employee_id: employee.id,
        requested_for: employee.id,
        booking_type: 'flight',
        status: 'pending_approval',
        // total_cost keeps its existing meaning — what the AIRLINE charges — so
        // /api/tmc/stats and every other reader of it stay correct. sell_total
        // is the new number: what the corporate is invoiced.
        total_cost: airlineGrandTotal,
        sell_total: sellGrandTotal,
        commercials: quote.commercials,
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
      // The airline has the passenger data and we do not have a booking row.
      // This is the only failure in the flow where the two sides disagree about
      // whether something happened, and the reference number is the only thread
      // back to it — so it is returned as its own field rather than buried in a
      // sentence the UI renders as one line of red text, and the client gives
      // it a screen of its own.
      console.error('Failed to persist booking after AddPassenger', insertError, { referenceNo })
      return Response.json({
        ok: false,
        code: 'ORPHANED_PNR',
        referenceNo,
        error:
          'Your passenger details reached the airline, but we could not save the booking on our side. ' +
          'Nothing has been ticketed and you have not been charged. Please quote the reference below to your travel desk.',
      }, { status: 500 })
    }

    // Resolve whether a human approval tier is required. If not, flip the
    // booking straight to 'approved' so /api/book/booking's gate lets it
    // through immediately. requiresApproval is false for three distinct
    // reasons, all handled the same way here: no chain assigned to this
    // employee for this category, the verdict didn't meet any tier's
    // min_verdict threshold, or the first eligible tier was approver_type
    // 'self' (exempt from approval — startApprovalForBooking already
    // logged that as its own approvals row with status 'approved').
    let finalStatus = 'pending_approval'
    try {
      const outcome = await startApprovalForBooking(service, {
        bookingId: booking.id,
        clientId: employee.client_id,
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
        // set, or no finance-role employee in the client). Surface this as
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