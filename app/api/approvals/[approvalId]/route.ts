import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { NextRequest } from 'next/server'
import { advanceApprovalChain } from '@/app/lib/approval-engine/resolveApprovalTier'
import type { Verdict } from '@/app/lib/rule-engine/evaluateBooking'

// ── PATCH /api/approvals/[approvalId] ────────────────────────────────────
// The only way an approval actually gets decided. Verifies the caller is
// the row's assigned approver (never trusts a client-passed approver id),
// then:
//   - reject  -> approvals row -> 'rejected', bookings row -> 'rejected'.
//     Terminal — no further tiers get created even if more exist in the
//     chain, since a rejection at any tier kills the whole booking.
//   - approve -> approvals row -> 'approved', then advanceApprovalChain
//     decides what's next: either the next tier's row gets created
//     (bookings stays 'pending_approval', new approver notified) or there
//     is no next tier and bookings flips to 'approved' (employee can now
//     call /api/book/booking).
// ─────────────────────────────────────────────────────────────────────────────

interface DecisionBody {
  decision: 'approve' | 'reject'
  note?: string
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ approvalId: string }> }
) {
  const { approvalId } = await params
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const service = createServiceClient()
  const { data: caller } = await service
    .from('employees')
    .select('id, client_id')
    .eq('id', user.id)
    .maybeSingle()

  if (!caller) {
    return Response.json({ error: 'Employee record not found' }, { status: 404 })
  }

  const { data: approval } = await service
    .from('approvals')
    .select('id, booking_id, client_id, approver_id, tier, status, chain_template_id, verdict, reason')
    .eq('id', approvalId)
    .maybeSingle()

  if (!approval) {
    return Response.json({ error: 'Approval not found' }, { status: 404 })
  }

  if (approval.approver_id !== caller.id) {
    return Response.json({ error: 'You are not the assigned approver for this request' }, { status: 403 })
  }

  if (approval.status !== 'pending') {
    return Response.json({ error: `This approval has already been ${approval.status}` }, { status: 409 })
  }

  const body: DecisionBody = await req.json()
  const { decision, note } = body

  if (decision !== 'approve' && decision !== 'reject') {
    return Response.json({ error: 'decision must be "approve" or "reject"' }, { status: 400 })
  }

  const { data: booking } = await service
    .from('bookings')
    .select('id, employee_id, client_id, status')
    .eq('id', approval.booking_id)
    .maybeSingle()

  if (!booking) {
    return Response.json({ error: 'Booking for this approval was not found' }, { status: 404 })
  }

  // Someone else may have already acted on this booking through a
  // different path (e.g. it was cancelled) — approving/rejecting a booking
  // that's no longer 'pending_approval' would be acting on stale state.
  if (booking.status !== 'pending_approval') {
    return Response.json({
      error: `This booking is no longer awaiting approval (current status: "${booking.status}"). No action taken.`,
    }, { status: 409 })
  }

  const { error: decisionError } = await service
    .from('approvals')
    .update({
      status: decision === 'approve' ? 'approved' : 'rejected',
      decision_note: note ?? null,
      actioned_at: new Date().toISOString(),
    })
    .eq('id', approvalId)

  if (decisionError) {
    return Response.json({ error: decisionError.message }, { status: 500 })
  }

  if (decision === 'reject') {
    const { error: rejectError } = await service
      .from('bookings')
      .update({ status: 'rejected', updated_at: new Date().toISOString() })
      .eq('id', booking.id)

    if (rejectError) {
      console.error('Approval decided but failed to flip booking to rejected', rejectError, { bookingId: booking.id })
      return Response.json({
        ok: false,
        error: 'Your decision was recorded, but the booking status could not be updated. Please contact support.',
      }, { status: 500 })
    }

    return Response.json({ ok: true, bookingStatus: 'rejected' })
  }

  // Approved — see if the chain has a next tier that this booking's stored
  // verdict actually meets. chain_template_id/verdict were captured on the approval
  // row itself when it was created, so no need to re-derive them here.
  if (!approval.chain_template_id) {
    // Shouldn't happen in practice (every approval created by the engine
    // sets chain_template_id), but fail toward finalizing rather than leaving the
    // booking stuck if it somehow does.
    const { error: finalizeError } = await service
      .from('bookings')
      .update({ status: 'approved', updated_at: new Date().toISOString() })
      .eq('id', booking.id)

    if (finalizeError) {
      console.error('Approval decided but failed to flip booking to approved (no chain_template_id)', finalizeError, { bookingId: booking.id })
      return Response.json({
        ok: false,
        error: 'Your decision was recorded, but the booking status could not be updated. Please contact support.',
      }, { status: 500 })
    }

    return Response.json({ ok: true, bookingStatus: 'approved' })
  }

  try {
    const outcome = await advanceApprovalChain(service, {
      bookingId: booking.id,
      clientId: approval.client_id,
      employeeId: booking.employee_id,
      chainTemplateId: approval.chain_template_id,
      completedTier: approval.tier,
      verdict: (approval.verdict as Verdict) ?? 'green',
      reason: approval.reason ?? 'Within policy',
    })

    if (!outcome.requiresApproval) {
      const { error: finalizeError } = await service
        .from('bookings')
        .update({ status: 'approved', updated_at: new Date().toISOString() })
        .eq('id', booking.id)

      if (finalizeError) {
        console.error('Approval decided but failed to flip booking to approved', finalizeError, { bookingId: booking.id })
        return Response.json({
          ok: false,
          error: 'Your decision was recorded, but the booking status could not be updated. Please contact support.',
        }, { status: 500 })
      }

      return Response.json({ ok: true, bookingStatus: 'approved' })
    }

    if (!outcome.approverId) {
      const { error: misconfigError } = await service
        .from('bookings')
        .update({ status: 'approval_misconfigured', updated_at: new Date().toISOString() })
        .eq('id', booking.id)

      if (misconfigError) {
        console.error('Approval decided but failed to flip booking to approval_misconfigured', misconfigError, { bookingId: booking.id })
        return Response.json({
          ok: false,
          error: 'Your decision was recorded, but the booking status could not be updated. Please contact support.',
        }, { status: 500 })
      }

      return Response.json({ ok: true, bookingStatus: 'approval_misconfigured' })
    }

    // Next tier's approval row was created — booking stays pending_approval.
    return Response.json({ ok: true, bookingStatus: 'pending_approval', nextTier: outcome.tier })
  } catch (err) {
    console.error('Failed to advance approval chain after approval', err)
    // The approval itself was recorded successfully — only the next-tier
    // creation failed. Leave the booking at pending_approval (its current
    // DB state) rather than claim success or silently approve past a
    // broken chain step.
    return Response.json({
      ok: false,
      error: 'Your decision was recorded, but there was a problem advancing to the next approval step. Please contact support.',
    }, { status: 500 })
  }
}