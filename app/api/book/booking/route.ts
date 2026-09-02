import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { amadeus, AmadeusError, sanitizeAmadeusDiagnostic, CustomerInfo } from '@/app/lib/amadeus/client'
import { NextRequest } from 'next/server'
import util from 'util'

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

// Shared by both the initial Booking attempt and the retry after a
// silent re-price/re-AddPassenger recovery (see the session-expiry catch
// below) — same persistence logic either way.
async function finalizeHeld(
  service: ReturnType<typeof createServiceClient>,
  bookingId: string,
  result: Awaited<ReturnType<typeof amadeus.booking>>
) {
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

  const { bookingId }: BookBody = await req.json()

  if (!bookingId) {
    return Response.json({ error: 'bookingId is required' }, { status: 400 })
  }

  const { data: booking } = await service
    .from('bookings')
    .select('id, employee_id, client_id, status, provider, provider_order_id, amadeus_key, pricing_key, search_key, result_index, total_cost, traveler_snapshot')
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

  if (!booking.amadeus_key || !booking.provider_order_id) {
    // Shouldn't happen for a booking that reached 'approved' (both are set
    // at AddPassenger time, before pending_approval/approved is possible),
    // but fail with a clear message rather than calling Booking with a
    // missing key.
    console.error('Booking is approved but missing amadeus_key/provider_order_id', { bookingId })
    return Response.json({
      error: 'This booking is missing required data and cannot be confirmed with the airline. Please contact support.',
    }, { status: 500 })
  }

  try {
    let bookingKey: string = booking.amadeus_key
    let bookingReferenceNo: string = booking.provider_order_id

    try {
      const result = await amadeus.booking(bookingKey, bookingReferenceNo, booking.provider)
      return await finalizeHeld(service, bookingId, result)
    } catch (err) {
      // A booking that sat in pending_approval for a while can outlive the
      // GDS-side session tied to its stored amadeus_key/provider_order_id —
      // by the time an approver acts, "Result Session Expired" (or similar)
      // comes back from Booking even though withSession already re-auths
      // and retries once internally. That internal retry only refreshes
      // SessionID; it replays the SAME Key, which is itself scoped to the
      // now-dead session and can't be revived by re-authenticating alone.
      //
      // Recovery: replay Pricing -> AddPassengerDetails from what's already
      // stored on this row (search_key, pricing_key, result_index,
      // total_cost, traveler_snapshot) to mint a fresh Key/ReferenceNo under
      // the current session, save those onto the booking, then retry
      // Booking exactly once more. Only attempted for a session/key-expiry
      // style failure — any other Booking failure (fare bust, seat gone,
      // etc.) falls straight through to the normal error path below rather
      // than masking a real failure behind a confusing re-price attempt.
      const isStaleKey =
        err instanceof AmadeusError &&
        /session/i.test(err.message)

      if (!isStaleKey) throw err

      if (!booking.search_key || !booking.pricing_key || !booking.result_index || !booking.traveler_snapshot) {
        // Can't recover without the original pricing inputs — surface the
        // original error rather than a confusing "missing data" one.
        console.error('Booking session expired and this booking is missing data needed to auto-recover', {
          bookingId,
          hasSearchKey: !!booking.search_key,
          hasPricingKey: !!booking.pricing_key,
          hasResultIndex: !!booking.result_index,
          hasTravelerSnapshot: !!booking.traveler_snapshot,
        })
        throw err
      }

      console.info('[book/booking] session/key expired — re-pricing and re-submitting passenger details before retrying Booking', { bookingId })

      let freshPricing
      try {
        freshPricing = await amadeus.pricing(
          booking.search_key,
          booking.pricing_key,
          booking.provider,
          booking.result_index
        )
      } catch (pricingErr) {
        // If Pricing ITSELF fails with a session/expiry-style error even
        // right after a fresh Authenticate, the problem isn't the
        // SessionID — it's that the original Availability/search_key is
        // too old to reuse at all. Availability results appear to have
        // their own expiry, separate from (and possibly shorter-lived
        // relative to how long this booking sat waiting for approval
        // than) the session TTL — Amadeus reuses the same generic
        // "Result Session Expired" message for both cases, so there's no
        // way to distinguish them from the error text alone. Once we're
        // here, replaying with the same search_key can't succeed no
        // matter how many times we re-authenticate — the only real fix
        // is a brand new search. Surface that plainly instead of letting
        // a raw GDS error reach the traveler.
        const isAlsoStale = pricingErr instanceof AmadeusError && /session/i.test(pricingErr.message)
        if (isAlsoStale) {
          console.error('Recovery re-pricing also failed with a session/expiry error — search_key itself is stale, not just the session', {
            bookingId,
            searchKey: booking.search_key,
            bookingCreatedRelativeToNow: 'unknown — check bookings.created_at for this bookingId',
          })
          const { error: staleUpdateError } = await service
            .from('bookings')
            .update({ status: 'failed', updated_at: new Date().toISOString() })
            .eq('id', bookingId)
          if (staleUpdateError) {
            console.error('Failed to mark booking as failed after unrecoverable stale search', staleUpdateError, { bookingId })
          }
          return Response.json({
            error: 'This search has expired — it was priced too long ago to confirm with the airline now. Please search for this flight again and re-book.',
            code: 'SEARCH_EXPIRED',
          }, { status: 409 })
        }
        throw pricingErr
      }

      const freshAddPassenger = await amadeus.addPassenger(
        freshPricing.Key,
        freshPricing.ReferenceNo,
        booking.traveler_snapshot as CustomerInfo,
        String(booking.total_cost),
        String(booking.total_cost)
      )

      bookingKey = freshPricing.Key
      bookingReferenceNo = freshAddPassenger.ReferenceNo ?? freshPricing.ReferenceNo

      const { error: refreshError } = await service
        .from('bookings')
        .update({
          amadeus_key: bookingKey,
          provider_order_id: bookingReferenceNo,
          updated_at: new Date().toISOString(),
        })
        .eq('id', bookingId)

      if (refreshError) {
        console.error('Re-priced booking successfully but failed to save refreshed key/reference', refreshError, { bookingId })
      }

      const retryResult = await amadeus.booking(bookingKey, bookingReferenceNo, booking.provider)
      return await finalizeHeld(service, bookingId, retryResult)
    }
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