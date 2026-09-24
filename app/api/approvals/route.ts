import { createClient } from '@/utils/supabase/server'
import { NextRequest } from 'next/server'
import { travellerItinerary } from '@/app/lib/book/travellerView'
import { db } from '@/app/lib/db'
import * as approvals from '@/app/lib/repositories/approvals'
import * as bookings from '@/app/lib/repositories/bookings'
import * as employees from '@/app/lib/repositories/employees'
import { route } from '@/app/lib/http/handler'

// ── GET /api/approvals ───────────────────────────────────────────────────
// Returns everything the logged-in employee needs to act on their approval
// queue: pending rows where they're the assigned approver (no time limit —
// these need action regardless of age), plus a 30-day history of decisions
// they've already made (approved/rejected), each enriched with the
// traveler's name and the booking's route/cost/dates so the manager isn't
// staring at a bare bookingId.
//
// An approver signs off what the COMPANY spends, which is the sell total —
// and it is the figure policy was evaluated against, so showing the airline
// figure here would put a number next to a verdict that was not computed from
// it. bookings.approvalSummaries returns the sell total as total_cost and never
// selects the airline figure: an approver is an ordinary employee, and a markup
// they could read out of a network response is not hidden.
// ─────────────────────────────────────────────────────────────────────────────

export const GET = route(async (req: NextRequest) => {
  const summaryOnly = req.nextUrl.searchParams.get('summary') === '1'

  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const caller = await employees.traveller(db, user.id)

  if (!caller) {
    return Response.json({ error: 'Employee record not found' }, { status: 404 })
  }

  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()

  const [pending, history] = await Promise.all([
    // Oldest-waiting first — the ones that have sat longest surface at the top.
    approvals.pendingFor(db, caller.id),
    // History is only needed for the full page, not the dashboard summary —
    // skip the query entirely rather than fetch and discard it.
    summaryOnly ? Promise.resolve([]) : approvals.decidedSince(db, caller.id, thirtyDaysAgo),
  ])

  const allApprovals = [...pending, ...history]

  if (allApprovals.length === 0) {
    return Response.json(summaryOnly ? { ok: true, pendingCount: 0, oldestNames: [] } : { ok: true, pending: [], history: [] })
  }

  const summaries = await bookings.approvalSummaries(db, Array.from(new Set(allApprovals.map(a => a.booking_id))))
  const bookingById = new Map(summaries.map(b => [b.id, b]))

  const travellers = await employees.travellerCards(db, Array.from(new Set(summaries.map(b => b.employee_id))))
  const travelerById = new Map(travellers.map(t => [t.id, t]))

  if (summaryOnly) {
    // Oldest 3 — pending is already ordered by created_at, so this is just the
    // first 3 traveler names, not a re-sort.
    const oldestNames = pending
      .slice(0, 3)
      .map(a => {
        const booking = bookingById.get(a.booking_id)
        const traveler = booking ? travelerById.get(booking.employee_id) : undefined
        return traveler?.full_name ?? 'Unknown traveler'
      })

    // Same 10-hour urgency threshold as the full approvals page — surfaced
    // here too so the dashboard summary can flag it before the approver
    // even opens the queue.
    const URGENT_MS = 10 * 60 * 60 * 1000
    const urgentCount = pending
      .filter(a => Date.now() - new Date(a.created_at).getTime() >= URGENT_MS)
      .length

    return Response.json({
      ok: true,
      pendingCount: pending.length,
      urgentCount,
      oldestNames,
    })
  }

  function enrich(a: approvals.QueueRow) {
    const booking = bookingById.get(a.booking_id)
    const traveler = booking ? travelerById.get(booking.employee_id) : undefined
    return {
      approvalId: a.id,
      bookingId: a.booking_id,
      tier: a.tier,
      status: a.status,
      reason: a.reason,
      decisionNote: a.decision_note,
      verdict: a.verdict,
      createdAt: a.created_at,
      actionedAt: a.actioned_at,
      booking: booking ? {
        bookingType: booking.booking_type,
        totalCost: booking.total_cost,
        // Projected like every other employee-facing booking read: no
        // provider session keys or stored fare options.
        itinerary: travellerItinerary(booking.itinerary),
        policyVerdict: booking.policy_verdict,
        status: booking.status,
      } : null,
      traveler: traveler ? {
        fullName: traveler.full_name,
        email: traveler.email,
        department: traveler.department,
      } : null,
    }
  }

  return Response.json({
    ok: true,
    pending: pending.map(enrich),
    history: history.map(enrich),
  })
})
