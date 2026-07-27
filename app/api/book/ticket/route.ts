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
// Amadeus's Ticket response returns a single TicketNo string, not an array —
// but bookings.ticket_numbers is an array column (presumably to support
// multi-passenger bookings later), so it's stored as a one-element array
// for now rather than changing the column shape.
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
    .select('id, company_id')
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

  if (booking.status !== 'booked') {
    return Response.json({
      error: `This booking is at status "${booking.status}" — expected "booked" before calling Ticket. Complete the Book step first.`,
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

    const { error: updateError } = await service
      .from('bookings')
      .update({
        status: 'ticketed',
        pnr: result.PnrNo || booking.pnr,
        ticket_numbers: result.TicketNo ? [result.TicketNo] : [],
        updated_at: new Date().toISOString(),
      })
      .eq('id', bookingId)

    if (updateError) {
      // Ticket is issued at this point — this is a persistence failure, not
      // a ticketing failure. Surface the ticket number regardless.
      console.error('Ticket issued but failed to save', updateError, { bookingId, ticketNo: result.TicketNo })
      return Response.json({
        ok: true,
        bookingId,
        pnr: result.PnrNo || booking.pnr,
        ticketNumbers: result.TicketNo ? [result.TicketNo] : [],
        status: 'ticketed',
        warning: 'Ticket issued but there was an issue saving it — contact support with this ticket number if it does not appear in your bookings shortly.',
      })
    }

    return Response.json({
      ok: true,
      bookingId,
      pnr: result.PnrNo || booking.pnr,
      ticketNumbers: result.TicketNo ? [result.TicketNo] : [],
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

      // Note: NOT marking status 'failed' here — unlike a failed Booking
      // call, a failed Ticket call still leaves a valid confirmed booking
      // (status stays 'booked'), since the PNR from Book already exists and
      // is real regardless of whether ticketing succeeds on this attempt.
      // Ticketing can reasonably be retried without redoing Book.

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