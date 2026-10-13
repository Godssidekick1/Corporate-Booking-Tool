import { sql, empty, many, one, maybeOne, exec, json, type Queryable } from '@/app/lib/db/sql'
import { page } from '@/app/lib/db/fragments'
import type { Row } from '@/app/lib/db/types.generated'

// ── Bookings and price quotes ────────────────────────────────────────────────
// Owns: bookings, price_quotes.
//
// Read together on every ticketing request, which is why they share a module:
// a quote is the server-side record of what a booking was priced at, and the
// booking cannot be finalised without it.
// ─────────────────────────────────────────────────────────────────────────────

export async function countForClients(db: Queryable, clientIds: readonly string[]): Promise<number> {
  if (clientIds.length === 0) return 0
  const row = await one<{ n: number }>(db, sql`
    select count(*)::int as n from bookings where client_id = any(${[...clientIds]})`)
  return row.n
}

// Bookings per traveller at a client, for the people on one roster page.
export async function tripCounts(
  db: Queryable,
  clientId: string,
  employeeIds: readonly string[]
): Promise<Map<string, number>> {
  if (employeeIds.length === 0) return new Map()
  const rows = await many<{ employee_id: string; n: number }>(db, sql`
    select employee_id, count(*)::int as n from bookings
    where client_id = ${clientId} and employee_id = any(${[...employeeIds]})
    group by employee_id`)
  return new Map(rows.map(r => [r.employee_id, r.n]))
}

// ═══ The traveller's own bookings ═══════════════════════════════════════════
// THE MARKUP RULE: a traveller is shown what the company is charged
// (sell_total), never what the airline charged (total_cost). These reads
// return `total_cost` already set to the sell figure -- coalesce(sell_total,
// total_cost), the fallback covering bookings made before commercials existed,
// on which the two are the same number. The airline figure is never selected,
// so no route can send it by mistake.
//
// itinerary and fare_breakdown still carry fields a traveller may not see;
// routes project them through app/lib/book/travellerView.

const SELL_TOTAL = sql`coalesce(sell_total, total_cost)`

// Who made it, when that was someone other than the traveller: the travel desk
// or a colleague (20261013000000_book_on_behalf). Null when they booked it
// themselves. Unqualified, so it reads the outer booking row however the
// query names it (employees has neither column).
const BOOKED_BY_NAME = sql`(select k.full_name from employees k where k.id = booked_by and booked_by <> employee_id) as booked_by_name`
export type BookedByName = { booked_by_name: string | null }

export type TravellerBookingSummary = Pick<Row<'bookings'>,
  'id' | 'status' | 'pnr' | 'total_cost' | 'itinerary' | 'traveler_snapshot' | 'fare_breakdown' | 'trip_id' | 'created_at'>
  & BookedByName

const TRAVELLER_SUMMARY = sql`
  id, status, pnr, ${SELL_TOTAL} as total_cost, itinerary, traveler_snapshot, fare_breakdown,
  trip_id, created_at, ${BOOKED_BY_NAME}`

// The traveller's bookings in these trips (one page of their trips).
export async function forTravellerInTrips(
  db: Queryable, employeeId: string, tripIds: readonly string[]
): Promise<TravellerBookingSummary[]> {
  if (tripIds.length === 0) return []
  return many<TravellerBookingSummary>(db, sql`
    select ${TRAVELLER_SUMMARY} from bookings
    where employee_id = ${employeeId} and trip_id = any(${[...tripIds]})
    order by created_at desc, id`)
}

// Their bookings that sit under no trip of their own -- none at all, or a
// trip someone else created or deleted -- newest first.
export async function forTravellerOutsideTrips(
  db: Queryable, employeeId: string, limit: number
): Promise<TravellerBookingSummary[]> {
  return many<TravellerBookingSummary>(db, sql`
    select ${TRAVELLER_SUMMARY} from bookings b
    where b.employee_id = ${employeeId}
      and not exists (select 1 from trips t
                       where t.id = b.trip_id and t.created_by = ${employeeId} and t.status <> 'deleted')
    order by b.created_at desc, b.id
    limit ${limit}`)
}

export type RecentBooking = Pick<Row<'bookings'>,
  'id' | 'employee_id' | 'status' | 'pnr' | 'total_cost' | 'itinerary' | 'fare_breakdown' | 'created_at'> & BookedByName

export async function recentFor(db: Queryable, employeeIds: readonly string[], limit: number): Promise<RecentBooking[]> {
  if (employeeIds.length === 0) return []
  return many<RecentBooking>(db, sql`
    select id, employee_id, status, pnr, ${SELL_TOTAL} as total_cost, itinerary, fare_breakdown, created_at,
           ${BOOKED_BY_NAME}
    from bookings where employee_id = any(${[...employeeIds]})
    order by created_at desc, id
    limit ${limit}`)
}

// ═══ Booking history, for whoever books for others ══════════════════════════
// One person's bookings, the ones a booker made for others, or everything a
// travel desk booked within its reach. Sell-side only, like every traveller
// read: total_cost here is what the company is invoiced.

export type HistoryFilter =
  | { traveller: string }
  | { bookedBy: string }
  | { tmcId: string; clientIds: readonly string[] | null; clientId?: string | null }

export interface HistoryRow {
  id: string
  status: string
  pnr: string | null
  total_cost: number
  itinerary: unknown
  created_at: string
  employee_id: string
  traveller_name: string | null
  booked_by: string
  booker_name: string | null
  client_name: string | null
  policy_verdict: string | null
  policy_reason_code: string | null
}

export async function history(
  db: Queryable, filter: HistoryFilter, range: { from: number; to: number }
): Promise<{ rows: HistoryRow[]; total: number }> {
  const where = 'traveller' in filter
    ? sql`b.employee_id = ${filter.traveller}`
    : 'bookedBy' in filter
      ? sql`b.booked_by = ${filter.bookedBy} and b.employee_id <> b.booked_by`
      : sql`b.tmc_id = ${filter.tmcId} and b.employee_id <> b.booked_by
            ${filter.clientIds ? sql`and b.client_id = any(${[...filter.clientIds]})` : empty}
            ${filter.clientId ? sql`and b.client_id = ${filter.clientId}` : empty}`
  const [rows, count] = await Promise.all([
    many<HistoryRow>(db, sql`
      select b.id, b.status, b.pnr, coalesce(b.sell_total, b.total_cost) as total_cost, b.itinerary, b.created_at,
             b.employee_id, t.full_name as traveller_name, b.booked_by, k.full_name as booker_name,
             c.name as client_name, b.policy_verdict, b.policy_reason_code
      from bookings b
      left join employees t on t.id = b.employee_id
      left join employees k on k.id = b.booked_by
      left join clients c on c.id = b.client_id
      where ${where}
      order by b.created_at desc, b.id
      ${page(range)}`),
    one<{ n: number }>(db, sql`select count(*)::int as n from bookings b where ${where}`),
  ])
  return { rows, total: count.n }
}

export type ActionableBooking = Pick<Row<'bookings'>, 'id' | 'status' | 'total_cost' | 'itinerary' | 'updated_at'> & BookedByName

export async function actionableFor(
  db: Queryable,
  employeeId: string,
  statuses: readonly string[]
): Promise<ActionableBooking[]> {
  return many<ActionableBooking>(db, sql`
    select id, status, ${SELL_TOTAL} as total_cost, itinerary, updated_at, ${BOOKED_BY_NAME}
    from bookings where employee_id = ${employeeId} and status = any(${[...statuses]})
    order by updated_at desc, id`)
}

export type TripBooking = Pick<Row<'bookings'>,
  'id' | 'booking_type' | 'status' | 'total_cost' | 'provider_order_id' | 'pnr' | 'itinerary' | 'created_at'>

export async function forTrip(db: Queryable, tripId: string): Promise<TripBooking[]> {
  return many<TripBooking>(db, sql`
    select id, booking_type, status, ${SELL_TOTAL} as total_cost, provider_order_id, pnr, itinerary, created_at
    from bookings where trip_id = ${tripId}
    order by created_at, id`)
}

// ═══ One booking, internally ════════════════════════════════════════════════
// These DO carry the airline figure and the commercial record: the routes
// derive the sell-side breakdown from them and strip them before responding.
// Never return one of these rows to a browser as it stands.

export type BookingDetail = Pick<Row<'bookings'>,
  | 'id' | 'status' | 'booking_type' | 'provider' | 'provider_order_id' | 'pnr' | 'ticket_numbers'
  | 'sell_total' | 'total_cost' | 'commercials' | 'itinerary' | 'traveler_snapshot' | 'fare_breakdown'
  | 'policy_status' | 'policy_verdict' | 'policy_verdict_detail' | 'employee_id' | 'trip_id' | 'is_ndc'
  | 'created_at' | 'updated_at'
> & BookedByName

export async function detail(db: Queryable, bookingId: string): Promise<BookingDetail | null> {
  return maybeOne<BookingDetail>(db, sql`
    select id, status, booking_type, provider, provider_order_id, pnr, ticket_numbers, sell_total,
           total_cost, commercials, itinerary, traveler_snapshot, fare_breakdown, policy_status,
           policy_verdict, policy_verdict_detail, employee_id, trip_id, is_ndc, created_at, updated_at,
           ${BOOKED_BY_NAME}
    from bookings where id = ${bookingId}`)
}

export type PublicTicketRow = Pick<Row<'bookings'>,
  | 'id' | 'status' | 'pnr' | 'ticket_numbers' | 'provider_order_id' | 'sell_total' | 'commercials'
  | 'itinerary' | 'traveler_snapshot' | 'fare_breakdown'
>

// By the unguessable share token -- the ONLY lookup an unauthenticated caller
// can make. Callers validate the token's shape before asking.
export async function byShareToken(db: Queryable, token: string): Promise<PublicTicketRow | null> {
  return maybeOne<PublicTicketRow>(db, sql`
    select id, status, pnr, ticket_numbers, provider_order_id, sell_total, commercials, itinerary,
           traveler_snapshot, fare_breakdown
    from bookings where share_token = ${token}`)
}

export type ShareInfo = Pick<Row<'bookings'>, 'id' | 'employee_id' | 'status' | 'share_token'>

export async function shareInfo(db: Queryable, bookingId: string): Promise<ShareInfo | null> {
  return maybeOne<ShareInfo>(db, sql`
    select id, employee_id, status, share_token from bookings where id = ${bookingId}`)
}

// The provider keys a passenger-details correction is re-sent with.
export type PassengerEditTarget = Pick<Row<'bookings'>,
  'id' | 'employee_id' | 'status' | 'provider' | 'provider_order_id' | 'amadeus_key' | 'total_cost'>

export async function passengerEditTarget(db: Queryable, bookingId: string): Promise<PassengerEditTarget | null> {
  return maybeOne<PassengerEditTarget>(db, sql`
    select id, employee_id, status, provider, provider_order_id, amadeus_key, total_cost
    from bookings where id = ${bookingId}`)
}

export async function saveTravellerSnapshot(db: Queryable, bookingId: string, snapshot: unknown): Promise<void> {
  await exec(db, sql`update bookings set traveler_snapshot = ${json(snapshot)} where id = ${bookingId}`)
}

// ═══ The price quote ════════════════════════════════════════════════════════
// The server's own record of what an itinerary was priced at, for this
// client -- airline components AND the sell side. It is what takes price
// authority away from the browser, which is never told the airline figure.

// The two jsonb columns take the domain objects as they are (FareComponents,
// CommercialsRecord); they are JSON-encoded on the way in.
export type NewQuote = Pick<Row<'price_quotes'>,
  | 'client_id' | 'employee_id' | 'priced_by' | 'amadeus_key' | 'reference_no' | 'pricing_key' | 'provider'
  | 'result_index' | 'sell_total' | 'expires_at'
> & { airline_components: unknown; commercials: unknown }

// Re-pricing the same itinerary is normal; the newest quote is the one that
// counts, so the pair (amadeus_key, reference_no) is upserted. employee_id is
// the traveller (their client prices it); priced_by is whoever asked, and only
// they may book it.
export async function saveQuote(db: Queryable, q: NewQuote): Promise<void> {
  await exec(db, sql`
    insert into price_quotes (client_id, employee_id, priced_by, amadeus_key, reference_no, pricing_key, provider,
                              result_index, airline_components, commercials, sell_total, expires_at)
    values (${q.client_id}, ${q.employee_id}, ${q.priced_by}, ${q.amadeus_key}, ${q.reference_no}, ${q.pricing_key},
            ${q.provider}, ${q.result_index}, ${json(q.airline_components)}, ${json(q.commercials)},
            ${q.sell_total}, ${q.expires_at})
    on conflict (amadeus_key, reference_no) do update set
      client_id = excluded.client_id, employee_id = excluded.employee_id, priced_by = excluded.priced_by,
      pricing_key = excluded.pricing_key, provider = excluded.provider,
      result_index = excluded.result_index, airline_components = excluded.airline_components,
      commercials = excluded.commercials, sell_total = excluded.sell_total,
      expires_at = excluded.expires_at`)
}

export type HeldQuote = Pick<Row<'price_quotes'>, 'airline_components' | 'commercials' | 'sell_total' | 'employee_id' | 'priced_by'>

export async function heldQuote(db: Queryable, amadeusKey: string, referenceNo: string): Promise<HeldQuote | null> {
  return maybeOne<HeldQuote>(db, sql`
    select airline_components, commercials, sell_total, employee_id, priced_by from price_quotes
    where amadeus_key = ${amadeusKey} and reference_no = ${referenceNo}`)
}

// ═══ The booking row ════════════════════════════════════════════════════════

// jsonb columns take domain objects as they are; JSON-encoded on the way in.
export type NewBooking = Pick<Row<'bookings'>,
  | 'client_id' | 'employee_id' | 'booked_by' | 'booking_type' | 'status' | 'total_cost' | 'sell_total'
  | 'provider' | 'provider_order_id' | 'amadeus_key' | 'pricing_key' | 'result_index' | 'search_key'
  | 'trip_id' | 'is_ndc' | 'policy_status' | 'policy_verdict' | 'policy_reason_code' | 'policy_reason_note'
> & {
  resolved_deal_codes: unknown
  resolved_fop: unknown
  commercials: unknown
  itinerary: unknown
  traveler_snapshot: unknown
  fare_breakdown: unknown
  policy_verdict_detail: unknown
}

// Written once, right after the airline accepts the passengers (add-passenger).
export async function insert(db: Queryable, b: NewBooking): Promise<{ id: string }> {
  return one<{ id: string }>(db, sql`
    insert into bookings (
      client_id, employee_id, booked_by, booking_type, status, total_cost, sell_total, provider,
      provider_order_id, amadeus_key, pricing_key, result_index, search_key, trip_id, is_ndc,
      policy_status, policy_verdict, policy_reason_code, policy_reason_note, resolved_deal_codes, resolved_fop, commercials, itinerary,
      traveler_snapshot, fare_breakdown, policy_verdict_detail)
    values (
      ${b.client_id}, ${b.employee_id}, ${b.booked_by}, ${b.booking_type}, ${b.status}, ${b.total_cost},
      ${b.sell_total}, ${b.provider}, ${b.provider_order_id}, ${b.amadeus_key}, ${b.pricing_key},
      ${b.result_index}, ${b.search_key}, ${b.trip_id}, ${b.is_ndc}, ${b.policy_status}, ${b.policy_verdict},
      ${b.policy_reason_code}, ${b.policy_reason_note},
      ${json(b.resolved_deal_codes)}, ${json(b.resolved_fop)}, ${json(b.commercials)}, ${json(b.itinerary)},
      ${json(b.traveler_snapshot)}, ${json(b.fare_breakdown)}, ${json(b.policy_verdict_detail)})
    returning id`)
}

// ═══ Approval ═══════════════════════════════════════════════════════════════

export type ApprovalTarget = Pick<Row<'bookings'>, 'id' | 'employee_id' | 'client_id' | 'status'>

export async function approvalTarget(db: Queryable, bookingId: string): Promise<ApprovalTarget | null> {
  return maybeOne<ApprovalTarget>(db, sql`
    select id, employee_id, client_id, status from bookings where id = ${bookingId}`)
}

// What an approver's queue shows of each booking: the SELL side, under the
// name total_cost. The airline figure is not fetched at all.
export type ApprovalSummary = Pick<Row<'bookings'>,
  'id' | 'employee_id' | 'booking_type' | 'total_cost' | 'itinerary' | 'policy_verdict' | 'status'> & BookedByName

export async function approvalSummaries(db: Queryable, bookingIds: readonly string[]): Promise<ApprovalSummary[]> {
  if (bookingIds.length === 0) return []
  return many<ApprovalSummary>(db, sql`
    select id, employee_id, booking_type, ${SELL_TOTAL} as total_cost, itinerary, policy_verdict, status,
           ${BOOKED_BY_NAME}
    from bookings where id = any(${[...bookingIds]}) order by id`)
}

export type RefreshTarget = Pick<Row<'bookings'>,
  | 'id' | 'employee_id' | 'client_id' | 'status' | 'provider' | 'search_key' | 'pricing_key'
  | 'result_index' | 'itinerary' | 'fare_breakdown'
>

export async function refreshTarget(db: Queryable, bookingId: string): Promise<RefreshTarget | null> {
  return maybeOne<RefreshTarget>(db, sql`
    select id, employee_id, client_id, status, provider, search_key, pricing_key, result_index, itinerary, fare_breakdown
    from bookings where id = ${bookingId}`)
}

export interface RefreshedFare {
  total_cost: number
  sell_total: number
  amadeus_key: string | null
  policy_verdict: string | null
  commercials: unknown
  policy_verdict_detail: unknown
  fare_breakdown: unknown
}

export type RefreshedBooking = Pick<Row<'bookings'>, 'policy_verdict' | 'policy_verdict_detail' | 'fare_breakdown'>

// An approver's re-price becomes the booking's official price and key.
export async function applyRefreshedFare(db: Queryable, bookingId: string, f: RefreshedFare): Promise<RefreshedBooking> {
  return one<RefreshedBooking>(db, sql`
    update bookings set total_cost = ${f.total_cost}, sell_total = ${f.sell_total},
      commercials = ${json(f.commercials)}, amadeus_key = ${f.amadeus_key}, policy_verdict = ${f.policy_verdict},
      policy_verdict_detail = ${json(f.policy_verdict_detail)}, fare_breakdown = ${json(f.fare_breakdown)},
      updated_at = now()
    where id = ${bookingId}
    returning policy_verdict, policy_verdict_detail, fare_breakdown`)
}

// Approval outcomes: approved, rejected, approval_misconfigured, pending_approval.
export async function setStatus(db: Queryable, bookingId: string, status: string): Promise<void> {
  await exec(db, sql`update bookings set status = ${status}, updated_at = now() where id = ${bookingId}`)
}

// ═══ Confirming with the airline ════════════════════════════════════════════
// Every write below follows a GDS call, and none runs in a transaction on
// purpose: holding one open across a provider round trip would take a row
// lock hostage to a third party's latency. Each is one row, one statement.

export type HoldTarget = Pick<Row<'bookings'>,
  | 'id' | 'employee_id' | 'booked_by' | 'client_id' | 'status' | 'provider' | 'provider_order_id' | 'amadeus_key'
  | 'pricing_key' | 'search_key' | 'result_index' | 'total_cost' | 'traveler_snapshot'
>

export async function holdTarget(db: Queryable, bookingId: string): Promise<HoldTarget | null> {
  return maybeOne<HoldTarget>(db, sql`
    select id, employee_id, booked_by, client_id, status, provider, provider_order_id, amadeus_key, pricing_key,
           search_key, result_index, total_cost, traveler_snapshot
    from bookings where id = ${bookingId}`)
}

// confirmedBy: who pressed Book -- the traveller, or whoever booked for them.
export async function markHeld(db: Queryable, bookingId: string, pnr: string | null, confirmedBy: string): Promise<void> {
  await exec(db, sql`
    update bookings set status = 'held', pnr = ${pnr}, confirmed_by = ${confirmedBy}, updated_at = now()
    where id = ${bookingId}`)
}

export async function markFailed(db: Queryable, bookingId: string): Promise<void> {
  await exec(db, sql`update bookings set status = 'failed', updated_at = now() where id = ${bookingId}`)
}

// A re-priced session's key and reference, replacing expired ones.
export async function refreshProviderSession(
  db: Queryable,
  bookingId: string,
  amadeusKey: string,
  referenceNo: string
): Promise<void> {
  await exec(db, sql`
    update bookings set amadeus_key = ${amadeusKey}, provider_order_id = ${referenceNo}, updated_at = now()
    where id = ${bookingId}`)
}

export type TicketTarget = Pick<Row<'bookings'>,
  | 'id' | 'employee_id' | 'booked_by' | 'status' | 'provider' | 'provider_order_id' | 'amadeus_key' | 'pricing_key'
  | 'pnr' | 'itinerary' | 'share_token'
>

export async function ticketTarget(db: Queryable, bookingId: string): Promise<TicketTarget | null> {
  return maybeOne<TicketTarget>(db, sql`
    select id, employee_id, booked_by, status, provider, provider_order_id, amadeus_key, pricing_key, pnr,
           itinerary, share_token
    from bookings where id = ${bookingId}`)
}

export async function markTicketed(
  db: Queryable,
  bookingId: string,
  t: { pnr: string | null; ticketNumbers: (string | null)[]; shareToken: string }
): Promise<void> {
  await exec(db, sql`
    update bookings set status = 'ticketed', pnr = ${t.pnr}, ticket_numbers = ${t.ticketNumbers},
      share_token = ${t.shareToken}, updated_at = now()
    where id = ${bookingId}`)
}
