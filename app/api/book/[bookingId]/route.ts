import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { amadeus, AmadeusError, sanitizeAmadeusDiagnostic, CustomerInfo } from '@/app/lib/amadeus/client'
import { NextRequest } from 'next/server'

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

  const { data: booking } = await service
    .from('bookings')
    .select('*')
    .eq('id', bookingId)
    .maybeSingle()

  if (!booking) {
    return Response.json({ error: 'Booking not found' }, { status: 404 })
  }

  if (booking.employee_id !== employee.id) {
    return Response.json({ error: 'Not authorized to view this booking' }, { status: 403 })
  }

  return Response.json({ ok: true, booking })
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