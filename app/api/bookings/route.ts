import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { NextRequest } from 'next/server'

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

export async function GET(req: NextRequest) {
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

  const { searchParams } = new URL(req.url)
  const limitParam = Number(searchParams.get('limit'))
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 100) : 50

  const { data: bookings, error } = await service
    .from('bookings')
    .select('id, status, pnr, total_cost, itinerary, traveler_snapshot, fare_breakdown, trip_id, created_at')
    .eq('employee_id', employee.id)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) {
    console.error('Bookings list error:', error)
    return Response.json({ error: 'Could not load your bookings' }, { status: 500 })
  }

  interface TripRow {
    id: string
    name: string
    status: string
    travel_date: string | null
    created_at: string
  }

  interface BookingRow {
    id: string
    status: string
    pnr: string | null
    total_cost: number | null
    itinerary: unknown
    traveler_snapshot: unknown
    fare_breakdown: unknown
    trip_id: string | null
    created_at: string
  }

  // Every trip that owns at least one of these bookings, plus any trip the
  // employee has with zero bookings yet (a trip they created but haven't
  // started booking flights for — still worth showing so it doesn't look
  // like it vanished). Scoped to this employee's own trips, same ownership
  // model as /api/trips.
  const { data: ownedTrips } = await service
    .from('trips')
    .select('id, name, status, travel_date, created_at')
    .eq('created_by', employee.id)
    .neq('status', 'deleted')
    .order('created_at', { ascending: false })

  const tripById = new Map<string, TripRow>((ownedTrips ?? []).map(t => [t.id, t as TripRow]))

  // Bookings without a trip_id (booked before trip-linking existed, or any
  // future path that still allows it) are grouped under a null "trip" —
  // the frontend renders these as a flat "Other flights" section.
  const grouped = new Map<string, { trip: TripRow; bookings: BookingRow[] }>()
  const ungrouped: BookingRow[] = []

  for (const booking of (bookings ?? []) as BookingRow[]) {
    if (booking.trip_id && tripById.has(booking.trip_id)) {
      const trip = tripById.get(booking.trip_id)!
      if (!grouped.has(trip.id)) grouped.set(trip.id, { trip, bookings: [] })
      grouped.get(trip.id)!.bookings.push(booking)
    } else {
      ungrouped.push(booking)
    }
  }

  // Trips with zero bookings still show up, sorted alongside the ones that
  // have bookings (most-recently-created trip first, matching /api/trips'
  // own ordering) — a newly created empty trip shouldn't look lost.
  for (const trip of (ownedTrips ?? []) as TripRow[]) {
    if (!grouped.has(trip.id)) grouped.set(trip.id, { trip, bookings: [] })
  }

  const trips = Array.from(grouped.values())
    .sort((a, b) => new Date(b.trip.created_at).getTime() - new Date(a.trip.created_at).getTime())

  return Response.json({ ok: true, trips, ungroupedBookings: ungrouped })
}