import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { amadeus, AmadeusError, sanitizeAmadeusDiagnostic } from '@/app/lib/amadeus/client'
import { NextRequest } from 'next/server'

// ── POST /api/book/ticket ─────────────────────────────────────────────────────
// Final step (search → price → add-passenger → book → ticket). Issues the
// actual ticket against the confirmed booking. Like /book/book, this loads
// what it needs from the bookings row rather than re-accepting booking
// details from the frontend.
//
// Amadeus's real Ticket response is NOT flat — PNR and ticket numbers live
// nested under AirBookingResponse[0].PNR and
// AirBookingResponse[0].CustomerInfo.PassengerDetails[].TicketNo, one entry
// per passenger in the same order they were submitted to AddPassengerDetails.
// Previously this only read index [0], so multi-passenger bookings silently
// lost every ticket number after the first — now captures the full array,
// same order as traveler_snapshot.PassengerDetails, so the confirm/ticket
// pages can zip the two together to show "name -> ticket number" per pax.
//
// Note: NOT marking status 'failed' in the catch block — unlike a failed
// Booking call, a failed Ticket call still leaves a valid confirmed booking
// (status stays 'held'), since the PNR from Book already exists and is real
// regardless of whether ticketing succeeds on this attempt. Ticketing can
// reasonably be retried without redoing Book.
// ─────────────────────────────────────────────────────────────────────────────

interface TicketBody {
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
    .select('id, client_id')
    .eq('id', user.id)
    .maybeSingle()

  if (!employee) {
    return Response.json({ error: 'Employee record not found' }, { status: 404 })
  }

  const { bookingId }: TicketBody = await req.json()

  if (!bookingId) {
    return Response.json({ error: 'bookingId is required' }, { status: 400 })
  }

  const { data: booking } = await service
    .from('bookings')
    .select('id, employee_id, status, provider, provider_order_id, amadeus_key, pricing_key, pnr')
    .eq('id', bookingId)
    .maybeSingle()

  if (!booking) {
    return Response.json({ error: 'Booking not found' }, { status: 404 })
  }

  if (booking.employee_id !== employee.id) {
    return Response.json({ error: 'Not authorized to act on this booking' }, { status: 403 })
  }

  if (booking.status !== 'held') {
    return Response.json({
      error: `This booking is at status "${booking.status}" — expected "held" before calling Ticket. Complete the Book step first.`,
    }, { status: 409 })
  }

  try {
    const result = await amadeus.ticket(
      booking.amadeus_key,
      booking.provider_order_id,
      booking.pricing_key,
      booking.provider,
      booking.pnr ?? ''
    )

    const flightResult = result.AirBookingResponse?.[0]
    const pnr = flightResult?.PNR ?? booking.pnr
    // Keep position stable (don't .filter() out gaps) — the confirm/ticket
    // pages zip this against traveler_snapshot.PassengerDetails by index,
    // so a missing TicketNo for one passenger must not shift the ones after it.
    const ticketNumbers = (flightResult?.CustomerInfo?.PassengerDetails ?? []).map(p => p.TicketNo ?? null)

    const { error: updateError } = await service
      .from('bookings')
      .update({
        status: 'ticketed',
        pnr,
        ticket_numbers: ticketNumbers,
        updated_at: new Date().toISOString(),
      })
      .eq('id', bookingId)

    if (updateError) {
      console.error('Ticket issued but failed to save', updateError, { bookingId, ticketNumbers })
      return Response.json({
        ok: true,
        bookingId,
        pnr,
        ticketNumbers,
        status: 'ticketed',
        warning: 'Ticket issued but there was an issue saving it — contact support with this ticket number if it does not appear in your bookings shortly.',
      })
    }

    return Response.json({
      ok: true,
      bookingId,
      pnr,
      ticketNumbers,
      status: 'ticketed',
    })
  } catch (err) {
    if (err instanceof AmadeusError) {
      console.error('Ticket error', {
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

    console.error('Ticket error:', err)
    return Response.json({ error: 'Could not issue ticket' }, { status: 500 })
  }
}