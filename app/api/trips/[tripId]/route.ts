import { requireUser } from '@/app/lib/auth/session'
import { NextRequest } from 'next/server'
import { travellerItinerary } from '@/app/lib/book/travellerView'
import { db } from '@/app/lib/db'
import * as employees from '@/app/lib/repositories/employees'
import * as trips from '@/app/lib/repositories/trips'
import * as bookingsRepo from '@/app/lib/repositories/bookings'
import { route } from '@/app/lib/http/handler'
import { onBehalf } from '@/app/lib/book/bookingActor'
import * as clients from '@/app/lib/repositories/clients'
import { parseTripDetails } from '@/app/lib/trips/details'

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
// Two jobs, either or both in one request:
//   - status: only 'completed' -- marking a trip complete once the traveller
//     is done. Kept narrow rather than a general status setter: 'cancelled'
//     and 'deleted' have their own flows (DELETE below). At a company that
//     signs trips off, a trip is complete only once it is signed off.
//   - its name and details (app/lib/trips/details.ts). Not while the trip is
//     awaiting sign-off or signed off: the approver signs off what they saw.
//     A rejected trip can be edited and submitted again.

const PATCHABLE_STATUSES = ['completed'] as const

interface PatchTripBody extends Record<string, unknown> {
  status?: typeof PATCHABLE_STATUSES[number]
  name?: string
}

export const PATCH = route(async (req: NextRequest, { params }: Ctx) => {
  const { tripId } = await params
  const own = await ownTrip(tripId, 'edit')
  if (own.error) return own.error

  const body: PatchTripBody = await req.json()

  if (own.trip.status === 'deleted' || own.trip.status === 'cancelled') {
    return Response.json({
      error: `This trip is ${own.trip.status} and can't be ${body.status === 'completed' ? 'marked complete' : 'changed'}.`,
    }, { status: 409 })
  }

  if (body.status !== undefined && !PATCHABLE_STATUSES.includes(body.status)) {
    return Response.json({ error: `status must be one of: ${PATCHABLE_STATUSES.join(', ')}` }, { status: 400 })
  }

  const parsed = parseTripDetails(body)
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 })
  const edit: trips.TripDetails & { name?: string } = { ...parsed.details }
  if ('name' in body) {
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (!name) return Response.json({ error: 'Trip name is required' }, { status: 400 })
    edit.name = name
  }
  const editing = Object.keys(edit).length > 0
  if (!editing && body.status === undefined) {
    return Response.json({ error: 'Nothing to change' }, { status: 400 })
  }

  if (editing && (own.trip.approval_status === 'pending' || own.trip.approval_status === 'approved')) {
    return Response.json({
      error: own.trip.approval_status === 'pending'
        ? 'This trip is awaiting sign-off and cannot be changed until it is decided.'
        : 'This trip is signed off and cannot be changed.',
    }, { status: 409 })
  }
  if (edit.cost_centre_id && !(await clients.costCentreBelongs(db, edit.cost_centre_id, own.trip.client_id))) {
    return Response.json({ error: 'That cost centre is not one of this company\'s' }, { status: 422 })
  }

  if (body.status === 'completed' && own.trip.approval_status !== 'approved') {
    const modes = await clients.approvalModes(db, own.trip.client_id)
    if (modes?.trip_approval_mode === 'on_submit') {
      return Response.json({ error: 'This company signs trips off: submit it for approval first.' }, { status: 409 })
    }
  }

  if (editing) await trips.update(db, tripId, edit)
  if (body.status) await trips.setStatus(db, tripId, body.status)

  const updated = await trips.trip(db, tripId)
  if (!updated) return Response.json({ error: 'Trip not found' }, { status: 404 })
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
