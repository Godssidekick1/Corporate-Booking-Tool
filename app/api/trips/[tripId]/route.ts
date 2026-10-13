import { requireUser } from '@/app/lib/auth/session'
import { NextRequest } from 'next/server'
import { travellerItinerary } from '@/app/lib/book/travellerView'
import { db } from '@/app/lib/db'
import * as employees from '@/app/lib/repositories/employees'
import * as trips from '@/app/lib/repositories/trips'
import * as bookingsRepo from '@/app/lib/repositories/bookings'
import { route } from '@/app/lib/http/handler'
import { onBehalf } from '@/app/lib/book/bookingActor'

// GET /api/trips/[tripId] — one trip's workspace: the trip itself, every
// booking attached to it (flights, and hotels/cabs once those exist), and
// every misc expense logged against it.

type Ctx = { params: Promise<{ tripId: string }> }

// The caller and the trip, with the ownership check every verb shares.
//
// The trip's owner, the traveller -- or whoever may book for them (the rules
// of app/lib/book/bookingActor.ts: an admin colleague, for one), since they
// add that traveller's flights to it. `mine` tells the page which of the two
// it is showing, so a trip kept for someone else is labelled as theirs.
async function ownTrip(tripId: string, verb: string) {
  const user = await requireUser()

  const employee = await employees.traveller(db, user.id)

  if (!employee) {
    return { error: Response.json({ error: 'Employee record not found' }, { status: 404 }) }
  }

  const trip = await trips.trip(db, tripId)

  if (!trip) {
    return { error: Response.json({ error: 'Trip not found' }, { status: 404 }) }
  }

  if (trip.created_by !== employee.id) {
    const allowed = trip.created_by ? await onBehalf(db, user, trip.created_by) : null
    if (!allowed?.ok) {
      return { error: Response.json({ error: `Not authorized to ${verb} this trip` }, { status: 403 }) }
    }
  }

  return { trip, mine: trip.created_by === employee.id, callerId: employee.id }
}

export const GET = route(async (req: NextRequest, { params }: Ctx) => {
  const { tripId } = await params
  const own = await ownTrip(tripId, 'view')
  if (own.error) return own.error

  const [bookings, expenses, people] = await Promise.all([
    bookingsRepo.forTrip(db, tripId),
    trips.expenses(db, tripId),
    trips.people(db, tripId),
  ])

  return Response.json({
    ok: true,
    trip: own.trip,
    // Whose trip this is, and who set it up when it was not them.
    mine: own.mine,
    traveller: { id: own.trip.created_by, name: people.traveller_name },
    arrangedByName: people.arranged_by_name,
    // total_cost is already the sell figure, never the airline one (see
    // bookings.forTrip). The itinerary is projected: it carries provider keys.
    bookings: bookings.map(b => ({ ...b, itinerary: travellerItinerary(b.itinerary) })),
    expenses,
  })
})

// ── PATCH /api/trips/[tripId] ─────────────────────────────────────────────
// Updates a trip's status. Currently only used to mark a trip complete once
// the traveler is done planning/traveling — kept narrow (only 'completed'
// accepted) rather than a general-purpose status setter, since 'cancelled'
// and 'deleted' have their own dedicated flows (DELETE below) with their
// own semantics, and 'open'/'active' aren't something the UI currently
// needs to set explicitly.

const PATCHABLE_STATUSES = ['completed'] as const

interface PatchTripBody {
  status: typeof PATCHABLE_STATUSES[number]
}

export const PATCH = route(async (req: NextRequest, { params }: Ctx) => {
  const { tripId } = await params
  const own = await ownTrip(tripId, 'edit')
  if (own.error) return own.error

  const body: PatchTripBody = await req.json()

  if (!PATCHABLE_STATUSES.includes(body.status)) {
    return Response.json({ error: `status must be one of: ${PATCHABLE_STATUSES.join(', ')}` }, { status: 400 })
  }

  if (own.trip.status === 'deleted' || own.trip.status === 'cancelled') {
    return Response.json({ error: `This trip is ${own.trip.status} and can't be marked complete.` }, { status: 409 })
  }

  const updated = await trips.setStatus(db, tripId, body.status)

  if (!updated) {
    return Response.json({ error: 'Trip not found' }, { status: 404 })
  }

  return Response.json({ ok: true, trip: updated })
})

// ── DELETE /api/trips/[tripId] ────────────────────────────────────────────
// Soft-delete only — sets status: 'deleted' rather than removing the row.
// A trip can have real bookings (PNRs, money already spent with an airline)
// and trip_expenses attached via trip_id; hard-deleting would either orphan
// those children or cascade-delete real financial records. 'deleted' is
// kept distinct from 'cancelled' (which means the travel itself was called
// off) so a draft someone abandons and a booked trip that fell through stay
// separable in reporting later. The list route filters status: 'deleted'
// out by default.

export const DELETE = route(async (req: NextRequest, { params }: Ctx) => {
  const { tripId } = await params
  const own = await ownTrip(tripId, 'delete')
  if (own.error) return own.error
  // Someone else's trip goes only at the hand of whoever set it up: an admin
  // may book into a colleague's own trip, but it stays the colleague's to drop.
  if (!own.mine && own.trip.arranged_by !== own.callerId) {
    return Response.json({ error: 'Only the traveller, or whoever set this trip up, can delete it' }, { status: 403 })
  }

  if (own.trip.status === 'deleted') {
    return Response.json({ ok: true, trip: { id: own.trip.id, status: 'deleted' } })
  }

  const updated = await trips.setStatus(db, tripId, 'deleted')

  if (!updated) {
    return Response.json({ error: 'Trip not found' }, { status: 404 })
  }

  return Response.json({ ok: true, trip: updated })
})
