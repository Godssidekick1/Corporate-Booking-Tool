import { createClient } from '@/utils/supabase/server'
import { NextRequest } from 'next/server'
import { travellerItinerary, travellerFareBreakdown } from '@/app/lib/book/travellerView'
import { db } from '@/app/lib/db'
import * as employees from '@/app/lib/repositories/employees'
import * as bookingsRepo from '@/app/lib/repositories/bookings'
import { route } from '@/app/lib/http/handler'

// ── GET /api/bookings/recent ─────────────────────────────────────────────────
// Feeds the dashboard's "Recent bookings" widget. Distinct from
// /api/bookings (which powers /bookings — "My trips", always personal-
// scoped) because visibility here depends on role:
//
//   employee — own bookings only
//   manager / finance — own bookings, plus bookings made by their direct
//                        reports (employees.manager_id === this employee)
//   admin — every booking in the client
//
// Returns a slim projection (route/dates/status/fare/traveler name) rather
// than full traveler_snapshot/itinerary — enough for a preview card list,
// not a detail view.
// ─────────────────────────────────────────────────────────────────────────────

export const GET = route(async (req: NextRequest) => {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const employee = await employees.scope(db, user.id)

  if (!employee) {
    return Response.json({ error: 'Employee record not found' }, { status: 404 })
  }

  const { searchParams } = new URL(req.url)
  const limitParam = Number(searchParams.get('limit'))
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 50) : 5

  let employeeIds: string[]

  if (employee.role === 'admin') {
    employeeIds = await employees.idsInClient(db, employee.client_id)
  } else if (employee.role === 'manager' || employee.role === 'finance') {
    employeeIds = [employee.id, ...(await employees.directReportIds(db, employee.id))]
  } else {
    employeeIds = [employee.id]
  }

  if (employeeIds.length === 0) {
    return Response.json({ ok: true, bookings: [] })
  }

  const bookings = await bookingsRepo.recentFor(db, employeeIds, limit)

  // Traveler names for display — only fetch the employees actually present
  // in this page of results, not the whole employeeIds scope (which for
  // admin could be the entire client).
  const nameById = await employees.namesByIds(db, Array.from(new Set(bookings.map(b => b.employee_id))))

  const result = bookings.map(b => ({
    id: b.id,
    status: b.status,
    pnr: b.pnr,
    // Already the sell figure: the repository never selects the airline one
    // for a traveller (see bookings.recentFor).
    totalCost: b.total_cost,
    // Projected: the breakdown's per-passenger split is the airline's and
    // would expose a markup. See app/lib/book/travellerView.
    itinerary: travellerItinerary(b.itinerary),
    fareBreakdown: travellerFareBreakdown(b.fare_breakdown),
    createdAt: b.created_at,
    travelerName: nameById.get(b.employee_id) ?? null,
    isOwn: b.employee_id === employee.id,
  }))

  return Response.json({ ok: true, bookings: result })
})
