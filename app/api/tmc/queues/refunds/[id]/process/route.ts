import { NextRequest } from 'next/server'
import { requireUser } from '@/app/lib/auth/session'
import { db, transaction } from '@/app/lib/db'
import * as refunds from '@/app/lib/repositories/refunds'
import * as audit from '@/app/lib/repositories/audit'
import { refundCaller } from '@/app/lib/refunds/access'
import { computeFor, type FrozenLines } from '@/app/lib/refunds/panel'
import { DEDUCTIONS, type DeductionKey } from '@/app/lib/refunds/compute'
import { route } from '@/app/lib/http/handler'
import { isUuid } from '@/app/lib/book/bookingActor'

// ── POST /api/tmc/queues/refunds/[id]/process ────────────────────────────────
// Settles a pending refund. Body:
//   { overrides?: { <deduction>: amount ≥ 0 }, refundDate: 'YYYY-MM-DD',
//     mode: corporate_card | agency_credit | traveller_card | other, remark? }
//
// The refund is recomputed HERE from the booking, the client's rule and the
// desk's edits; what the browser showed is never trusted. The lines are then
// frozen on the refund with a credit note number (per TMC and financial
// year, no gaps), and the processing is audited, all in one transaction.
// A refund already processed or rejected, or a booking still awaiting the
// airline's confirmation, is refused (409).
// ─────────────────────────────────────────────────────────────────────────────

const MODES = ['corporate_card', 'agency_credit', 'traveller_card', 'other'] as const

export const POST = route(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const user = await requireUser()
  const caller = await refundCaller(db, user.id)
  if (!caller.ok) return Response.json({ error: caller.error }, { status: caller.status })

  const { id } = await params
  const d = isUuid(id) ? await refunds.detail(db, id, caller) : null
  if (!d) return Response.json({ error: 'Refund not found' }, { status: 404 })
  if (d.status !== 'pending') {
    return Response.json({ error: `This refund is already ${d.status}.`, code: 'NOT_PENDING' }, { status: 409 })
  }
  if (d.booking.status !== 'cancelled') {
    return Response.json({
      error: 'The airline has not confirmed this cancellation yet. Mark it as cancelled once it has, then process the refund.',
      code: 'AWAITING_CONFIRMATION',
    }, { status: 409 })
  }

  const body = await req.json().catch(() => ({})) as Record<string, unknown>

  // Only the known deductions, each a number.
  const overrides: Partial<Record<DeductionKey, number>> = {}
  const raw = body.overrides ?? {}
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return Response.json({ error: 'overrides must be an object of deduction amounts' }, { status: 400 })
  }
  for (const [key, value] of Object.entries(raw)) {
    if (!(DEDUCTIONS as readonly string[]).includes(key)) {
      return Response.json({ error: `Unknown deduction: ${key}` }, { status: 400 })
    }
    if (typeof value !== 'number') return Response.json({ error: `${key} must be a number` }, { status: 400 })
    overrides[key as DeductionKey] = value
  }

  const refundDate = typeof body.refundDate === 'string' ? body.refundDate : ''
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(refundDate) ? new Date(`${refundDate}T00:00:00Z`) : null
  if (!parsed || Number.isNaN(parsed.getTime()) || parsed.getTime() > Date.now() + 24 * 3600_000) {
    return Response.json({ error: 'Choose a refund date, today or earlier.' }, { status: 400 })
  }
  const mode = MODES.find(m => m === body.mode)
  if (!mode) return Response.json({ error: `mode must be one of ${MODES.join(', ')}` }, { status: 400 })
  if (body.remark !== undefined && body.remark !== null && typeof body.remark !== 'string') {
    return Response.json({ error: 'remark must be text' }, { status: 400 })
  }
  const remark = typeof body.remark === 'string' && body.remark.trim() ? body.remark.trim() : null
  if (remark && remark.length > 1000) return Response.json({ error: 'The remark can be at most 1,000 characters.' }, { status: 400 })

  let computation
  try {
    computation = computeFor(d, overrides)
  } catch (err) {
    if (err instanceof RangeError) return Response.json({ error: err.message }, { status: 400 })
    throw err
  }
  const lines: FrozenLines = { computation, overrides }

  const result = await transaction(async tx => {
    const done = await refunds.process(tx, d.id, caller.tmcId, {
      lines,
      refundAmount: computation.result.refundAmount,
      airlineRefund: computation.result.airlineRefund,
      tmcRetained: computation.result.tmcRetained,
      refundDate, mode, remark, by: user.id,
    })
    if (!done) return null
    await audit.append(tx, {
      action: 'refund.processed', entityType: 'refund', entityId: d.id, userId: user.id,
      clientId: d.client_id, tmcId: caller.tmcId,
      metadata: {
        booking_id: d.booking_id, ticket_number: d.ticket_number, credit_note_no: done.creditNoteNo,
        refund_amount: computation.result.refundAmount, edited: Object.keys(overrides),
      },
    })
    return done
  })
  if (!result) {
    return Response.json({ error: 'This refund changed while you were processing it. Reload to see it.', code: 'CHANGED' }, { status: 409 })
  }

  return Response.json({
    ok: true, creditNoteNo: result.creditNoteNo, refundAmount: computation.result.refundAmount, computation,
  })
})
