import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'

// ── GET /api/approvals ───────────────────────────────────────────────────
// Returns everything the logged-in employee needs to act on their approval
// queue: pending rows where they're the assigned approver (no time limit —
// these need action regardless of age), plus a 30-day history of decisions
// they've already made (approved/rejected), each enriched with the
// traveler's name and the booking's route/cost/dates so the manager isn't
// staring at a bare bookingId.
//
// Deliberately does two separate manual joins (traveler employee lookup,
// then merge in JS) rather than a Supabase FK-embed — same reasoning as
// elsewhere in this codebase: FK-alias inference isn't used anywhere else
// here, so this stays consistent and avoids relying on untested embed
// syntax for something a manager depends on to do their job.
// ─────────────────────────────────────────────────────────────────────────────

interface ApprovalRow {
  id: string
  booking_id: string
  tier: number
  status: string
  reason: string | null
  decision_note: string | null
  verdict: string | null
  actioned_at: string | null
  created_at: string
}

interface BookingSummary {
  id: string
  employee_id: string
  booking_type: string
  total_cost: number
  itinerary: {
    origin?: { code: string; city: string; dateTime: string }
    destination?: { code: string; city: string; dateTime: string }
    airline?: { code: string; name: string }
  } | null
  policy_verdict: string | null
  status: string
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const summaryOnly = searchParams.get('summary') === '1'

  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const service = createServiceClient()
  const { data: caller } = await service
    .from('employees')
    .select('id, company_id, full_name')
    .eq('id', user.id)
    .maybeSingle()

  if (!caller) {
    return Response.json({ error: 'Employee record not found' }, { status: 404 })
  }

  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()

  const [pendingResult, historyResult] = await Promise.all([
    service
      .from('approvals')
      .select('id, booking_id, tier, status, reason, decision_note, verdict, actioned_at, created_at')
      .eq('approver_id', caller.id)
      .eq('status', 'pending')
      .order('created_at', { ascending: true }), // oldest-waiting-first — the ones that have sat longest surface at the top
    // History is only needed for the full page, not the dashboard summary —
    // skip the query entirely rather than fetch and discard it.
    summaryOnly
      ? Promise.resolve({ data: [], error: null })
      : service
          .from('approvals')
          .select('id, booking_id, tier, status, reason, decision_note, verdict, actioned_at, created_at')
          .eq('approver_id', caller.id)
          .in('status', ['approved', 'rejected'])
          .gte('actioned_at', thirtyDaysAgo)
          .order('actioned_at', { ascending: false }),
  ])

  if (pendingResult.error || historyResult.error) {
    return Response.json(
      { error: pendingResult.error?.message ?? historyResult.error?.message ?? 'Could not load approvals' },
      { status: 500 }
    )
  }

  const allApprovals: ApprovalRow[] = [...(pendingResult.data ?? []), ...(historyResult.data ?? [])]

  if (allApprovals.length === 0) {
    return Response.json(summaryOnly ? { ok: true, pendingCount: 0, oldestNames: [] } : { ok: true, pending: [], history: [] })
  }

  const bookingIds = Array.from(new Set(allApprovals.map(a => a.booking_id)))

  const { data: bookings, error: bookingsError } = await service
    .from('bookings')
    .select('id, employee_id, booking_type, total_cost, itinerary, policy_verdict, status')
    .in('id', bookingIds)

  if (bookingsError) {
    return Response.json({ error: bookingsError.message }, { status: 500 })
  }

  const bookingById = new Map<string, BookingSummary>((bookings ?? []).map(b => [b.id, b as BookingSummary]))

  const employeeIds = Array.from(new Set((bookings ?? []).map(b => b.employee_id)))
  const { data: travelers } = await service
    .from('employees')
    .select('id, full_name, email, department')
    .in('id', employeeIds)

  const travelerById = new Map((travelers ?? []).map(t => [t.id, t]))

  if (summaryOnly) {
    // Oldest 3 — pendingResult is already ordered ascending by created_at,
    // so this is just the first 3 traveler names, not a re-sort.
    const oldestNames = (pendingResult.data ?? [])
      .slice(0, 3)
      .map(a => {
        const booking = bookingById.get(a.booking_id)
        const traveler = booking ? travelerById.get(booking.employee_id) : undefined
        return traveler?.full_name ?? 'Unknown traveler'
      })

    return Response.json({
      ok: true,
      pendingCount: (pendingResult.data ?? []).length,
      oldestNames,
    })
  }

  function enrich(a: ApprovalRow) {
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
        itinerary: booking.itinerary,
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
    pending: (pendingResult.data ?? []).map(enrich),
    history: (historyResult.data ?? []).map(enrich),
  })
}