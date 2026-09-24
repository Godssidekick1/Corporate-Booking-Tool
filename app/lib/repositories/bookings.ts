import { sql, many, one, maybeOne, exec, json, type Queryable } from '@/app/lib/db/sql'
import type { Row } from '@/app/lib/db/types.generated'

// ── Bookings and price quotes ────────────────────────────────────────────────
// Owns: bookings, price_quotes.
//
// Read together on every ticketing request, which is why they share a module:
// a quote is the server-side record of what a booking was priced at, and the
// booking cannot be finalised without it.
// ─────────────────────────────────────────────────────────────────────────────

export type BookingStatRow = Pick<Row<'bookings'>, 'id' | 'client_id' | 'total_cost' | 'status' | 'created_at'>

// Everything the TMC dashboard aggregates, for a set of clients. The route
// aggregates in TypeScript (weekly buckets, last-30-days) so the date maths
// stays in one place.
export async function statRows(db: Queryable, clientIds: readonly string[]): Promise<BookingStatRow[]> {
  if (clientIds.length === 0) return []
  return many<BookingStatRow>(db, sql`
    select id, client_id, total_cost, status, created_at from bookings
    where client_id = any(${[...clientIds]})
    order by created_at, id`)
}

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

export type TravellerBookingSummary = Pick<Row<'bookings'>,
  'id' | 'status' | 'pnr' | 'total_cost' | 'itinerary' | 'traveler_snapshot' | 'fare_breakdown' | 'trip_id' | 'created_at'>

export async function forTraveller(db: Queryable, employeeId: string, limit: number): Promise<TravellerBookingSummary[]> {
  return many<TravellerBookingSummary>(db, sql`
    select id, status, pnr, ${SELL_TOTAL} as total_cost, itinerary, traveler_snapshot, fare_breakdown,
           trip_id, created_at
    from bookings where employee_id = ${employeeId}
    order by created_at desc, id
    limit ${limit}`)
}

export type RecentBooking = Pick<Row<'bookings'>,
  'id' | 'employee_id' | 'status' | 'pnr' | 'total_cost' | 'itinerary' | 'fare_breakdown' | 'created_at'>

export async function recentFor(db: Queryable, employeeIds: readonly string[], limit: number): Promise<RecentBooking[]> {
  if (employeeIds.length === 0) return []
  return many<RecentBooking>(db, sql`
    select id, employee_id, status, pnr, ${SELL_TOTAL} as total_cost, itinerary, fare_breakdown, created_at
    from bookings where employee_id = any(${[...employeeIds]})
    order by created_at desc, id
    limit ${limit}`)
}

export type ActionableBooking = Pick<Row<'bookings'>, 'id' | 'status' | 'total_cost' | 'itinerary' | 'updated_at'>

export async function actionableFor(
  db: Queryable,
  employeeId: string,
  statuses: readonly string[]
): Promise<ActionableBooking[]> {
  return many<ActionableBooking>(db, sql`
    select id, status, ${SELL_TOTAL} as total_cost, itinerary, updated_at
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
>

export async function detail(db: Queryable, bookingId: string): Promise<BookingDetail | null> {
  return maybeOne<BookingDetail>(db, sql`
    select id, status, booking_type, provider, provider_order_id, pnr, ticket_numbers, sell_total,
           total_cost, commercials, itinerary, traveler_snapshot, fare_breakdown, policy_status,
           policy_verdict, policy_verdict_detail, employee_id, trip_id, is_ndc, created_at, updated_at
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
  | 'client_id' | 'employee_id' | 'amadeus_key' | 'reference_no' | 'pricing_key' | 'provider'
  | 'result_index' | 'sell_total' | 'expires_at'
> & { airline_components: unknown; commercials: unknown }

// Re-pricing the same itinerary is normal; the newest quote is the one that
// counts, so the pair (amadeus_key, reference_no) is upserted.
export async function saveQuote(db: Queryable, q: NewQuote): Promise<void> {
  await exec(db, sql`
    insert into price_quotes (client_id, employee_id, amadeus_key, reference_no, pricing_key, provider,
                              result_index, airline_components, commercials, sell_total, expires_at)
    values (${q.client_id}, ${q.employee_id}, ${q.amadeus_key}, ${q.reference_no}, ${q.pricing_key},
            ${q.provider}, ${q.result_index}, ${json(q.airline_components)}, ${json(q.commercials)},
            ${q.sell_total}, ${q.expires_at})
    on conflict (amadeus_key, reference_no) do update set
      client_id = excluded.client_id, employee_id = excluded.employee_id,
      pricing_key = excluded.pricing_key, provider = excluded.provider,
      result_index = excluded.result_index, airline_components = excluded.airline_components,
      commercials = excluded.commercials, sell_total = excluded.sell_total,
      expires_at = excluded.expires_at`)
}

// ═══ Confirming with the airline ════════════════════════════════════════════
// Every write below follows a GDS call, and none runs in a transaction on
// purpose: holding one open across a provider round trip would take a row
// lock hostage to a third party's latency. Each is one row, one statement.

export type HoldTarget = Pick<Row<'bookings'>,
  | 'id' | 'employee_id' | 'client_id' | 'status' | 'provider' | 'provider_order_id' | 'amadeus_key'
  | 'pricing_key' | 'search_key' | 'result_index' | 'total_cost' | 'traveler_snapshot'
>

export async function holdTarget(db: Queryable, bookingId: string): Promise<HoldTarget | null> {
  return maybeOne<HoldTarget>(db, sql`
    select id, employee_id, client_id, status, provider, provider_order_id, amadeus_key, pricing_key,
           search_key, result_index, total_cost, traveler_snapshot
    from bookings where id = ${bookingId}`)
}

export async function markHeld(db: Queryable, bookingId: string, pnr: string | null): Promise<void> {
  await exec(db, sql`
    update bookings set status = 'held', pnr = ${pnr}, updated_at = now() where id = ${bookingId}`)
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
  | 'id' | 'employee_id' | 'status' | 'provider' | 'provider_order_id' | 'amadeus_key' | 'pricing_key'
  | 'pnr' | 'itinerary' | 'share_token'
>

export async function ticketTarget(db: Queryable, bookingId: string): Promise<TicketTarget | null> {
  return maybeOne<TicketTarget>(db, sql`
    select id, employee_id, status, provider, provider_order_id, amadeus_key, pricing_key, pnr,
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
