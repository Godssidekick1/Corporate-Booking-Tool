import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { amadeus, AmadeusError, sanitizeAmadeusDiagnostic } from '@/app/lib/amadeus/client'
import { NextRequest } from 'next/server'
import util from 'util'

// ── POST /api/book/booking ────────────────────────────────────────────────────
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
//
// Status gate: only 'approved' may proceed to the real airline Book call —
// NOT 'passenger_added' (that status no longer exists in the flow at all).
// add-passenger now inserts bookings at 'pending_approval', then the
// Approval Engine (see resolveApprovalTier.ts) either flips it straight to
// 'approved' (no chain assigned, or verdict didn't meet any tier's
// threshold) or leaves it pending a human approver. This gate is what
// actually enforces that server-side — the frontend's confirm page only
// shows the Confirm button once status is 'approved', but that's a UX
// nicety, not the real enforcement. Someone hitting this endpoint directly
// with a pending/misconfigured/rejected bookingId must still be blocked here.
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

  if (booking.status !== 'approved') {
    return Response.json({
      error: booking.status === 'pending_approval'
        ? 'This booking is still awaiting approval. It cannot be confirmed with the airline until an approver signs off.'
        : booking.status === 'approval_misconfigured'
        ? 'This booking needs approval but no approver could be found (e.g. no manager is assigned). Contact your TMC or corporate admin to fix the reporting hierarchy, then try again.'
        : booking.status === 'rejected'
        ? 'This booking was rejected during approval and cannot be confirmed with the airline.'
        : `This booking is at status "${booking.status}" — expected "approved" before calling Book. It may have already been booked, rejected, or passenger details haven't been submitted yet.`,
    }, { status: 409 })
  }

  try {
    const result = await amadeus.booking(
      booking.amadeus_key,
      booking.provider_order_id,
      booking.provider
    )

    // BookingResponse itself has no top-level PNR — it only appears nested
    // inside AirBookingResponse[0] once the airline confirms. bookings.pnr
    // is also set again in /api/book/ticket (Ticket's response is the
    // authoritative source), so this is a best-effort early capture.
    const pnr = result.AirBookingResponse?.[0]?.PNR ?? null

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
      // Node's console.error truncates nested objects past depth 2 (that's
      // the "[ [Object] ]" you see for AirBookingResponse above) — this
      // prints the same raw payload with no depth limit so the actual
      // failure reason inside AirBookingResponse[0] is visible.
      console.error('Booking error (full, untruncated raw):', util.inspect(sanitizeAmadeusDiagnostic(err.raw), { depth: null, colors: false }))

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