import { NextRequest } from 'next/server'
import { requireUser } from '@/app/lib/auth/session'
import { actingTraveller } from '@/app/lib/book/bookingActor'
import { db } from '@/app/lib/db'
import * as employees from '@/app/lib/repositories/employees'
import * as bookingsRepo from '@/app/lib/repositories/bookings'
import * as audit from '@/app/lib/repositories/audit'
import { route } from '@/app/lib/http/handler'
import { POLICY_REASONS, reasonProblem } from '@/app/lib/book/policyReasons'
import { startApprovalForBooking } from '@/app/lib/approval-engine/resolveApprovalTier'

// ── POST /api/book/[bookingId]/reapproval ────────────────────────────────────
// A booking sent back because its fare rose beyond the traveller's policy (an
// approver's refresh: status reapproval_needed). The traveller, or whoever
// booked for them, asks for approval again at the new price, saying why it
// should go ahead outside policy. A new approval round starts, always sent.
//
// Body: { reasonCode, note? } — a policy reason (app/lib/book/policyReasons.ts);
// "other" needs a note. The alternative, choosing another flight, needs no
// route: the traveller searches again and this booking can be cancelled.
// ─────────────────────────────────────────────────────────────────────────────

const MAX_NOTE = 500

export const POST = route(async (req: NextRequest, { params }: { params: Promise<{ bookingId: string }> }) => {
  const user = await requireUser()
  const { bookingId } = await params
  const body = await req.json().catch(() => ({})) as { reasonCode?: unknown; note?: unknown }
  const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim() : null
  if (note && note.length > MAX_NOTE) {
    return Response.json({ error: `The note can be at most ${MAX_NOTE} characters.` }, { status: 400 })
  }
  const problem = reasonProblem(body.reasonCode, note)
  if (problem) return Response.json({ error: problem, code: 'POLICY_REASON_REQUIRED', reasons: POLICY_REASONS }, { status: 400 })
  const reasonCode = String(body.reasonCode)

  const [me, booking] = await Promise.all([
    employees.traveller(db, user.id),
    bookingsRepo.reapprovalTarget(db, bookingId),
  ])
  if (!me) return Response.json({ error: 'Employee record not found' }, { status: 404 })
  if (!booking) return Response.json({ error: 'Booking not found' }, { status: 404 })

  // The traveller, or anyone who may book for them (app/lib/book/bookingActor.ts).
  const { traveller, onBehalf } = await actingTraveller(db, user, me, booking)
  if (booking.employee_id !== traveller.id) {
    return Response.json({ error: 'Not authorized to act on this booking' }, { status: 403 })
  }
  if (booking.status !== 'reapproval_needed') {
    return Response.json({
      error: 'This booking isn’t waiting to be sent for approval again.', code: 'NOT_RETURNED', status: booking.status,
    }, { status: 409 })
  }
  if (!booking.client_id) return Response.json({ error: 'This booking has no company to approve it.' }, { status: 409 })

  const label = POLICY_REASONS.find(r => r.code === reasonCode)?.label ?? reasonCode
  const price = `₹${Math.round(Number(booking.sell_total ?? booking.total_cost)).toLocaleString('en-IN')}`
  // The breaches themselves are on the booking (the approver's card shows them).
  const reason = `Asked again after the fare rose to ${price}. Reason given: ${reasonCode === 'other' ? note : label}${reasonCode !== 'other' && note ? ` (${note})` : ''}`

  await bookingsRepo.setPolicyReason(db, booking.id, reasonCode, note)
  await bookingsRepo.setStatus(db, booking.id, 'pending_approval')
  const outcome = await startApprovalForBooking(db, {
    bookingId: booking.id, clientId: booking.client_id, employeeId: booking.employee_id, travelType: 'flight',
    verdict: (booking.policy_verdict as 'green' | 'amber' | 'red' | null) ?? 'red',
    reason,
    alwaysSend: true,
  })
  // No chain to send it to: the documented no-chain rule approves it.
  const status = outcome.requiresApproval ? (outcome.approverId ? 'pending_approval' : 'approval_misconfigured') : 'approved'
  if (status !== 'pending_approval') await bookingsRepo.setStatus(db, booking.id, status)

  try {
    await audit.append(db, {
      action: 'booking.reapproval_requested', entityType: 'booking', entityId: booking.id, userId: user.id,
      clientId: booking.client_id, metadata: { reason_code: reasonCode, note, on_behalf: onBehalf, status },
    })
  } catch (auditError) {
    console.error('[reapproval] could not audit the request', auditError)
  }

  return Response.json({ ok: true, bookingId: booking.id, status })
})
