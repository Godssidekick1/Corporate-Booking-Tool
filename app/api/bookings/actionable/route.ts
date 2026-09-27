import { requireUser } from '@/app/lib/auth/session'
import { travellerItinerary } from '@/app/lib/book/travellerView'
import { db } from '@/app/lib/db'
import * as employees from '@/app/lib/repositories/employees'
import * as bookingsRepo from '@/app/lib/repositories/bookings'
import { route } from '@/app/lib/http/handler'

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

export const GET = route(async () => {
  const user = await requireUser()

  const employee = await employees.traveller(db, user.id)

  if (!employee) {
    return Response.json({ error: 'Employee record not found' }, { status: 404 })
  }

  const bookings = await bookingsRepo.actionableFor(db, employee.id, ACTIONABLE_STATUSES)

  return Response.json({
    ok: true,
    bookings: bookings.map(b => ({
      id: b.id,
      status: b.status,
      // Already the sell figure (see bookings.actionableFor).
      totalCost: b.total_cost,
      // Projected: the frozen itinerary carries provider keys.
      itinerary: travellerItinerary(b.itinerary),
      updatedAt: b.updated_at,
    })),
  })
})
