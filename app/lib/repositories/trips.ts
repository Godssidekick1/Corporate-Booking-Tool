import { sql, many, maybeOne, one, type Queryable } from '@/app/lib/db/sql'
import type { Row } from '@/app/lib/db/types.generated'

// ── Trips ────────────────────────────────────────────────────────────────────
// Owns: trips, trip_expenses.
//
// A trip is a named container a traveller groups one journey's bookings and
// expenses under. Scoped to its creator: "my trips", not the client's.
// ─────────────────────────────────────────────────────────────────────────────

export type TripListRow = Pick<Row<'trips'>, 'id' | 'name' | 'status' | 'travel_date' | 'created_at' | 'updated_at'>

// Deleted trips are hidden; deletion is a status, never a row removal.
export async function mine(db: Queryable, clientId: string | null, createdBy: string): Promise<TripListRow[]> {
  return many<TripListRow>(db, sql`
    select id, name, status, travel_date, created_at, updated_at from trips
    where client_id = ${clientId} and created_by = ${createdBy} and status <> 'deleted'
    order by updated_at desc, id`)
}

export type OwnedTrip = Pick<Row<'trips'>, 'id' | 'name' | 'status' | 'travel_date' | 'created_at'>

// Every live trip a person created, across clients -- what /api/bookings
// groups their bookings under.
export async function ownedBy(db: Queryable, createdBy: string): Promise<OwnedTrip[]> {
  return many<OwnedTrip>(db, sql`
    select id, name, status, travel_date, created_at from trips
    where created_by = ${createdBy} and status <> 'deleted'
    order by created_at desc, id`)
}

export async function create(
  db: Queryable,
  t: Pick<Row<'trips'>, 'client_id' | 'created_by' | 'name'>
): Promise<Pick<Row<'trips'>, 'id' | 'name' | 'status'>> {
  return one(db, sql`
    insert into trips (client_id, created_by, name, status)
    values (${t.client_id}, ${t.created_by}, ${t.name}, 'open')
    returning id, name, status`)
}

export type TripRecord = Pick<Row<'trips'>,
  'id' | 'name' | 'status' | 'travel_date' | 'created_by' | 'client_id' | 'created_at'>

export async function trip(db: Queryable, tripId: string): Promise<TripRecord | null> {
  return maybeOne<TripRecord>(db, sql`
    select id, name, status, travel_date, created_by, client_id, created_at from trips where id = ${tripId}`)
}

export async function setStatus(
  db: Queryable,
  tripId: string,
  status: string
): Promise<Pick<Row<'trips'>, 'id' | 'status'> | null> {
  return maybeOne(db, sql`update trips set status = ${status} where id = ${tripId} returning id, status`)
}

export type TripExpense = Pick<Row<'trip_expenses'>,
  'id' | 'expense_type' | 'amount' | 'currency' | 'description' | 'expense_date' | 'created_at'>

export async function expenses(db: Queryable, tripId: string): Promise<TripExpense[]> {
  return many<TripExpense>(db, sql`
    select id, expense_type, amount, currency, description, expense_date, created_at
    from trip_expenses where trip_id = ${tripId}
    order by created_at, id`)
}
