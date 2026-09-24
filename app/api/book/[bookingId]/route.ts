import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { amadeus, AmadeusError, sanitizeAmadeusDiagnostic, CustomerInfo } from '@/app/lib/amadeus/client'
import { visibleLines, ADJUSTMENT_LABELS } from '@/app/lib/commercials/adjustment'
import { round2 } from '@/app/lib/commercials/fareComponents'
import type { CommercialsRecord } from '@/app/lib/commercials/composeSellPrice'
import { travellerItinerary, travellerFareBreakdown } from '@/app/lib/book/travellerView'
import { NextRequest } from 'next/server'

// One passenger's fare, as frozen on bookings.fare_breakdown.
interface PaxFare {
  PaxType: string
  BaseFare: number
  Tax: number
  TotalFare: number
}

// ── GET /api/book/[bookingId] ─────────────────────────────────────────────────
// Fetches a single booking row. Added alongside the confirm/ticket pages,
// which need to load booking state from a URL (bookingId) rather than
// carrying it through sessionStorage the way earlier steps do — once a row
// exists, the database is the source of truth.
//
// ── PATCH /api/book/[bookingId] ───────────────────────────────────────────────
// Corrects passenger/contact details on a booking that hasn't been booked
// with the airline yet. Valid while status is 'pending_approval' or
// 'approved' — the window between AddPassengerDetails (registers passenger
// data against the priced session) and Booking (which actually creates the
// PNR). Since no PNR exists yet at this stage, re-calling AddPassengerDetails
// with corrected data on the same Key/ReferenceNo is the correct way to fix
// a typo — not a modification to a live reservation. Never re-runs pricing;
// fare/itinerary are untouched by this endpoint.
// ─────────────────────────────────────────────────────────────────────────────

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ bookingId: string }> }
) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const { bookingId } = await params

  const service = createServiceClient()
  const { data: employee } = await service
    .from('employees')
    .select('id')
    .eq('id', user.id)
    .maybeSingle()

  if (!employee) {
    return Response.json({ error: 'Employee record not found' }, { status: 404 })
  }

  // An explicit column list, not `*`.
  //
  // `*` shipped the whole row and stripped only `commercials`, which was not
  // enough: `total_cost` is the AIRLINE's grand total, and with it in the
  // response the markup is one subtraction away —
  //   sell_total − total_cost − (processing fee − discount) = markup
  // — with no need to look at anything else. Removing `commercials` while
  // leaving `total_cost` beside it hid the label and published the number.
  //
  // The operational columns went the same way for the same reason: amadeus_key,
  // pricing_key, result_index and search_key are provider session credentials,
  // and client_id is tenancy. None of them has any business in a browser.
  //
  // Kept as a literal string so PostgREST's type inference survives — a
  // concatenation collapses to `string` and every property access below
  // becomes a GenericStringError.
  const { data: booking } = await service
    .from('bookings')
    .select('id, status, booking_type, provider, provider_order_id, pnr, ticket_numbers, sell_total, total_cost, commercials, itinerary, traveler_snapshot, fare_breakdown, policy_status, policy_verdict, policy_verdict_detail, employee_id, trip_id, is_ndc, created_at, updated_at')
    .eq('id', bookingId)
    .maybeSingle()

  if (!booking) {
    return Response.json({ error: 'Booking not found' }, { status: 404 })
  }

  if (booking.employee_id !== employee.id) {
    return Response.json({ error: 'Not authorized to view this booking' }, { status: 403 })
  }

  // Most recent approval action on this booking — drives the "waiting for
  // approval from X" / rejection-note UI on the confirm page. Ordered by
  // tier descending: for a multi-tier chain the traveler cares about
  // whichever tier is currently active (pending) or was decided last, not
  // the first tier that happened to be created first.
  const { data: latestApprovalRow } = await service
    .from('approvals')
    .select('id, tier, status, reason, decision_note, approver_id')
    .eq('booking_id', bookingId)
    .order('tier', { ascending: false })
    .limit(1)
    .maybeSingle()

  let latestApproval = null

  if (latestApprovalRow) {
    let approverName: string | null = null

    if (latestApprovalRow.approver_id) {
      const { data: approver } = await service
        .from('employees')
        .select('full_name')
        .eq('id', latestApprovalRow.approver_id)
        .maybeSingle()

      approverName = approver?.full_name ?? null
    }

    latestApproval = {
      id: latestApprovalRow.id,
      tier: latestApprovalRow.tier,
      status: latestApprovalRow.status,
      reason: latestApprovalRow.reason,
      decision_note: latestApprovalRow.decision_note,
      approverName,
    }
  }

  // ── Strip the commercial detail ────────────────────────────────────────────
  // The select above is `*`, which now picks up `commercials` — and that object
  // carries the markup amount, the airline's own total and every rule id behind
  // them. None of it may reach a traveller: a markup that is discoverable in a
  // network response is not hidden, whatever the UI renders.
  //
  // Removed and replaced with the lines they ARE allowed to see. Sending the
  // whole object and hiding it in the UI is not the same thing and is not good
  // enough.
  // total_cost comes out with commercials. It is the airline's own grand total
  // and it is the other half of the subtraction that reveals the markup.
  const { commercials, total_cost, ...safeBooking } = booking as typeof booking & {
    commercials: CommercialsRecord | null
  }

  const sellTotal = booking.sell_total ?? total_cost ?? 0
  const seatFees = (booking.fare_breakdown as { seatFees?: number } | null)?.seatFees ?? 0

  // ── The sell-side fare breakdown ───────────────────────────────────────────
  // Base and taxes as the TRAVELLER's numbers, so the confirm page can show a
  // breakdown that adds up without ever holding an airline figure.
  //
  // The markup rides on the base, exactly as it does at search: base + taxes
  // then equals displayedFare, and displayedFare − discount + fee + seat fees
  // equals sell_total. Every line on the page comes from this object.
  //
  // Taxes are the SUM OF taxLines, which is also fuelSurcharge + otherTax —
  // verified against a real payload where base 10314 + fuel 1098 + otherTax
  // 2144 = fare 13556, and YQ 1098 + K3 588 + OT 1556 = 3242 = fuel + otherTax.
  // `otherTax` alone is NOT the tax total; the fuel surcharge is a sibling field.
  const airline = commercials?.airline
  const markup = airline ? round2(commercials!.displayedFare - airline.total) : 0
  const taxTotal = airline
    ? round2(
        (airline.taxLines ?? []).reduce((sum: number, t: { amount: number }) => sum + t.amount, 0)
        || airline.otherTax + airline.fuelSurcharge
      )
    : null

  const fare = commercials
    ? {
        base: round2(airline!.base + markup),
        taxTotal,
        // Codes and amounts only. A tax code is the airline's, not ours, and
        // reveals nothing about what we added — provided base already carries
        // the markup, which is the whole point of computing it above.
        taxLines: airline!.taxLines,
        // displayedFare: the "Fare" line. base + taxTotal by construction.
        fare: commercials.displayedFare,
      }
    : null

  // Per-pax rows, scaled onto the sell side.
  //
  // fare_breakdown.passengerBreakup holds the AIRLINE per-pax figures, written
  // verbatim from the browser at add-passenger. Rendering those beneath a
  // marked-up Fare line published the markup on screen — Fare − Σ(pax total) —
  // and made the rows fail to sum to the total they sat above.
  //
  // Apportioned by each passenger's share of the airline fare, with the
  // remainder pushed onto the last row so the parts sum EXACTLY to the whole.
  // The per-pax split is presentational; apportioning it is honest, and a row
  // that does not add up is not.
  const rawBreakup = (booking.fare_breakdown as { passengerBreakup?: PaxFare[] } | null)?.passengerBreakup ?? []
  const airlineFareTotal = rawBreakup.reduce((sum, p) => sum + (p.TotalFare ?? 0), 0)
  const passengerBreakup = rawBreakup.map((pax, i) => {
    if (!markup || airlineFareTotal <= 0) return pax
    const isLast = i === rawBreakup.length - 1
    const share = isLast
      ? round2(markup - rawBreakup.slice(0, -1).reduce((sum, p) => sum + round2(markup * ((p.TotalFare ?? 0) / airlineFareTotal)), 0))
      : round2(markup * ((pax.TotalFare ?? 0) / airlineFareTotal))
    return {
      ...pax,
      BaseFare: round2((pax.BaseFare ?? 0) + share),
      TotalFare: round2((pax.TotalFare ?? 0) + share),
    }
  })

  return Response.json({
    ok: true,
    booking: {
      ...safeBooking,
      // What the corporate is invoiced. Falls back to the airline figure for
      // bookings made before commercial rules existed — on those the two are
      // the same number, so nothing is revealed by the fallback.
      sell_total: sellTotal,
      // Projected: the frozen itinerary carries the airline's fares, and the
      // stored breakdown its per-passenger split -- replaced here by the
      // sell-side rows computed above. See app/lib/book/travellerView.
      itinerary: travellerItinerary(booking.itinerary),
      fare_breakdown: {
        ...travellerFareBreakdown(booking.fare_breakdown),
        passengerBreakup,
      },
      // Base, taxes and the itemised tax codes. Null on pre-commercials
      // bookings, which have no frozen airline components to derive them from.
      fare,
      seat_fees: seatFees,
      // Discount and processing fee only. visibleLines() is what keeps the
      // embedded markup out — the filter lives there rather than here so the
      // rule is written once.
      commercial_lines: visibleLines(commercials?.adjustments ?? []).map(a => ({
        source: a.source,
        label: ADJUSTMENT_LABELS[a.source],
        sign: a.sign,
        amount: a.amount,
      })),
    },
    latestApproval,
  })
}

interface PatchBody {
  customerInfo: CustomerInfo
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ bookingId: string }> }
) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const { bookingId } = await params

  const service = createServiceClient()
  const { data: employee } = await service
    .from('employees')
    .select('id')
    .eq('id', user.id)
    .maybeSingle()

  if (!employee) {
    return Response.json({ error: 'Employee record not found' }, { status: 404 })
  }

  const { data: booking } = await service
    .from('bookings')
    .select('id, employee_id, status, provider, provider_order_id, amadeus_key, total_cost')
    .eq('id', bookingId)
    .maybeSingle()

  if (!booking) {
    return Response.json({ error: 'Booking not found' }, { status: 404 })
  }

  if (booking.employee_id !== employee.id) {
    return Response.json({ error: 'Not authorized to edit this booking' }, { status: 403 })
  }

  // Editable any time before Book actually commits the PNR — that covers
  // both 'pending_approval' (still waiting on a human tier) and 'approved'
  // (cleared, but the employee hasn't clicked Confirm yet). Previously
  // gated on 'passenger_added', a status the approval-engine-aware
  // add-passenger/route.ts never writes, which made this endpoint
  // unreachable for every real booking.
  if (booking.status !== 'pending_approval' && booking.status !== 'approved') {
    return Response.json({
      error: 'This booking has already moved past the passenger details step and can no longer be edited here.',
    }, { status: 409 })
  }

  const { customerInfo }: PatchBody = await req.json()

  if (!customerInfo?.PassengerDetails?.length) {
    return Response.json({ error: 'customerInfo.PassengerDetails must include at least one passenger' }, { status: 400 })
  }

  try {
    await amadeus.addPassenger(
      booking.amadeus_key,
      booking.provider_order_id,
      customerInfo,
      String(booking.total_cost),
      String(booking.total_cost)
    )

    const { error: updateError } = await service
      .from('bookings')
      .update({ traveler_snapshot: customerInfo })
      .eq('id', bookingId)

    if (updateError) {
      console.error('Failed to persist corrected passenger details', updateError)
      return Response.json({
        error: 'The airline system accepted the correction, but we could not save it. Please try again.',
      }, { status: 500 })
    }

    return Response.json({ ok: true })
  } catch (err) {
    if (err instanceof AmadeusError) {
      console.error('AddPassenger (edit) error', {
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

    console.error('AddPassenger (edit) error:', err)
    return Response.json({ error: 'Could not save passenger details' }, { status: 500 })
  }
}