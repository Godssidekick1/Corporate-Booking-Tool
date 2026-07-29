import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { amadeus, AmadeusError, sanitizeAmadeusDiagnostic } from '@/app/lib/amadeus/client'
import { NextRequest } from 'next/server'

// ── POST /api/book/book ───────────────────────────────────────────────────────
// Fourth step (search → price → add-passenger → book → ticket). Commits the
// booking with the airline. BookingResponse has no PnrNo — the PNR only
// becomes available from the Ticket step, so bookings.pnr stays null here
// and is set in /api/book/ticket instead. This is the point of no easy
// return in the Amadeus flow — cancelBooking exists for after this, but
// there's no "undo AddPassenger" step.
//
// Takes bookingId (from add-passenger's response) rather than re-sending all
// booking details — this route loads what it needs from the bookings row
// itself, so the frontend only needs to carry the id forward from here on.
// ─────────────────────────────────────────────────────────────────────────────

interface BookBody {
  bookingId: string
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

  const { bookingId }: BookBody = await req.json()

  if (!bookingId) {
    return Response.json({ error: 'bookingId is required' }, { status: 400 })
  }

  const { data: booking } = await service
    .from('bookings')
    .select('id, employee_id, company_id, status, provider, provider_order_id, amadeus_key')
    .eq('id', bookingId)
    .maybeSingle()

  if (!booking) {
    return Response.json({ error: 'Booking not found' }, { status: 404 })
  }

  // Same-person-only for now, matching add-passenger — the caller must be
  // the employee this booking belongs to.
  if (booking.employee_id !== employee.id) {
    return Response.json({ error: 'Not authorized to act on this booking' }, { status: 403 })
  }

  if (booking.status !== 'passenger_added') {
    return Response.json({
      error: `This booking is at status "${booking.status}" — expected "passenger_added" before calling Book. It may have already been booked, or passenger details haven't been submitted yet.`,
    }, { status: 409 })
  }

  try {
    const result = await amadeus.booking(
      booking.amadeus_key,
      booking.provider_order_id,
      booking.provider
    )
const pnr = result.AirBookingResponse?.[0]?.PNR ?? null   // ADD THIS LINE

    const { error: updateError } = await service
      .from('bookings')
      .update({
        status: 'held',
        pnr,
        updated_at: new Date().toISOString(), 
      })
      .eq('id', bookingId)

    if (updateError) {
      // The airline has confirmed the booking — this is a persistence
      // failure on our side, not a booking failure. There's no PNR at this
      // stage (BookingResponse doesn't return one — only Ticket does), so
      // there's nothing further to surface beyond the reference itself.
      console.error('Booking confirmed by airline but failed to save status', updateError, { bookingId, referenceNo: result.ReferenceNo })
      return Response.json({
        ok: true,
        bookingId,
        referenceNo: result.ReferenceNo,
        status: 'held',
        warning: 'Booking confirmed but there was an issue saving it — contact support with this reference if it does not appear in your bookings shortly.',
      })
    }

    return Response.json({
      ok: true,
      bookingId,
      referenceNo: result.ReferenceNo,
      status: 'held',
    })
  } catch (err) {
    if (err instanceof AmadeusError) {
      console.error('Booking error', {
        requestId: err.requestId,
        code: err.code,
        category: err.category,
        request: sanitizeAmadeusDiagnostic(err.requestBody),
        raw: sanitizeAmadeusDiagnostic(err.raw),
      })

      await service
        .from('bookings')
        .update({ status: 'failed', updated_at: new Date().toISOString() })
        .eq('id', bookingId)

      return Response.json({
        error: err.message,
        requestId: err.requestId,
        details: sanitizeAmadeusDiagnostic(err.raw),
      }, { status: 502 })
    }

    console.error('Booking error:', err)
    return Response.json({ error: 'Could not complete booking' }, { status: 500 })
  }
}