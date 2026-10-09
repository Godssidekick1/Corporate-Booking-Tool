import { requireUser } from '@/app/lib/auth/session'
import { NextRequest } from 'next/server'
import { travellerItinerary, travellerFareBreakdown } from '@/app/lib/book/travellerView'
import { db } from '@/app/lib/db'
import * as employees from '@/app/lib/repositories/employees'
import * as bookingsRepo from '@/app/lib/repositories/bookings'
import * as trips from '@/app/lib/repositories/trips'
import { route } from '@/app/lib/http/handler'
import { parsePageParams, pagedResponse } from '@/app/lib/pagination'

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
  const user = await requireUser()

  const employee = await employees.traveller(db, user.id)

  if (!employee) {
    return Response.json({ error: 'Employee record not found' }, { status: 404 })
  }

  const { searchParams } = new URL(req.url)
  const params = parsePageParams(searchParams)
  // Bookings under no trip of their own, newest first, on the first page only.
  const limitParam = Number(searchParams.get('limit'))
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 100) : 50

  // ── The one number a traveller sees ────────────────────────────────────────
  // total_cost arrives already set to what the company is invoiced -- the
  // repository never selects the airline figure for a traveller (see
  // bookings.forTravellerInTrips). The itinerary and fare breakdown are
  // projected here: the breakdown's per-passenger split is the airline's, and
  // would expose a markup. See app/lib/book/travellerView.
  //
  // One page of the employee's own trips -- including any with zero bookings
  // yet (a trip they created but haven't started booking flights for, still
  // worth showing so it doesn't look like it vanished) -- and every booking
  // of theirs in those trips.
  const ownedTrips = await trips.ownedBy(db, employee.id, params)
  const [inTrips, outside] = await Promise.all([
    bookingsRepo.forTravellerInTrips(db, employee.id, ownedTrips.rows.map(t => t.id)),
    params.page === 1 ? bookingsRepo.forTravellerOutsideTrips(db, employee.id, limit) : Promise.resolve([]),
  ])
  const rows = [...inTrips, ...outside]

  const safe = rows.map(row => ({
    ...row,
    itinerary: travellerItinerary(row.itinerary),
    fare_breakdown: travellerFareBreakdown(row.fare_breakdown),
  }))
  type SafeBooking = typeof safe[number]

  const tripById = new Map(ownedTrips.rows.map(t => [t.id, t]))

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
  for (const trip of ownedTrips.rows) {
    if (!grouped.has(trip.id)) grouped.set(trip.id, { trip, bookings: [] })
  }

  const tripsWithBookings = Array.from(grouped.values())
    .sort((a, b) => new Date(b.trip.created_at).getTime() - new Date(a.trip.created_at).getTime())

  // Paged by TRIP: page n is the n-th ten of their trips with every booking
  // in them, so a trip is never split across pages.
  const paging = pagedResponse(tripsWithBookings, ownedTrips.total, params)
  return Response.json({
    ok: true,
    trips: tripsWithBookings,
    ungroupedBookings: ungrouped,
    page: paging.page,
    pageSize: paging.pageSize,
    total: paging.total,
    totalPages: paging.totalPages,
  })
})
