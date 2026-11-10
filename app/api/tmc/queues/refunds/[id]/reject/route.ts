import { NextRequest } from 'next/server'
import { requireUser } from '@/app/lib/auth/session'
import { db, transaction } from '@/app/lib/db'
import * as refunds from '@/app/lib/repositories/refunds'
import * as audit from '@/app/lib/repositories/audit'
import { refundCaller } from '@/app/lib/refunds/access'
import { route } from '@/app/lib/http/handler'
import { isUuid } from '@/app/lib/book/bookingActor'

// ── POST /api/tmc/queues/refunds/[id]/reject ─────────────────────────────────
// Declines a pending refund. Body: { reason } (required, at most 1,000
// characters). The traveller and the company see the reason on the booking.
// Audited. A refund no longer pending is refused (409).
// ─────────────────────────────────────────────────────────────────────────────

export const POST = route(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const user = await requireUser()
  const caller = await refundCaller(db, user.id)
  if (!caller.ok) return Response.json({ error: caller.error }, { status: caller.status })

  const { id } = await params
  const d = isUuid(id) ? await refunds.detail(db, id, caller) : null
  if (!d) return Response.json({ error: 'Refund not found' }, { status: 404 })

  const body = await req.json().catch(() => ({})) as { reason?: unknown }
  const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
  if (!reason) return Response.json({ error: 'Give a reason for rejecting this refund.' }, { status: 400 })
  if (reason.length > 1000) return Response.json({ error: 'The reason can be at most 1,000 characters.' }, { status: 400 })

  const ok = await transaction(async tx => {
    if (!(await refunds.reject(tx, d.id, caller.tmcId, reason, user.id))) return false
    await audit.append(tx, {
      action: 'refund.rejected', entityType: 'refund', entityId: d.id, userId: user.id,
      clientId: d.client_id, tmcId: caller.tmcId,
      metadata: { booking_id: d.booking_id, ticket_number: d.ticket_number, reason },
    })
    return true
  })
  if (!ok) return Response.json({ error: `This refund is already ${d.status === 'pending' ? 'settled' : d.status}.`, code: 'NOT_PENDING' }, { status: 409 })
  return Response.json({ ok: true, status: 'rejected' })
})
