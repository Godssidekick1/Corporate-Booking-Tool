import { requireUser, type Principal } from '@/app/lib/auth/session'
import { db } from '@/app/lib/db'
import * as employees from '@/app/lib/repositories/employees'
import * as trips from '@/app/lib/repositories/trips'
import { onBehalf } from '@/app/lib/book/bookingActor'

// ── Who may act on a trip ────────────────────────────────────────────────────
// The trip's owner, the traveller -- or whoever may book for them (the rules
// of app/lib/book/bookingActor.ts: an admin colleague, the travel desk within
// its reach), since they add that traveller's flights to it and submit it for
// sign-off on their behalf. `mine` tells a page which of the two it shows, so
// a trip kept for someone else is labelled as theirs.
//
// Shared by every trip route (view, edit, delete, submit) so the rule cannot
// drift between them.
// ─────────────────────────────────────────────────────────────────────────────

export type TripAccess =
  | { error: Response }
  | { error?: undefined; trip: trips.TripRecord; mine: boolean; callerId: string; user: Principal }

export async function tripAccess(tripId: string, verb: string): Promise<TripAccess> {
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

  return { trip, mine: trip.created_by === employee.id, callerId: employee.id, user }
}
