import { sql, empty, many, one, maybeOne, exec, json, type Queryable } from '@/app/lib/db/sql'
import { page } from '@/app/lib/db/fragments'
import type { Row } from '@/app/lib/db/types.generated'
import type { FareConditions } from '@/app/lib/book/types'
import type { FareRules } from '@/app/lib/book/fareRules'
import type { ShownFlight } from '@/app/lib/policy/lowestLogicalFare'

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
// The same, for people of any client (the cross-client traveller list).
export async function tripCountsFor(db: Queryable, employeeIds: readonly string[]): Promise<Map<string, number>> {
  if (employeeIds.length === 0) return new Map()
  const rows = await many<{ employee_id: string; n: number }>(db, sql`
    select employee_id, count(*)::int as n from bookings
    where employee_id = any(${[...employeeIds]})
    group by employee_id`)
  return new Map(rows.map(r => [r.employee_id, r.n]))
}

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
  'id' | 'status' | 'pnr' | 'total_cost' | 'itinerary' | 'traveler_snapshot' | 'fare_breakdown' | 'trip_id' | 'created_at'
  | 'purpose' | 'for_guest'>
  & BookedByName

const TRAVELLER_SUMMARY = sql`
  id, status, pnr, ${SELL_TOTAL} as total_cost, itinerary, traveler_snapshot, fare_breakdown,
  trip_id, created_at, purpose, for_guest, ${BOOKED_BY_NAME}`

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

// ── What someone booked or set up for OTHER people ──────────────────────────
// The "Arranged for others" side of My trips. Same sell-side summary, plus
// whose booking it is.

export type ArrangedBookingSummary = TravellerBookingSummary & { traveller_name: string | null; booked_by_me: boolean }

const arrangedSummary = (bookerId: string) => sql`${TRAVELLER_SUMMARY},
  (select t.full_name from employees t where t.id = employee_id) as traveller_name,
  (booked_by = ${bookerId}) as booked_by_me`

// The bookings in these trips (one page of trips.arrangedFor): every booking
// in a trip the caller set up -- they look after it -- but only their own
// bookings in a colleague's own trip, which is otherwise the colleague's.
export async function inArrangedTrips(
  db: Queryable, bookerId: string, trips: readonly { id: string; arranged_by_me: boolean }[]
): Promise<ArrangedBookingSummary[]> {
  if (trips.length === 0) return []
  const setUp = trips.filter(t => t.arranged_by_me).map(t => t.id)
  const bookedInto = trips.filter(t => !t.arranged_by_me).map(t => t.id)
  return many<ArrangedBookingSummary>(db, sql`
    select ${arrangedSummary(bookerId)} from bookings
    where trip_id = any(${setUp})
       or (trip_id = any(${bookedInto}) and booked_by = ${bookerId})
    order by created_at desc, id`)
}

// What they booked for someone else under no trip, newest first.
export async function bookedForOthersOutsideTrips(
  db: Queryable, bookerId: string, limit: number
): Promise<ArrangedBookingSummary[]> {
  return many<ArrangedBookingSummary>(db, sql`
    select ${arrangedSummary(bookerId)} from bookings b
    where b.booked_by = ${bookerId} and b.employee_id <> ${bookerId}
      and not exists (select 1 from trips t where t.id = b.trip_id and t.status <> 'deleted')
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

// Several trips' bookings at once: the approver's queue, one page of trip
// sign-offs. Sell-side, like forTrip.
export async function forTrips(db: Queryable, tripIds: readonly string[]): Promise<(TripBooking & { trip_id: string })[]> {
  if (tripIds.length === 0) return []
  return many(db, sql`
    select id, trip_id, booking_type, status, ${SELL_TOTAL} as total_cost, provider_order_id, pnr, itinerary, created_at
    from bookings where trip_id = any(${[...tripIds]})
    order by created_at, id`)
}

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
  | 'created_at' | 'updated_at' | 'cancelled_at' | 'cancellation_reason' | 'cancellation' | 'fare_rules'
> & BookedByName & TicketFooter & { cancelled_by_name: string | null }

// The company's own words at the foot of its e-tickets (Corporate Settings).
type TicketFooter = { ticket_footer_text: string | null }
const TICKET_FOOTER = sql`(select c.ticket_footer_text from clients c where c.id = client_id) as ticket_footer_text`

export async function detail(db: Queryable, bookingId: string): Promise<BookingDetail | null> {
  return maybeOne<BookingDetail>(db, sql`
    select id, status, booking_type, provider, provider_order_id, pnr, ticket_numbers, sell_total,
           total_cost, commercials, itinerary, traveler_snapshot, fare_breakdown, policy_status,
           policy_verdict, policy_verdict_detail, employee_id, trip_id, is_ndc, created_at, updated_at,
           cancelled_at, cancellation_reason, cancellation, fare_rules,
           (select k.full_name from employees k where k.id = cancelled_by) as cancelled_by_name,
           ${BOOKED_BY_NAME}, ${TICKET_FOOTER}
    from bookings where id = ${bookingId}`)
}

// ═══ One booking, for the TMC desk ══════════════════════════════════════════
// Everything the desk's booking page shows (/tmc/reports/bookings/[id]): the
// commercials and the airline's figures included, so only TMC routes read it,
// after checking the booking is in the caller's TMC and portfolio.

export type DeskBookingDetail = Pick<Row<'bookings'>,
  | 'id' | 'client_id' | 'tmc_id' | 'employee_id' | 'booked_by' | 'status' | 'created_at' | 'updated_at'
  | 'provider' | 'provider_order_id' | 'pnr' | 'airline_pnr' | 'ticket_numbers' | 'total_cost' | 'sell_total'
  | 'commercials' | 'itinerary' | 'traveler_snapshot' | 'fare_breakdown' | 'policy_status' | 'policy_verdict'
  | 'policy_verdict_detail' | 'policy_reason_code' | 'policy_reason_note' | 'resolved_deal_codes' | 'resolved_fop'
  | 'purpose' | 'for_guest' | 'trip_id' | 'cancelled_at' | 'cancellation_reason' | 'cancellation' | 'pair_id'
  | 'fare_rules'
> & {
  traveller_name: string | null
  traveller_email: string | null
  traveller_band: string | null
  client_name: string | null
  booked_by_name: string | null
  booked_by_role: string | null
  confirmed_by_name: string | null
  cancelled_by_name: string | null
  trip_name: string | null
}

export async function deskDetail(db: Queryable, bookingId: string): Promise<DeskBookingDetail | null> {
  return maybeOne<DeskBookingDetail>(db, sql`
    select b.id, b.client_id, b.tmc_id, b.employee_id, b.booked_by, b.status, b.created_at, b.updated_at,
           b.provider, b.provider_order_id, b.pnr, b.airline_pnr, b.ticket_numbers, b.total_cost, b.sell_total,
           b.commercials, b.itinerary, b.traveler_snapshot, b.fare_breakdown, b.policy_status, b.policy_verdict,
           b.policy_verdict_detail, b.policy_reason_code, b.policy_reason_note, b.resolved_deal_codes, b.resolved_fop,
           b.purpose, b.for_guest, b.trip_id, b.cancelled_at, b.cancellation_reason, b.cancellation, b.pair_id,
           b.fare_rules,
           e.full_name as traveller_name, e.email as traveller_email, e.band_code as traveller_band,
           c.name as client_name,
           bb.full_name as booked_by_name, bb.role as booked_by_role,
           cf.full_name as confirmed_by_name, cx.full_name as cancelled_by_name,
           t.name as trip_name
    from bookings b
    left join employees e on e.id = b.employee_id
    left join clients c on c.id = b.client_id
    left join employees bb on bb.id = b.booked_by
    left join employees cf on cf.id = b.confirmed_by
    left join employees cx on cx.id = b.cancelled_by
    left join trips t on t.id = b.trip_id
    where b.id = ${bookingId}`)
}

export type PublicTicketRow = Pick<Row<'bookings'>,
  | 'id' | 'status' | 'pnr' | 'ticket_numbers' | 'provider_order_id' | 'sell_total' | 'commercials'
  | 'itinerary' | 'traveler_snapshot' | 'fare_breakdown'
> & TicketFooter

// By the unguessable share token -- the ONLY lookup an unauthenticated caller
// can make. Callers validate the token's shape before asking.
export async function byShareToken(db: Queryable, token: string): Promise<PublicTicketRow | null> {
  return maybeOne<PublicTicketRow>(db, sql`
    select id, status, pnr, ticket_numbers, provider_order_id, sell_total, commercials, itinerary,
           traveler_snapshot, fare_breakdown, ${TICKET_FOOTER}
    from bookings where share_token = ${token}`)
}

// A ticketed booking's share token, made now if it has none: ticketed some
// other way than our ticket route (an import, the demo seed), it never got one,
// and without it there is no QR. The same form the ticket route mints (32 hex
// characters, what the public ticket route accepts); set only if still empty,
// so two requests at once agree on one token.
export async function ensureShareToken(db: Queryable, bookingId: string, fresh: string): Promise<string | null> {
  return (await maybeOne<{ share_token: string | null }>(db, sql`
    update bookings set share_token = coalesce(share_token, ${fresh})
    where id = ${bookingId} and status = 'ticketed'
    returning share_token`))?.share_token ?? null
}

export type ShareInfo = Pick<Row<'bookings'>, 'id' | 'employee_id' | 'status' | 'share_token'>

export async function shareInfo(db: Queryable, bookingId: string): Promise<ShareInfo | null> {
  return maybeOne<ShareInfo>(db, sql`
    select id, employee_id, status, share_token from bookings where id = ${bookingId}`)
}

// The provider keys a passenger-details correction is re-sent with.
// itinerary: for the passenger checks' travel date (ages on the day of travel).
export type PassengerEditTarget = Pick<Row<'bookings'>,
  'id' | 'employee_id' | 'status' | 'provider' | 'provider_order_id' | 'amadeus_key' | 'total_cost' | 'itinerary'>

export async function passengerEditTarget(db: Queryable, bookingId: string): Promise<PassengerEditTarget | null> {
  return maybeOne<PassengerEditTarget>(db, sql`
    select id, employee_id, status, provider, provider_order_id, amadeus_key, total_cost, itinerary
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
> & {
  airline_components: unknown; commercials: unknown; fare_conditions: FareConditions | null; fare_rules: FareRules | null
  // The search it was priced from: the airline's fare-rule call needs it.
  search_key: string | null
}

// Re-pricing the same itinerary is normal; the newest quote is the one that
// counts, so the pair (amadeus_key, reference_no) is upserted. employee_id is
// the traveller (their client prices it); priced_by is whoever asked, and only
// they may book it.
//
// Fare rules arrive separately (/api/book/fare-rules), so pricing the same
// itinerary again keeps the rules already fetched rather than wiping them.
export async function saveQuote(db: Queryable, q: NewQuote): Promise<void> {
  await exec(db, sql`
    insert into price_quotes (client_id, employee_id, priced_by, amadeus_key, reference_no, pricing_key, provider,
                              result_index, airline_components, commercials, sell_total, expires_at, fare_conditions, fare_rules,
                              search_key)
    values (${q.client_id}, ${q.employee_id}, ${q.priced_by}, ${q.amadeus_key}, ${q.reference_no}, ${q.pricing_key},
            ${q.provider}, ${q.result_index}, ${json(q.airline_components)}, ${json(q.commercials)},
            ${q.sell_total}, ${q.expires_at}, ${q.fare_conditions ? json(q.fare_conditions) : null},
            ${q.fare_rules ? json(q.fare_rules) : null}, ${q.search_key})
    on conflict (amadeus_key, reference_no) do update set
      client_id = excluded.client_id, employee_id = excluded.employee_id, priced_by = excluded.priced_by,
      pricing_key = excluded.pricing_key, provider = excluded.provider,
      result_index = excluded.result_index, airline_components = excluded.airline_components,
      commercials = excluded.commercials, sell_total = excluded.sell_total,
      expires_at = excluded.expires_at, fare_conditions = excluded.fare_conditions,
      fare_rules = coalesce(excluded.fare_rules, price_quotes.fare_rules),
      search_key = coalesce(excluded.search_key, price_quotes.search_key)`)
}

// What the fare-rules request needs of a quote: whose it is, the keys the
// airline asks for, and the rules if they are already here.
export type QuoteForRules = Pick<Row<'price_quotes'>,
  'id' | 'priced_by' | 'pricing_key' | 'provider' | 'result_index' | 'search_key' | 'expires_at'
> & { fare_rules: FareRules | null }

export async function quoteForRules(db: Queryable, amadeusKey: string, referenceNo: string): Promise<QuoteForRules | null> {
  return maybeOne<QuoteForRules>(db, sql`
    select id, priced_by, pricing_key, provider, result_index, search_key, expires_at, fare_rules from price_quotes
    where amadeus_key = ${amadeusKey} and reference_no = ${referenceNo}`)
}

// Rules that arrived after the price: kept on the quote (add-passenger copies
// them onto the booking). Never overwrites rules already there.
export async function setQuoteFareRules(db: Queryable, quoteId: string, rules: FareRules): Promise<void> {
  await exec(db, sql`update price_quotes set fare_rules = ${json(rules)} where id = ${quoteId} and fare_rules is null`)
}

export type HeldQuote = Pick<Row<'price_quotes'>,
  'id' | 'airline_components' | 'commercials' | 'sell_total' | 'employee_id' | 'priced_by' | 'expires_at'
  | 'pricing_key' | 'provider' | 'result_index' | 'search_key'
> & { fare_conditions: FareConditions | null; fare_rules: FareRules | null }

export async function heldQuote(db: Queryable, amadeusKey: string, referenceNo: string): Promise<HeldQuote | null> {
  return maybeOne<HeldQuote>(db, sql`
    select id, airline_components, commercials, sell_total, employee_id, priced_by, expires_at, fare_conditions, fare_rules,
           pricing_key, provider, result_index, search_key
    from price_quotes
    where amadeus_key = ${amadeusKey} and reference_no = ${referenceNo}`)
}

// ═══ What a search showed (search_fares) ═════════════════════════════════════
// Kept briefly for the lowest-logical-fare check: anything older than two
// hours goes on the next insert.

export async function saveSearchFares(
  db: Queryable,
  s: { search_key: string; client_id: string; traveller_id: string; flights: ShownFlight[] },
): Promise<void> {
  await exec(db, sql`delete from search_fares where created_at < now() - interval '2 hours'`)
  await exec(db, sql`
    insert into search_fares (search_key, client_id, traveller_id, flights)
    values (${s.search_key}, ${s.client_id}, ${s.traveller_id}, ${json(s.flights)})`)
}

export async function searchFares(db: Queryable, searchKey: string, travellerId: string): Promise<ShownFlight[] | null> {
  const row = await maybeOne<{ flights: ShownFlight[] }>(db, sql`
    select flights from search_fares where search_key = ${searchKey} and traveller_id = ${travellerId}
    order by created_at desc limit 1`)
  return row?.flights ?? null
}

export interface SameTripBooking {
  id: string
  pnr: string | null
  status: string
  departure: string | null
}

// The traveller's live booking on the same route and day, if any: the
// duplicate check (clients.duplicate_booking_check). Live means not cancelled,
// failed or rejected. The route and day are the outbound's, which is what a
// traveller means by "the same flight" for a one-way or a return alike.
export async function sameTripBooking(
  db: Queryable, employeeId: string, origin: string, destination: string, day: string,
): Promise<SameTripBooking | null> {
  return maybeOne<SameTripBooking>(db, sql`
    select id, pnr, status, itinerary->'origin'->>'dateTime' as departure
    from bookings
    where employee_id = ${employeeId}
      and status not in ('cancelled', 'failed', 'rejected')
      and itinerary->'origin'->>'code' = ${origin}
      and itinerary->'destination'->>'code' = ${destination}
      and left(itinerary->'origin'->>'dateTime', 10) = ${day}
    order by created_at desc, id
    limit 1`)
}

// The traveller's live bookings on the SAME FLIGHT: any of the flight numbers
// given ("AI2654"), departing that day. Airlines refuse, at booking, a further
// booking of a person already on a flight (17 Nov 2026: a third booking of one
// passenger on AI 2654 came back "Failed" with no reason). So add-passenger
// asks before the airline sees it, whatever the company's own duplicate check,
// and a booking the airline turns down without a reason is explained by it.
// exceptId: the booking being made, when it already has a row.
export async function sameFlightBookings(
  db: Queryable, employeeId: string, flights: readonly string[], day: string, exceptId: string | null = null,
): Promise<{ id: string; pnr: string | null; status: string }[]> {
  if (flights.length === 0) return []
  return many(db, sql`
    select id, pnr, status from bookings
    where employee_id = ${employeeId}
      and status not in ('cancelled', 'failed', 'rejected')
      and (${exceptId}::uuid is null or id <> ${exceptId}::uuid)
      and left(itinerary->'origin'->>'dateTime', 10) = ${day}
      and exists (
        select 1 from jsonb_array_elements(coalesce(itinerary->'legs', '[]'::jsonb)) leg
        where upper(coalesce(leg->>'airlineCode', '') || coalesce(leg->>'flightNumber', '')) = any(${[...flights]})
      )
    order by created_at, id`)
}

// The same, for a booking already made: the traveller's OTHER live bookings on
// any of its flights that day (the booking route explains an airline refusal
// with it). Also returns the flight and day, for the message.
export async function sameFlightAsBooking(
  db: Queryable, bookingId: string,
): Promise<{ flight: string; day: string; others: { id: string; pnr: string | null }[] } | null> {
  const row = await maybeOne<{ employee_id: string; day: string | null; flights: string[] | null }>(db, sql`
    select employee_id, left(itinerary->'origin'->>'dateTime', 10) as day,
           array(select upper(coalesce(leg->>'airlineCode', '') || coalesce(leg->>'flightNumber', ''))
                 from jsonb_array_elements(coalesce(itinerary->'legs', '[]'::jsonb)) leg) as flights
    from bookings where id = ${bookingId}`)
  if (!row?.day || !row.flights?.length) return null
  const others = await sameFlightBookings(db, row.employee_id, row.flights, row.day, bookingId)
  return others.length ? { flight: row.flights[0], day: row.day, others: others.map(o => ({ id: o.id, pnr: o.pnr })) } : null
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
  purpose?: 'business' | 'personal'
  // The airline's rules, from the quote (null when it gave none).
  fare_rules?: FareRules | null
  for_guest?: boolean
  // What the fare was chosen from, for the approver (null without a search).
  choice_context?: unknown
}

// Written once, right after the airline accepts the passengers (add-passenger).
export async function insert(db: Queryable, b: NewBooking): Promise<{ id: string }> {
  return one<{ id: string }>(db, sql`
    insert into bookings (
      client_id, employee_id, booked_by, booking_type, status, total_cost, sell_total, provider,
      provider_order_id, amadeus_key, pricing_key, result_index, search_key, trip_id, is_ndc,
      policy_status, policy_verdict, policy_reason_code, policy_reason_note, resolved_deal_codes, resolved_fop, commercials, itinerary,
      traveler_snapshot, fare_breakdown, policy_verdict_detail, purpose, for_guest, fare_rules, choice_context,
      requested_total)
    values (
      ${b.client_id}, ${b.employee_id}, ${b.booked_by}, ${b.booking_type}, ${b.status}, ${b.total_cost},
      ${b.sell_total}, ${b.provider}, ${b.provider_order_id}, ${b.amadeus_key}, ${b.pricing_key},
      ${b.result_index}, ${b.search_key}, ${b.trip_id}, ${b.is_ndc}, ${b.policy_status}, ${b.policy_verdict},
      ${b.policy_reason_code}, ${b.policy_reason_note},
      ${json(b.resolved_deal_codes)}, ${json(b.resolved_fop)}, ${json(b.commercials)}, ${json(b.itinerary)},
      ${json(b.traveler_snapshot)}, ${json(b.fare_breakdown)}, ${json(b.policy_verdict_detail)},
      ${b.purpose ?? 'business'}, ${b.for_guest ?? false}, ${b.fare_rules ? json(b.fare_rules) : null},
      ${b.choice_context ? json(b.choice_context) : null},
      -- The price approval is asked at (refreshes compare against it).
      ${b.sell_total})
    returning id`)
}

// ═══ Round trip pairs ═══════════════════════════════════════════════════════
// A domestic round trip booked as two one-way fares (migration
// 20261111000000_round_trip_pairs): pair_id is the first booking's id, on both.

// The first booking of a pair, waiting for its return.
export async function markPairFirst(db: Queryable, bookingId: string): Promise<void> {
  await exec(db, sql`update bookings set pair_id = id, updated_at = now() where id = ${bookingId}`)
}

export async function linkToPair(db: Queryable, bookingId: string, pairId: string): Promise<void> {
  await exec(db, sql`update bookings set pair_id = ${pairId}, updated_at = now() where id = ${bookingId}`)
}

export interface PairOpening {
  id: string
  employee_id: string
  booked_by: string | null
  client_id: string | null
  status: string
  pair_id: string | null
  policy_verdict: string | null
  policy_verdict_detail: { breaches?: unknown[] } | null
  created_at: string
  // Seconds since it was made, by the database clock (the one created_at uses).
  age_seconds: number
  partners: number
  approval_rows: number
}

// What the return of a pair needs to know about the onward before it links:
// whose it is, whether it is still waiting (no partner yet, nothing sent for
// approval), and its verdict, for the one approval of the pair.
export async function pairOpening(db: Queryable, bookingId: string): Promise<PairOpening | null> {
  return maybeOne<PairOpening>(db, sql`
    select b.id, b.employee_id, b.booked_by, b.client_id, b.status, b.pair_id, b.policy_verdict,
           b.policy_verdict_detail, b.created_at,
           extract(epoch from now() - b.created_at)::int as age_seconds,
           (select count(*)::int from bookings p where p.pair_id = b.id and p.id <> b.id) as partners,
           (select count(*)::int from approvals a where a.booking_id = b.id) as approval_rows
    from bookings b where b.id = ${bookingId}`)
}

// A decision on the pair's approval reaches the other booking too, while it
// is still waiting on that same decision.
export async function setPairStatus(db: Queryable, bookingId: string, status: string): Promise<void> {
  await exec(db, sql`
    update bookings set status = ${status}, updated_at = now()
    where pair_id is not null
      and pair_id = (select pair_id from bookings where id = ${bookingId})
      and id <> ${bookingId}
      and status = 'pending_approval'`)
}

export interface PairMember {
  id: string
  status: string
  pnr: string | null
  itinerary: unknown
  sell_total: number | null
  created_at: string
}

// Both bookings of a pair, first (onward) first. Empty when not paired.
export async function pairMembers(db: Queryable, bookingId: string): Promise<PairMember[]> {
  return many<PairMember>(db, sql`
    select p.id, p.status, p.pnr, p.itinerary, coalesce(p.sell_total, p.total_cost) as sell_total, p.created_at
    from bookings b join bookings p on p.pair_id = b.pair_id
    where b.id = ${bookingId} and b.pair_id is not null
    order by (p.id = p.pair_id) desc, p.created_at, p.id`)
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
  'id' | 'employee_id' | 'booking_type' | 'total_cost' | 'itinerary' | 'policy_verdict' | 'status' | 'purpose' | 'for_guest' | 'choice_context' | 'requested_total'> & BookedByName

export async function approvalSummaries(db: Queryable, bookingIds: readonly string[]): Promise<ApprovalSummary[]> {
  if (bookingIds.length === 0) return []
  return many<ApprovalSummary>(db, sql`
    select id, employee_id, booking_type, ${SELL_TOTAL} as total_cost, itinerary, policy_verdict, status,
           purpose, for_guest, choice_context, requested_total, ${BOOKED_BY_NAME}
    from bookings where id = any(${[...bookingIds]}) order by id`)
}

// traveler_snapshot: the passenger counts a fresh search needs (refindFare);
// sell_total: what was sent for approval, to measure a rise against.
export type RefreshTarget = Pick<Row<'bookings'>,
  | 'id' | 'employee_id' | 'client_id' | 'status' | 'provider' | 'search_key' | 'pricing_key'
  | 'result_index' | 'itinerary' | 'fare_breakdown' | 'traveler_snapshot' | 'sell_total' | 'total_cost' | 'requested_total'
>

export async function refreshTarget(db: Queryable, bookingId: string): Promise<RefreshTarget | null> {
  return maybeOne<RefreshTarget>(db, sql`
    select id, employee_id, client_id, status, provider, search_key, pricing_key, result_index, itinerary, fare_breakdown,
           traveler_snapshot, sell_total, total_cost, requested_total
    from bookings where id = ${bookingId}`)
}

// A new approval round at a new price (a fare rise at confirmation): the
// price asked for is now this one. A refresh never calls this; the approver
// weighs a refreshed price against the one asked for.
export async function setRequestedTotal(db: Queryable, bookingId: string, total: number): Promise<void> {
  await exec(db, sql`update bookings set requested_total = ${total}, updated_at = now() where id = ${bookingId}`)
}

// The keys of a fare found again in a fresh search (app/lib/book/refindFare.ts):
// later re-pricing, and confirming, use these instead of the expired ones.
export async function applyRefoundKeys(
  db: Queryable, bookingId: string, k: { searchKey: string; pricingKey: string; resultIndex: string; provider: string },
): Promise<void> {
  await exec(db, sql`
    update bookings set search_key = ${k.searchKey}, pricing_key = ${k.pricingKey}, result_index = ${k.resultIndex},
      provider = ${k.provider}, updated_at = now()
    where id = ${bookingId}`)
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

// A Booking or Ticket call the airline did not answer: the next attempt asks
// the airline what happened before doing anything (db/migrations/20261117000100).
export async function markUnconfirmed(db: Queryable, bookingId: string, step: 'booking' | 'ticket'): Promise<void> {
  await exec(db, sql`
    update bookings set provider_unconfirmed = ${step}, provider_unconfirmed_at = now(), updated_at = now()
    where id = ${bookingId}`)
}

export async function clearUnconfirmed(db: Queryable, bookingId: string): Promise<void> {
  await exec(db, sql`
    update bookings set provider_unconfirmed = null, provider_unconfirmed_at = null
    where id = ${bookingId} and provider_unconfirmed is not null`)
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
  | 'pricing_key' | 'search_key' | 'result_index' | 'total_cost' | 'sell_total' | 'traveler_snapshot' | 'provider_unconfirmed'
>

export async function holdTarget(db: Queryable, bookingId: string): Promise<HoldTarget | null> {
  return maybeOne<HoldTarget>(db, sql`
    select id, employee_id, booked_by, client_id, status, provider, provider_order_id, amadeus_key, pricing_key,
           search_key, result_index, total_cost, sell_total, traveler_snapshot, provider_unconfirmed
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
  | 'pnr' | 'itinerary' | 'share_token' | 'provider_unconfirmed'
>

export async function ticketTarget(db: Queryable, bookingId: string): Promise<TicketTarget | null> {
  return maybeOne<TicketTarget>(db, sql`
    select id, employee_id, booked_by, status, provider, provider_order_id, amadeus_key, pricing_key, pnr,
           itinerary, share_token, provider_unconfirmed
    from bookings where id = ${bookingId}`)
}

// ── Cancellation (app/lib/book/cancellation.ts) ──────────────────────────────

export type CancelTarget = Pick<Row<'bookings'>,
  'id' | 'employee_id' | 'booked_by' | 'client_id' | 'tmc_id' | 'status' | 'provider_order_id'>

export async function cancelTarget(db: Queryable, bookingId: string): Promise<CancelTarget | null> {
  return maybeOne<CancelTarget>(db, sql`
    select id, employee_id, booked_by, client_id, tmc_id, status, provider_order_id
    from bookings where id = ${bookingId}`)
}

// Marks a cancellation as under way with the provider. False when the booking
// is no longer in one of `statuses`, or another cancellation is already under
// way (one started over two minutes ago counts as abandoned).
export async function claimCancellation(db: Queryable, bookingId: string, statuses: readonly string[]): Promise<boolean> {
  return (await exec(db, sql`
    update bookings set cancel_started_at = now()
    where id = ${bookingId} and status = any(${[...statuses]})
      and (cancel_started_at is null or cancel_started_at < now() - interval '2 minutes')`)) === 1
}

export async function releaseCancellation(db: Queryable, bookingId: string): Promise<void> {
  await exec(db, sql`update bookings set cancel_started_at = null where id = ${bookingId}`)
}

// Cancelled before the airline had it: false when the status moved on first.
export async function withdraw(
  db: Queryable,
  bookingId: string,
  c: { by: string; reason: string | null; statuses: readonly string[] }
): Promise<boolean> {
  return (await exec(db, sql`
    update bookings set status = 'cancelled', cancelled_at = now(), cancelled_by = ${c.by},
      cancellation_reason = ${c.reason}, updated_at = now()
    where id = ${bookingId} and status = any(${[...c.statuses]})`)) === 1
}

// What the provider answered, once it has accepted the cancellation.
export async function recordCancellation(
  db: Queryable,
  bookingId: string,
  c: { status: 'cancelled' | 'cancel_requested'; by: string; reason: string | null; record: unknown }
): Promise<void> {
  await exec(db, sql`
    update bookings set status = ${c.status}, cancelled_at = now(), cancelled_by = ${c.by},
      cancellation_reason = ${c.reason}, cancellation = ${json(c.record)}, cancel_started_at = null,
      updated_at = now()
    where id = ${bookingId}`)
}

export async function markTicketed(
  db: Queryable,
  bookingId: string,
  t: { pnr: string | null; ticketNumbers: (string | null)[]; shareToken: string; airlinePnr?: string | null }
): Promise<void> {
  await exec(db, sql`
    update bookings set status = 'ticketed', pnr = ${t.pnr}, ticket_numbers = ${t.ticketNumbers},
      share_token = ${t.shareToken}, airline_pnr = coalesce(${t.airlinePnr ?? null}, airline_pnr), updated_at = now()
    where id = ${bookingId}`)
}
