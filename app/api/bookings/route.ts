import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { NextRequest } from 'next/server'
import { travellerItinerary, travellerFareBreakdown } from '@/app/lib/book/travellerView'

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
    // sell_total alongside total_cost: the traveller is shown what the company
    // is invoiced, never the airline figure. See the mapping below.
    .select('id, status, pnr, total_cost, sell_total, itinerary, traveler_snapshot, fare_breakdown, trip_id, created_at')
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
    sell_total: number | null
    itinerary: unknown
    traveler_snapshot: unknown
    fare_breakdown: unknown
    trip_id: string | null
    created_at: string
  }

  // ── The one number a traveller sees ────────────────────────────────────────
  // total_cost is what the AIRLINE charges and sell_total is what the company is
  // invoiced. A traveller is shown the latter, and the former is dropped here
  // rather than sent and ignored — a markup discoverable in a network response
  // is not hidden, whatever the UI renders.
  //
  // Mapped onto `total_cost` so nothing downstream changes; the fallback covers
  // bookings made before commercial rules existed.
  //
  // The itinerary and fare breakdown are projected too: the frozen itinerary
  // carries the airline's totalFare and fareOptions, and the breakdown its
  // per-passenger split. See app/lib/book/travellerView.
  function sellSide<T extends BookingRow>(row: T) {
    const { sell_total, ...rest } = row
    return {
      ...rest,
      total_cost: sell_total ?? row.total_cost,
      itinerary: travellerItinerary(row.itinerary),
      fare_breakdown: travellerFareBreakdown(row.fare_breakdown),
    }
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
  type SafeBooking = ReturnType<typeof sellSide<BookingRow>>
  const grouped = new Map<string, { trip: TripRow; bookings: SafeBooking[] }>()
  const ungrouped: SafeBooking[] = []

  for (const row of (bookings ?? []) as BookingRow[]) {
    const booking = sellSide(row)
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