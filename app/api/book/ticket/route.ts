import { createClient } from '@/utils/supabase/server'
import { amadeus, AmadeusError, sanitizeAmadeusDiagnostic } from '@/app/lib/amadeus/client'
import * as employees from '@/app/lib/repositories/employees'
import * as bookingsRepo from '@/app/lib/repositories/bookings'
import { route } from '@/app/lib/http/handler'
import { loadClientGates } from '@/app/lib/clients/clientGates'
import { classifyFlight } from '@/app/lib/rule-engine/classifyTrip'
import { NextRequest } from 'next/server'
import { db } from '@/app/lib/db'

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

export const POST = route(async (req: NextRequest) => {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  // The body is read BEFORE the employee lookup so the booking id is in hand and
  // the two reads can overlap. They are independent — one is keyed on the user,
  // the other on the booking — and ran back to back for no reason other than the
  // order they were written in.
  //
  // MEASURED: ~200ms per Supabase round trip from here. This route made four of
  // them in a row before the provider was contacted at all, which is close to a
  // second of a ticketing wait spent waiting on our own database.
  const { bookingId }: TicketBody = await req.json()

  if (!bookingId) {
    return Response.json({ error: 'bookingId is required' }, { status: 400 })
  }

  const [employee, booking] = await Promise.all([
    employees.traveller(db, user.id),
    bookingsRepo.ticketTarget(db, bookingId),
  ])

  if (!employee) {
    return Response.json({ error: 'Employee record not found' }, { status: 404 })
  }

  if (!booking) {
    return Response.json({ error: 'Booking not found' }, { status: 404 })
  }

  if (booking.employee_id !== employee.id) {
    return Response.json({ error: 'Not authorized to act on this booking' }, { status: 403 })
  }

  // Corporate Settings can permit domestic ticketing but not international, or
  // the reverse — a normal arrangement while a client's international account
  // is still being set up.
  //
  // Checked here rather than at booking: a held PNR is useful either way, and
  // refusing the hold would take away the thing that lets a desk sort the
  // ticketing out. The route is classified the same way the policy engine
  // classifies it, via the shared classifyFlight.
  const gates = await loadClientGates(db, employee.client_id)
  const itinerary = booking.itinerary as Parameters<typeof classifyFlight>[0] | null

  if (itinerary) {
    const trip = classifyFlight(itinerary)
    if (trip === 'domestic' && !gates.domTicketing) {
      return Response.json(
        { error: 'Domestic ticketing is switched off for this account. Contact your travel desk.' },
        { status: 403 }
      )
    }
    if (trip === 'international' && !gates.intlTicketing) {
      return Response.json(
        { error: 'International ticketing is switched off for this account. Contact your travel desk.' },
        { status: 403 }
      )
    }
  }

  if (booking.status !== 'held') {
    // Carries a code as well as a sentence. The ticket page can now start
    // ticketing in parallel with its own booking load (see loadAndMaybeTicket),
    // which means a stale hand-off can legitimately reach here on an
    // already-ticketed booking — a case the page should absorb silently rather
    // than show as a failure. String-matching the prose to tell those apart is
    // how an error message becomes load-bearing.
    return Response.json({
      error: `This booking is at status "${booking.status}" — expected "held" before calling Ticket. Complete the Book step first.`,
      code: 'NOT_HELD',
      status: booking.status,
    }, { status: 409 })
  }

  // A held booking always has these -- they were set when passenger details
  // reached the airline. Checked rather than assumed so a damaged row fails
  // clearly here instead of as an unreadable provider error.
  const { amadeus_key: resultKey, provider_order_id: referenceNo, pricing_key: pricingKey, provider } = booking
  if (!resultKey || !referenceNo || !pricingKey || !provider) {
    console.error('Booking is held but missing provider keys', { bookingId })
    return Response.json({
      error: 'This booking is missing required data and cannot be ticketed. Please contact support.',
    }, { status: 500 })
  }

  try {
    const result = await amadeus.ticket(resultKey, referenceNo, pricingKey, provider, booking.pnr ?? '')

    const flightResult = result.AirBookingResponse?.[0]
    const pnr = flightResult?.PNR ?? booking.pnr

    // A ticket without a PNR is a ticket nobody can use at a desk, so this is
    // worth one log line rather than a null quietly written to the row.
    //
    // It was null on every booking until the acronym fix in the key normaliser
    // (see ACRONYM_KEYS in app/lib/amadeus/client.ts) — "PNR" is the one field
    // shape that could not survive the lowerCamelCase round trip. If it is still
    // empty after that, the keys printed here say where the provider actually
    // put it.
    if (!pnr) {
      console.warn('[ticket] no PNR in the response', {
        bookingId,
        topLevelKeys: Object.keys(result ?? {}),
        bookingKeys: flightResult ? Object.keys(flightResult) : null,
      })
    }
    // Keep position stable (don't .filter() out gaps) — the confirm/ticket
    // pages zip this against traveler_snapshot.PassengerDetails by index,
    // so a missing TicketNo for one passenger must not shift the ones after it.
    const ticketNumbers = (flightResult?.CustomerInfo?.PassengerDetails ?? []).map(p => p.TicketNo ?? null)

    // The secret behind the public e-ticket at /t/[token].
    //
    // Issued here because a ticket is the only thing worth sharing — there is
    // nothing to show at a gate before one exists. 32 hex characters from
    // crypto.randomUUID(), which is a CSPRNG: 128 bits, so guessing one is not
    // a thing that happens. Clearing the column later revokes the link without
    // touching the booking.
    //
    // Only minted once. Re-ticketing a booking must not invalidate a link the
    // traveller has already sent to someone.
    const shareToken = booking.share_token ?? crypto.randomUUID().replace(/-/g, '')

    // The ticket exists at the airline now. A failure to record it gets its
    // own answer, carrying the ticket numbers -- not the generic error path.
    let updateError: unknown = null
    try {
      await bookingsRepo.markTicketed(db, bookingId, { pnr, ticketNumbers, shareToken })
    } catch (err) {
      updateError = err
    }

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
})