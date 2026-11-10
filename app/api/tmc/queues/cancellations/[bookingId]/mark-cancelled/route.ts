import { NextRequest } from 'next/server'
import { requireUser } from '@/app/lib/auth/session'
import { db, transaction } from '@/app/lib/db'
import * as refunds from '@/app/lib/repositories/refunds'
import * as audit from '@/app/lib/repositories/audit'
import { refundCaller } from '@/app/lib/refunds/access'
import { route } from '@/app/lib/http/handler'
import { isUuid } from '@/app/lib/book/bookingActor'

// ── POST /api/tmc/queues/cancellations/[bookingId]/mark-cancelled ────────────
// The provider accepted a cancellation but had not confirmed it
// ('cancel_requested'). Once the desk has the airline's confirmation, this
// marks the booking cancelled, and its tickets' refunds can be processed.
// (The old system's "Change Status to Cancelled".) Audited.
// ─────────────────────────────────────────────────────────────────────────────

export const POST = route(async (_req: NextRequest, { params }: { params: Promise<{ bookingId: string }> }) => {
  const user = await requireUser()
  const caller = await refundCaller(db, user.id)
  if (!caller.ok) return Response.json({ error: caller.error }, { status: caller.status })

  const { bookingId } = await params
  if (!isUuid(bookingId)) return Response.json({ error: 'Booking not found' }, { status: 404 })

  const confirmed = await transaction(async tx => {
    const row = await refunds.confirmCancelled(tx, bookingId, caller)
    if (!row) return null
    // Rows normally exist from the cancellation; created here if they do not.
    await refunds.createForBooking(tx, bookingId)
    await audit.append(tx, {
      action: 'booking.cancel_confirmed', entityType: 'booking', entityId: bookingId, userId: user.id,
      clientId: row.client_id, tmcId: caller.tmcId, metadata: {},
    })
    return row
  })
  if (!confirmed) {
    return Response.json({
      error: 'This booking is not awaiting a cancellation confirmation.', code: 'NOT_AWAITING',
    }, { status: 409 })
  }
  return Response.json({ ok: true, status: 'cancelled' })
})
