import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'

// ── GET /api/bookings/actionable ─────────────────────────────────────────
// For the employee dashboard's "you have a booking to finish" banner —
// distinct from /api/approvals, which is about bookings THIS person needs
// to approve for someone else. This is the traveler's own view of their own
// bookings sitting in a state that needs them to come back: 'approved'
// (ready to confirm with the airline), 'pending_approval' (still waiting,
// shown so they know it's in flight), or 'rejected' (needs to see why).
// 'approval_misconfigured' included too — the employee is the one who'll
// need to go ask their admin to fix it.
// ─────────────────────────────────────────────────────────────────────────────

const ACTIONABLE_STATUSES = ['approved', 'pending_approval', 'rejected', 'approval_misconfigured']

export async function GET() {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const service = createServiceClient()
  const { data: employee } = await service
    .from('employees')
    .select('id')
    .eq('id', user.id)
    .maybeSingle()

  if (!employee) {
    return Response.json({ error: 'Employee record not found' }, { status: 404 })
  }

  const { data: bookings, error } = await service
    .from('bookings')
    .select('id, status, total_cost, itinerary, updated_at')
    .eq('employee_id', employee.id)
    .in('status', ACTIONABLE_STATUSES)
    .order('updated_at', { ascending: false })

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  return Response.json({
    ok: true,
    bookings: (bookings ?? []).map(b => ({
      id: b.id,
      status: b.status,
      totalCost: b.total_cost,
      itinerary: b.itinerary,
      updatedAt: b.updated_at,
    })),
  })
}