import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { amadeus, AmadeusError, sanitizeAmadeusDiagnostic, CustomerInfo } from '@/app/lib/amadeus/client'
import { NextRequest } from 'next/server'

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
// Policy enforcement (Rule Engine) is intentionally NOT wired in here yet —
// policy_status / policy_verdict / policy_verdict_detail are left null.
// checkBookingAgainstPolicy(service, {...}) is the hook to call once that's
// ready; this route only persists booking data for now.
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
  referenceNo: string      // ReferenceNo from /book/price
  totalFare: number        // TotalFare from /book/price — becomes bookings.total_cost
  currency: string
  isRefundable: boolean
  fareType: string
  passengerBreakup: unknown
  isNdc?: boolean
  searchKey?: string       // availabilityKey from /book/search, for traceability only
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
    key, pricingKey, provider, referenceNo, totalFare, currency, isRefundable, fareType,
    passengerBreakup, isNdc, searchKey, itinerary, customerInfo,
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

  try {
    const result = await amadeus.addPassenger(
      key,
      referenceNo,
      customerInfo,
      String(totalFare),
      String(totalFare)
    )

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
        status: 'passenger_added',
        total_cost: totalFare,
        provider,
        provider_order_id: referenceNo,
        amadeus_key: key,
        pricing_key: pricingKey,
        search_key: searchKey ?? null,
        is_ndc: isNdc ?? null,
        itinerary: itinerary ?? null,
        traveler_snapshot: customerInfo,
        fare_breakdown: { currency, isRefundable, fareType, passengerBreakup },
        policy_status: 'not_evaluated', // Rule Engine not wired in here yet — see comment above. Column is NOT NULL, so this is a truthful placeholder, not a real verdict.
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

    return Response.json({
      ok: true,
      bookingId: booking.id,
      referenceNo: result.ReferenceNo,
      status: 'passenger_added',
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