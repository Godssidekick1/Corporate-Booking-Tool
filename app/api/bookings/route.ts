import { createClient } from '@/utils/supabase/server'
import { NextRequest } from 'next/server'
import { travellerItinerary, travellerFareBreakdown } from '@/app/lib/book/travellerView'
import { db } from '@/app/lib/db'
import * as employees from '@/app/lib/repositories/employees'
import * as bookingsRepo from '@/app/lib/repositories/bookings'
import * as trips from '@/app/lib/repositories/trips'
import { route } from '@/app/lib/http/handler'

// ── GET /api/bookings ─────────────────────────────────────────────────────────
// Lists bookings for the logged-in employee — this is the data behind
// "My trips" (/bookings), which the dashboard already links to for every
// role. Scoped to the caller's own employee_id only, same ownership model
// as /api/book/[bookingId] — this is a personal trip list, not a team or
// client-wide view (that's a separate reporting concern, not this page).
//
// Returns a slimmer projection than the full booking row — enough for a
// list card (route, dates, status, traveler count, fare) without pulling
// the full traveler_snapshot/itinerary blob for every row.
// ─────────────────────────────────────────────────────────────────────────────

export const GET = route(async (req: NextRequest) => {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const employee = await employees.traveller(db, user.id)

  if (!employee) {
    return Response.json({ error: 'Employee record not found' }, { status: 404 })
  }

  const { searchParams } = new URL(req.url)
  const limitParam = Number(searchParams.get('limit'))
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 100) : 50

  // ── The one number a traveller sees ────────────────────────────────────────
  // total_cost arrives already set to what the company is invoiced -- the
  // repository never selects the airline figure for a traveller (see
  // bookings.forTraveller). The itinerary and fare breakdown are projected
  // here: the breakdown's per-passenger split is the airline's, and would
  // expose a markup. See app/lib/book/travellerView.
  //
  // Every trip that owns at least one of these bookings, plus any trip the
  // employee has with zero bookings yet (a trip they created but haven't
  // started booking flights for — still worth showing so it doesn't look
  // like it vanished). Scoped to this employee's own trips, same ownership
  // model as /api/trips.
  const [rows, ownedTrips] = await Promise.all([
    bookingsRepo.forTraveller(db, employee.id, limit),
    trips.ownedBy(db, employee.id),
  ])

  const safe = rows.map(row => ({
    ...row,
    itinerary: travellerItinerary(row.itinerary),
    fare_breakdown: travellerFareBreakdown(row.fare_breakdown),
  }))
  type SafeBooking = typeof safe[number]

  const tripById = new Map(ownedTrips.map(t => [t.id, t]))

  // Bookings without a trip_id (booked before trip-linking existed, or any
  // future path that still allows it) are grouped under a null "trip" —
  // the frontend renders these as a flat "Other flights" section.
  const grouped = new Map<string, { trip: trips.OwnedTrip; bookings: SafeBooking[] }>()
  const ungrouped: SafeBooking[] = []

  for (const booking of safe) {
    const trip = booking.trip_id ? tripById.get(booking.trip_id) : undefined
    if (trip) {
      if (!grouped.has(trip.id)) grouped.set(trip.id, { trip, bookings: [] })
      grouped.get(trip.id)!.bookings.push(booking)
    } else {
      ungrouped.push(booking)
    }
  }

  // Trips with zero bookings still show up, sorted alongside the ones that
  // have bookings (most-recently-created trip first, matching /api/trips'
  // own ordering) — a newly created empty trip shouldn't look lost.
  for (const trip of ownedTrips) {
    if (!grouped.has(trip.id)) grouped.set(trip.id, { trip, bookings: [] })
  }

  const tripsWithBookings = Array.from(grouped.values())
    .sort((a, b) => new Date(b.trip.created_at).getTime() - new Date(a.trip.created_at).getTime())

  return Response.json({ ok: true, trips: tripsWithBookings, ungroupedBookings: ungrouped })
})
