import type { Queryable } from '@/app/lib/db'
import type { Principal } from '@/app/lib/auth/session'
import * as employees from '@/app/lib/repositories/employees'
import { canSelfBook, SELF_BOOKING_OFF } from '@/app/lib/clients/clientGates'

// ── Who is booking, for whom ─────────────────────────────────────────────────
// Every step of the booking flow (search, price, seat map, policy preview,
// add passenger, book, ticket, the booking's own page) asks the same two
// questions, and used to answer them separately: "the traveller is whoever is
// signed in" and "this booking is theirs if employee_id is them". Booking on
// someone's behalf changes both answers, so they live here, once.
//
//   booker                 may book for                  when
//   anyone                 themselves                    their client self-books
//   corporate admin        anyone at their own client    the client self-books (not CBT)
//   TMC admin              anyone at a client of the TMC
//   travel counsellor      anyone at a portfolio client  they hold book_on_behalf
//
// bookings.employee_id is always the TRAVELLER; bookings.booked_by is the
// booker (20261013000000_book_on_behalf).
//
// A traveller the caller may not book for gets the same answer as one who does
// not exist, so a refusal cannot be used to discover who works where. The
// refusals that are about the CALLER (their own role, a missing permission)
// say so, since they reveal nothing about anyone else.
// ─────────────────────────────────────────────────────────────────────────────

export type Via = 'self' | 'corporate_admin' | 'tmc'

export interface BookingActor {
  traveller: { id: string; client_id: string | null }
  bookerId: string
  via: Via
  // The traveller's client's booking mode: 'cbt' means its travel desk books
  // for it, policy is guidance there and no approval chain runs. Null for
  // `self`, which never needs it.
  bookingMode: string | null
}

export type ActorResult =
  | { ok: true; actor: BookingActor }
  | { ok: false; status: number; error: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const NOT_FOUND = { ok: false, status: 404, error: 'Traveller not found' } as const

export const PERMISSION = 'book_on_behalf'

// The answer to a response, for routes: `if (!r.ok) return refuse(r)`.
export function refuse(result: { status: number; error: string }): Response {
  return Response.json({ error: result.error }, { status: result.status })
}

// Who travels on this booking flow step. No travellerId (or the caller's own)
// means booking for oneself, with exactly the checks and messages that step
// has always had.
export async function resolveActor(
  db: Queryable,
  user: Principal,
  travellerId?: string | null
): Promise<ActorResult> {
  if (!travellerId || travellerId === user.id) {
    // A CBT-only client's people sign in to see their trips, but the travel
    // desk books for them (clientGates.selfBooking).
    if (!(await canSelfBook(db, user.employee?.clientId))) {
      return { ok: false, status: 403, error: SELF_BOOKING_OFF }
    }
    const me = await employees.traveller(db, user.id)
    if (!me) return { ok: false, status: 404, error: 'Employee record not found' }
    return { ok: true, actor: { traveller: me, bookerId: user.id, via: 'self', bookingMode: null } }
  }
  return onBehalf(db, user, travellerId)
}

// Booking for someone else: the table at the top of this file.
export async function onBehalf(db: Queryable, user: Principal, travellerId: string): Promise<ActorResult> {
  const me = user.employee
  const role = me?.role
  if (!me || (role !== 'admin' && role !== 'tmc_admin' && role !== 'tc')) {
    return { ok: false, status: 403, error: 'You can only book travel for yourself.' }
  }
  // Asked before looking the traveller up, so lacking it says nothing about them.
  if (role === 'tc' && !(await employees.hasPermission(db, user.id, PERMISSION))) {
    return { ok: false, status: 403, error: `Missing permission: ${PERMISSION}` }
  }

  // Not a uuid would otherwise reach the database as a cast error (a 500).
  if (!UUID.test(travellerId)) return NOT_FOUND
  const t = await employees.bookableTraveller(db, travellerId)
  // Invited people can travel -- a CBT client's staff may never sign in -- but
  // the deactivated cannot, nor anyone at a client that has been removed.
  if (!t || t.status === 'deactivated' || t.client_status === 'inactive') return NOT_FOUND

  let via: Via
  if (role === 'admin') {
    if (t.client_id !== me.clientId) return NOT_FOUND
    // A CBT client's travel desk books for it; its admin sees, but does not book.
    if (t.booking_mode === 'cbt') return { ok: false, status: 403, error: SELF_BOOKING_OFF }
    via = 'corporate_admin'
  } else {
    if (!me.tmcId || t.tmc_id !== me.tmcId) return NOT_FOUND
    if (role === 'tc' && !(await employees.hasClientAccess(db, user.id, t.client_id))) return NOT_FOUND
    via = 'tmc'
  }

  return {
    ok: true,
    actor: { traveller: { id: t.id, client_id: t.client_id }, bookerId: user.id, via, bookingMode: t.booking_mode },
  }
}

// For the routes given a booking id (book, ticket, the booking's own page):
// whom to act as. The booking's traveller, when the caller may book for them
// TODAY -- the booker included, so a counsellor moved off the client, or an
// admin who lost the role, loses the booking with it. Otherwise the caller
// themself, and the route's own checks then run exactly as they always have:
// the same refusals, in the same order, with the same messages.
export async function actingTraveller<T extends { id: string; client_id: string | null }>(
  db: Queryable,
  user: Principal,
  me: T,
  booking: { employee_id: string } | null
): Promise<{ traveller: { id: string; client_id: string | null }; onBehalf: boolean }> {
  if (!booking || booking.employee_id === me.id) return { traveller: me, onBehalf: false }
  const r = await onBehalf(db, user, booking.employee_id)
  return r.ok ? { traveller: r.actor.traveller, onBehalf: true } : { traveller: me, onBehalf: false }
}
