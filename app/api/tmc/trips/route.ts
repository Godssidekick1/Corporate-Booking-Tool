import { NextRequest } from 'next/server'
import { requireUser } from '@/app/lib/auth/session'
import { db } from '@/app/lib/db'
import * as trips from '@/app/lib/repositories/trips'
import * as bookingsRepo from '@/app/lib/repositories/bookings'
import { route } from '@/app/lib/http/handler'
import { parsePageParams, pagedResponse } from '@/app/lib/pagination'
import { reach, refuse, isUuid } from '@/app/lib/book/bookingActor'
import { travellerItinerary } from '@/app/lib/book/travellerView'

// ── GET /api/tmc/trips?scope=mine|desk&clientId=&page= ──────────────────────
// The trips the travel desk looks after, each with its bookings -- the same
// shape as GET /api/bookings, so the desk sees the same trip cards
// (app/components/trips/TripList):
//   scope=mine   the trips this counsellor set up for travellers, or booked into
//   scope=desk   every trip the desk set up or booked into, within the caller's
//                reach -- the whole TMC for its admin, a counsellor's portfolio
//                -- optionally one client
// Gated like booking for travellers (book_on_behalf for a counsellor). Every
// trip is the traveller's: these are the trips the desk keeps for them.
// ─────────────────────────────────────────────────────────────────────────────

export const GET = route(async (req: NextRequest) => {
  const user = await requireUser()
  const q = req.nextUrl.searchParams
  const params = parsePageParams(q)

  const r = await reach(db, user, 'history')
  if (!r.ok) return refuse(r)
  if (!('tmcId' in r)) return refuse({ status: 403, error: 'Only the travel desk keeps trips here.' })

  const clientId = q.get('clientId')
  const page = q.get('scope') === 'desk'
    ? await trips.forDesk(db, { tmcId: r.tmcId, clientIds: r.clientIds, clientId: isUuid(clientId) ? clientId : null }, user.id, params)
    : await trips.arrangedFor(db, user.id, params)

  const bookings = await bookingsRepo.forTrips(db, page.rows.map(t => t.id))
  const byTrip = new Map<string, typeof bookings>()
  for (const b of bookings) byTrip.set(b.trip_id, [...(byTrip.get(b.trip_id) ?? []), b])

  const paging = pagedResponse(page.rows, page.total, params)
  return Response.json({
    ok: true,
    // Sell-side (bookings.forTrips), itinerary projected: no provider keys.
    trips: page.rows.map(trip => ({
      trip,
      bookings: (byTrip.get(trip.id) ?? []).map(b => ({ ...b, itinerary: travellerItinerary(b.itinerary) })),
    })),
    ungroupedBookings: [],
    page: paging.page, pageSize: paging.pageSize, total: paging.total, totalPages: paging.totalPages,
  })
})
