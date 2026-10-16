import { sql, many, maybeOne, one, exec, type Queryable } from '@/app/lib/db/sql'
import { page, assignments } from '@/app/lib/db/fragments'
import type { PageParams } from '@/app/lib/pagination'
import type { Row } from '@/app/lib/db/types.generated'

// ── Trips ────────────────────────────────────────────────────────────────────
// Owns: trips, trip_expenses.
//
// A trip is a named container a traveller groups one journey's bookings and
// expenses under. Scoped to its creator: "my trips", not the client's.
// ─────────────────────────────────────────────────────────────────────────────

// ── What a trip card shows, the same for every list ─────────────────────────
// Its details (travel type, billable, cost centre, budget, ...), its sign-off,
// who set it up when it was not the traveller, and a summary of its LIVE
// bookings -- cancelled, failed and rejected ones do not count towards what
// the trip costs. The total is the sell side, what the company is invoiced,
// as on every traveller read. Read through `t` with CARD_JOINS.
export interface TripCardRow {
  id: string
  name: string | null
  status: string
  travel_date: string | null
  created_at: string
  updated_at: string
  travel_type: 'domestic' | 'international' | null
  billable: boolean
  project: string | null
  currency: string
  budget_amount: number | null
  cost_centre_id: string | null
  cost_centre_code: string | null
  cost_centre_name: string | null
  approval_status: TripApprovalStatus
  submitted_at: string | null
  arranged_by_name: string | null
  flight_count: number
  total_cost: number
  first_departure: string | null
}

const TRIP_CARD = sql`
  t.id, t.name, t.status, t.travel_date, t.created_at, t.updated_at,
  t.travel_type, t.billable, t.project, t.currency, t.budget_amount, t.cost_centre_id,
  cc.code as cost_centre_code, cc.name as cost_centre_name,
  t.approval_status, t.submitted_at,
  (select a.full_name from employees a where a.id = t.arranged_by and t.arranged_by <> t.created_by) as arranged_by_name,
  agg.flight_count, agg.total_cost, agg.first_departure`

// The card's joins: the cost centre's name, and the bookings summary (one
// index lookup per trip, idx_bookings_group).
const CARD_JOINS = sql`
  left join cost_centres cc on cc.id = t.cost_centre_id
  left join lateral (
    select count(*)::int as flight_count,
           coalesce(sum(coalesce(b.sell_total, b.total_cost)), 0) as total_cost,
           min(b.itinerary->'origin'->>'dateTime') as first_departure
    from bookings b
    where b.trip_id = t.id and b.status not in ('cancelled', 'failed', 'rejected')
  ) agg on true`

export type TripListRow = TripCardRow

// Deleted trips are hidden; deletion is a status, never a row removal.
// One page, most recently touched first. Paged: a frequent traveller's trips
// accumulate for years.
export async function mine(
  db: Queryable, clientId: string | null, createdBy: string, params: PageParams
): Promise<{ rows: TripListRow[]; total: number }> {
  const where = sql`t.client_id = ${clientId} and t.created_by = ${createdBy} and t.status <> 'deleted'`
  const [rows, count] = await Promise.all([
    many<TripListRow>(db, sql`
      select ${TRIP_CARD} from trips t ${CARD_JOINS}
      where ${where} order by t.updated_at desc, t.id ${page(params)}`),
    one<{ n: number }>(db, sql`select count(*)::int as n from trips t where ${where}`),
  ])
  return { rows, total: count.n }
}

export type OwnedTrip = TripCardRow

// Every live trip a person created, across clients -- what /api/bookings
// groups their bookings under.
// One page of them, newest first.
export async function ownedBy(
  db: Queryable, createdBy: string, params: PageParams
): Promise<{ rows: OwnedTrip[]; total: number }> {
  const where = sql`t.created_by = ${createdBy} and t.status <> 'deleted'`
  const [rows, count] = await Promise.all([
    many<OwnedTrip>(db, sql`
      select ${TRIP_CARD} from trips t ${CARD_JOINS}
      where ${where} order by t.created_at desc, t.id ${page(params)}`),
    one<{ n: number }>(db, sql`select count(*)::int as n from trips t where ${where}`),
  ])
  return { rows, total: count.n }
}

export type ArrangedTrip = TripCardRow & {
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
      select ${TRIP_CARD},
             t.created_by as traveller_id, e.full_name as traveller_name,
             (t.arranged_by is not distinct from ${bookerId}::uuid) as arranged_by_me
      from ${from} left join employees e on e.id = t.created_by ${CARD_JOINS}
      where ${where} order by t.created_at desc, t.id ${page(params)}`),
    one<{ n: number }>(db, sql`select count(*)::int as n from ${from} where ${where}`),
  ])
  return { rows, total: count.n }
}

// created_by is the trip's owner, the traveller; arranged_by whoever set it
// up for them (the travel desk, or an admin colleague), null when they did.
// A trip's details, as the new-trip form and the trip page edit them.
// Validated by app/lib/trips/details.ts before they get here.
export interface TripDetails {
  travel_type?: 'domestic' | 'international' | null
  billable?: boolean
  project?: string | null
  currency?: string
  budget_amount?: number | null
  cost_centre_id?: string | null
}

export async function create(
  db: Queryable,
  t: Pick<Row<'trips'>, 'client_id' | 'created_by' | 'name'> & { arranged_by?: string | null } & TripDetails
): Promise<Pick<Row<'trips'>, 'id' | 'name' | 'status'>> {
  return one(db, sql`
    insert into trips (client_id, created_by, arranged_by, name, status,
                       travel_type, billable, project, currency, budget_amount, cost_centre_id)
    values (${t.client_id}, ${t.created_by}, ${t.arranged_by ?? null}, ${t.name}, 'open',
            ${t.travel_type ?? null}, ${t.billable ?? false}, ${t.project ?? null}, ${t.currency ?? 'INR'},
            ${t.budget_amount ?? null}, ${t.cost_centre_id ?? null})
    returning id, name, status`)
}

const EDITABLE = {
  name: sql`name`, travel_type: sql`travel_type`, billable: sql`billable`, project: sql`project`,
  currency: sql`currency`, budget_amount: sql`budget_amount`, cost_centre_id: sql`cost_centre_id`,
} as const

export async function update(db: Queryable, tripId: string, patch: TripDetails & { name?: string }): Promise<void> {
  if (Object.keys(patch).length === 0) return
  await exec(db, sql`update trips set ${assignments(EDITABLE, patch)}, updated_at = now() where id = ${tripId}`)
}

export type TripRecord = TripCardRow & Pick<Row<'trips'>, 'created_by' | 'client_id' | 'arranged_by'>

export async function trip(db: Queryable, tripId: string): Promise<TripRecord | null> {
  return maybeOne<TripRecord>(db, sql`
    select ${TRIP_CARD}, t.created_by, t.client_id, t.arranged_by
    from trips t ${CARD_JOINS} where t.id = ${tripId}`)
}

// The verdicts of a trip's live bookings: the sign-off is routed on the worst.
export async function liveBookings(db: Queryable, tripId: string): Promise<{ status: string; policy_verdict: string | null }[]> {
  return many(db, sql`
    select status, policy_verdict from bookings
    where trip_id = ${tripId} and status not in ('cancelled', 'failed', 'rejected')
    order by created_at, id`)
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

// ── The trip's sign-off ─────────────────────────────────────────────────────

export type TripApprovalTarget = Pick<Row<'trips'>, 'id' | 'client_id' | 'created_by' | 'approval_status'>

export async function approvalTarget(db: Queryable, tripId: string): Promise<TripApprovalTarget | null> {
  return maybeOne<TripApprovalTarget>(db, sql`
    select id, client_id, created_by, approval_status from trips where id = ${tripId}`)
}

export type TripApprovalStatus = 'none' | 'pending' | 'approved' | 'rejected' | 'misconfigured'

export async function setApprovalStatus(db: Queryable, tripId: string, status: TripApprovalStatus): Promise<void> {
  await exec(db, sql`
    update trips set approval_status = ${status}, updated_at = now(),
           submitted_at = case when ${status} = 'pending' then now() else submitted_at end
    where id = ${tripId}`)
}

export async function setStatus(
  db: Queryable,
  tripId: string,
  status: string
): Promise<Pick<Row<'trips'>, 'id' | 'status'> | null> {
  return maybeOne(db, sql`update trips set status = ${status}, updated_at = now() where id = ${tripId} returning id, status`)
}

export type TripExpense = Pick<Row<'trip_expenses'>,
  'id' | 'expense_type' | 'amount' | 'currency' | 'description' | 'expense_date' | 'created_at'>

export async function expenses(db: Queryable, tripId: string): Promise<TripExpense[]> {
  return many<TripExpense>(db, sql`
    select id, expense_type, amount, currency, description, expense_date, created_at
    from trip_expenses where trip_id = ${tripId}
    order by created_at, id`)
}
