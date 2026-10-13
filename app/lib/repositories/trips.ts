import { sql, many, maybeOne, one, type Queryable } from '@/app/lib/db/sql'
import { page } from '@/app/lib/db/fragments'
import type { PageParams } from '@/app/lib/pagination'
import type { Row } from '@/app/lib/db/types.generated'

// ── Trips ────────────────────────────────────────────────────────────────────
// Owns: trips, trip_expenses.
//
// A trip is a named container a traveller groups one journey's bookings and
// expenses under. Scoped to its creator: "my trips", not the client's.
// ─────────────────────────────────────────────────────────────────────────────

export type TripListRow = Pick<Row<'trips'>, 'id' | 'name' | 'status' | 'travel_date' | 'created_at' | 'updated_at'>
  // Who set it up for them, when it was not them.
  & { arranged_by_name: string | null }

// Deleted trips are hidden; deletion is a status, never a row removal.
// One page, most recently touched first. Paged: a frequent traveller's trips
// accumulate for years.
export async function mine(
  db: Queryable, clientId: string | null, createdBy: string, params: PageParams
): Promise<{ rows: TripListRow[]; total: number }> {
  const where = sql`client_id = ${clientId} and created_by = ${createdBy} and status <> 'deleted'`
  const [rows, count] = await Promise.all([
    many<TripListRow>(db, sql`
      select id, name, status, travel_date, created_at, updated_at,
             (select a.full_name from employees a where a.id = trips.arranged_by and trips.arranged_by <> trips.created_by)
               as arranged_by_name
      from trips
      where ${where} order by updated_at desc, id ${page(params)}`),
    one<{ n: number }>(db, sql`select count(*)::int as n from trips where ${where}`),
  ])
  return { rows, total: count.n }
}

export type OwnedTrip = Pick<Row<'trips'>, 'id' | 'name' | 'status' | 'travel_date' | 'created_at'>
  // Who set it up for them (the desk, or an admin colleague); null when they did.
  & { arranged_by_name: string | null }

// Every live trip a person created, across clients -- what /api/bookings
// groups their bookings under.
// One page of them, newest first.
export async function ownedBy(
  db: Queryable, createdBy: string, params: PageParams
): Promise<{ rows: OwnedTrip[]; total: number }> {
  const where = sql`trips.created_by = ${createdBy} and trips.status <> 'deleted'`
  const [rows, count] = await Promise.all([
    many<OwnedTrip>(db, sql`
      select trips.id, trips.name, trips.status, trips.travel_date, trips.created_at, a.full_name as arranged_by_name
      from trips left join employees a on a.id = trips.arranged_by and trips.arranged_by <> trips.created_by
      where ${where} order by trips.created_at desc, trips.id ${page(params)}`),
    one<{ n: number }>(db, sql`select count(*)::int as n from trips where ${where}`),
  ])
  return { rows, total: count.n }
}

export type ArrangedTrip = Pick<Row<'trips'>, 'id' | 'name' | 'status' | 'travel_date' | 'created_at'> & {
  traveller_id: string
  traveller_name: string | null
  // True when the caller set the trip up; false when it is the traveller's
  // own trip that the caller booked something into.
  arranged_by_me: boolean
}

// The trips someone looks after for OTHER people: ones they set up for a
// colleague (arranged_by), and the colleague's own trips they booked into.
// Never their own trips -- those are ownedBy. One page, newest first.
export async function arrangedFor(
  db: Queryable, bookerId: string, params: PageParams
): Promise<{ rows: ArrangedTrip[]; total: number }> {
  // From the two small sets -- trips they set up (trips_arranged_by_idx) and
  // trips holding a booking they made for someone (bookings_booked_by_recent_idx)
  // -- never a scan of every trip.
  const from = sql`
    trips t
    join (select id from trips where arranged_by = ${bookerId}
          union
          select trip_id from bookings
          where booked_by = ${bookerId} and employee_id <> ${bookerId} and trip_id is not null) mine
      on mine.id = t.id`
  const where = sql`t.status <> 'deleted' and t.created_by <> ${bookerId}`
  const [rows, count] = await Promise.all([
    many<ArrangedTrip>(db, sql`
      select t.id, t.name, t.status, t.travel_date, t.created_at,
             t.created_by as traveller_id, e.full_name as traveller_name,
             (t.arranged_by is not distinct from ${bookerId}::uuid) as arranged_by_me
      from ${from} left join employees e on e.id = t.created_by
      where ${where} order by t.created_at desc, t.id ${page(params)}`),
    one<{ n: number }>(db, sql`select count(*)::int as n from ${from} where ${where}`),
  ])
  return { rows, total: count.n }
}

// created_by is the trip's owner, the traveller; arranged_by whoever set it
// up for them (the travel desk, or an admin colleague), null when they did.
export async function create(
  db: Queryable,
  t: Pick<Row<'trips'>, 'client_id' | 'created_by' | 'name'> & { arranged_by?: string | null }
): Promise<Pick<Row<'trips'>, 'id' | 'name' | 'status'>> {
  return one(db, sql`
    insert into trips (client_id, created_by, arranged_by, name, status)
    values (${t.client_id}, ${t.created_by}, ${t.arranged_by ?? null}, ${t.name}, 'open')
    returning id, name, status`)
}

export type TripRecord = Pick<Row<'trips'>,
  'id' | 'name' | 'status' | 'travel_date' | 'created_by' | 'client_id' | 'created_at' | 'arranged_by'>

export async function trip(db: Queryable, tripId: string): Promise<TripRecord | null> {
  return maybeOne<TripRecord>(db, sql`
    select id, name, status, travel_date, created_by, client_id, created_at, arranged_by
    from trips where id = ${tripId}`)
}

// Whose trip it is and who set it up, by name: the trip page's header.
export async function people(
  db: Queryable, tripId: string
): Promise<{ traveller_name: string | null; arranged_by_name: string | null }> {
  return one(db, sql`
    select e.full_name as traveller_name,
           (select a.full_name from employees a where a.id = t.arranged_by and t.arranged_by <> t.created_by) as arranged_by_name
    from trips t left join employees e on e.id = t.created_by
    where t.id = ${tripId}`)
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
