import { NextRequest } from 'next/server'
import { requireUser } from '@/app/lib/auth/session'
import { db } from '@/app/lib/db'
import * as refunds from '@/app/lib/repositories/refunds'
import { refundCaller } from '@/app/lib/refunds/access'
import { computeFor, refundInputs, refundRule, sameGstState, defaultMode, ticketSummary, type FrozenLines } from '@/app/lib/refunds/panel'
import { route } from '@/app/lib/http/handler'
import { isUuid } from '@/app/lib/book/bookingActor'

// ── GET /api/tmc/queues/refunds/[id] ─────────────────────────────────────────
// The refund panel's data for one cancelled ticket:
//   ticket        the summary strip (passenger, PNRs, ticket, sector, cabin…)
//   computation   sections A–D (app/lib/refunds/compute.ts): computed now
//                 while pending, the frozen record once processed
//   inputs, rule, sameState
//                 what the computation was made from, so the panel can
//                 recalculate as the desk edits a deduction. The server
//                 recomputes on processing; the browser's figures are never
//                 stored.
// TMC staff with process_refunds, within their reach; anyone else gets 404.
// ─────────────────────────────────────────────────────────────────────────────

export const GET = route(async (_req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const user = await requireUser()
  const caller = await refundCaller(db, user.id)
  if (!caller.ok) return Response.json({ error: caller.error }, { status: caller.status })

  const { id } = await params
  const d = isUuid(id) ? await refunds.detail(db, id, caller) : null
  if (!d) return Response.json({ error: 'Refund not found' }, { status: 404 })

  const frozen = d.status === 'processed' ? (d.lines as unknown as FrozenLines | null) : null
  const sameState = sameGstState(d.client.branch_gst_state, d.client.gst_state ?? d.client.state)
  const [attachments, parties] = await Promise.all([
    refunds.attachments(db, d.id),
    // Who issues the credit note to whom, for the printable copy.
    d.status === 'processed' ? refunds.creditNoteParties(db, d.client_id) : null,
  ])
  return Response.json({
    ok: true,
    refund: {
      id: d.id,
      status: d.status,
      awaitingConfirmation: d.status === 'pending' && d.booking.status === 'cancel_requested',
      canProcess: d.status === 'pending' && d.booking.status === 'cancelled',
      bookingId: d.booking.id,
      clientName: d.client.name,
      clientCode: d.client.client_code,
      creditNoteNo: d.credit_note_no,
      refundAmount: d.refund_amount,
      airlineRefund: d.airline_refund,
      tmcRetained: d.tmc_retained,
      refundDate: d.refund_date,
      mode: d.mode ?? defaultMode(d),
      remark: d.remark,
      processedBy: d.processed_by_name,
      processedAt: d.processed_at,
      rejectedReason: d.rejected_reason,
    },
    ticket: ticketSummary(d),
    computation: frozen?.computation ?? computeFor(d),
    overrides: frozen?.overrides ?? {},
    inputs: refundInputs(d),
    rule: refundRule(d.client),
    sameState,
    attachments,
    parties,
  })
})
