import { sql, one, many, empty, type Queryable, type Sql } from '@/app/lib/db/sql'
import type { ReportFilters } from '@/app/lib/reports/types'

// ── Report figures ───────────────────────────────────────────────────────────
// Counted in SQL over the bookings that already exist: nothing is fetched to
// be added up in JavaScript, because a TMC has tens of thousands of bookings.
//
// What counts, for every report:
//   a booking     booked with the airline (held or ticketed); cancelled,
//                 failed, rejected and still-pending ones are left out
//   its date      when it was booked (created_at), India's calendar day
//   its amount    what the company pays: sell_total, or total_cost on
//                 bookings made before commercials existed (the two are the
//                 same there)
//   the traveller bookings.employee_id; a guest is recorded against the
//                 booker, as everywhere else
//
// Corporate reports read the sell side only. The airline's figure, markup,
// discount, fee and margin (bookings.commercials) are read by TMC reports
// alone (revenue, airlines), and never selected for a corporate one.
//
// Bookings are always aliased b and their traveller e, so the scope and
// filter fragments below can be shared.
// ─────────────────────────────────────────────────────────────────────────────

export type Scope =
  | { side: 'client'; clientId: string }
  // clientIds null: every client of the TMC (a TMC admin); otherwise a
  // counsellor's portfolio.
  | { side: 'tmc'; tmcId: string; clientIds: string[] | null }

const BOOKED = sql`b.status in ('held', 'ticketed')`
const AMOUNT = sql`coalesce(b.sell_total, b.total_cost)`
const BREACHES = sql`jsonb_array_elements(case when jsonb_typeof(b.policy_verdict_detail->'breaches') = 'array'
  then b.policy_verdict_detail->'breaches' else '[]'::jsonb end)`
const WITHIN = sql`b.policy_status = 'evaluated' and b.policy_verdict = 'green'`
const NEEDS = sql`b.policy_status = 'evaluated' and b.policy_verdict = 'amber'`
const OUT = sql`b.policy_status = 'evaluated' and b.policy_verdict = 'red'`
const UNCHECKED = sql`b.policy_status is distinct from 'evaluated'`
const MONTH = sql`date_trunc('month', b.created_at at time zone 'Asia/Kolkata')`

// Domestic when every airport on the booking is in India. An airport we do
// not know counts as abroad, as classifyFlight does.
const DOMESTIC = sql`not exists (
  select 1 from (
    select b.itinerary->'origin'->>'code' as code
    union all select b.itinerary->'destination'->>'code'
    union all select s->>'code' from jsonb_array_elements(case when jsonb_typeof(b.itinerary->'stops') = 'array'
      then b.itinerary->'stops' else '[]'::jsonb end) s
  ) p
  where p.code is not null
    and not exists (select 1 from airports ap where ap.code = p.code and ap.country_code = 'IN'))`

function inRange(column: Sql, f: ReportFilters): Sql {
  return sql`${column} >= (${f.from}::date::timestamp at time zone 'Asia/Kolkata')
    and ${column} < ((${f.to}::date + 1)::timestamp at time zone 'Asia/Kolkata')`
}

function bookingScope(scope: Scope): Sql {
  if (scope.side === 'client') return sql`b.client_id = ${scope.clientId}`
  if (scope.clientIds === null) return sql`b.tmc_id = ${scope.tmcId}`
  return sql`b.tmc_id = ${scope.tmcId} and b.client_id = any(${scope.clientIds})`
}

function filtersOn(f: ReportFilters): Sql {
  return sql`
    ${f.department ? sql`and coalesce(nullif(e.department, ''), 'No department') = ${f.department}` : empty}
    ${f.costCentre ? sql`and e.cost_centre = ${f.costCentre}` : empty}
    ${f.band ? sql`and e.band_code = ${f.band}` : empty}
    ${f.clientId ? sql`and b.client_id = ${f.clientId}` : empty}
    ${f.clientGroupId ? sql`and b.client_id in (select id from clients where client_group_id = ${f.clientGroupId})` : empty}`
}

// Booked bookings in scope, in range, through the filters.
function booked(scope: Scope, f: ReportFilters): Sql {
  return sql`${bookingScope(scope)} and ${BOOKED} and ${inRange(sql`b.created_at`, f)} ${filtersOn(f)}`
}

const FROM = sql`bookings b join employees e on e.id = b.employee_id`

// A month of a chart: its first day, and the figures (absent when nothing
// happened that month).
export type Month<T> = { month: string } & Partial<T>

// One row per month of the range, oldest first, the month's first day as
// YYYY-MM-DD; the columns are the select list, null where nothing happened.
async function monthly<T>(db: Queryable, where: Sql, f: ReportFilters, columns: Sql): Promise<Month<T>[]> {
  return many(db, sql`
    select to_char(m, 'YYYY-MM-DD') as month, x.*
    from generate_series(date_trunc('month', ${f.from}::date::timestamp), date_trunc('month', ${f.to}::date::timestamp),
                         interval '1 month') as m
    left join (select ${MONTH} as at_month, ${columns} from ${FROM} where ${where} group by 1) x on x.at_month = m
    order by m`)
}

// ── Corporate: spend ─────────────────────────────────────────────────────────

export interface SpendGroup { name: string; bookings: number; spend: number }

export interface SpendFigures {
  totals: { bookings: number; spend: number; domestic: number }
  months: Month<{ spend: number }>[]
  departments: SpendGroup[]
  costCentres: SpendGroup[]
  bands: SpendGroup[]
}

export async function spend(db: Queryable, scope: Scope, f: ReportFilters): Promise<SpendFigures> {
  const where = booked(scope, f)
  const by = (label: Sql) => many<SpendGroup>(db, sql`
    select ${label} as name, count(*)::int as bookings, sum(${AMOUNT})::float8 as spend
    from ${FROM}
    left join cost_centres cc on cc.client_id = b.client_id and cc.code = e.cost_centre
    left join bands bd on bd.client_id = b.client_id and bd.code = e.band_code
    where ${where} group by 1 order by 3 desc, 1`)
  const [totals, months, departments, costCentres, bands] = await Promise.all([
    one<{ bookings: number; spend: number; domestic: number }>(db, sql`
      select count(*)::int as bookings, coalesce(sum(${AMOUNT}), 0)::float8 as spend,
             count(*) filter (where ${DOMESTIC})::int as domestic
      from ${FROM} where ${where}`),
    monthly<{ spend: number }>(db, where, f, sql`sum(${AMOUNT})::float8 as spend`),
    by(sql`coalesce(nullif(e.department, ''), 'No department')`),
    by(sql`coalesce(cc.name || ' (' || cc.code || ')', nullif(e.cost_centre, ''), 'No cost centre')`),
    by(sql`coalesce(bd.label || ' (' || bd.code || ')', nullif(e.band_code, ''), 'No band')`),
  ])
  return { totals, months, departments, costCentres, bands }
}

// ── Corporate and TMC: policy outcomes ───────────────────────────────────────

const OUTCOME_COUNTS = sql`
  count(*)::int as bookings,
  count(*) filter (where ${WITHIN})::int as within,
  count(*) filter (where ${NEEDS})::int as needs,
  count(*) filter (where ${OUT})::int as out,
  count(*) filter (where ${UNCHECKED})::int as unchecked,
  count(*) filter (where b.policy_reason_code is not null)::int as reasons`

export interface OutcomeCounts { bookings: number; within: number; needs: number; out: number; unchecked: number; reasons: number }

export interface ComplianceFigures {
  totals: OutcomeCounts & { out_spend: number }
  months: Month<{ within: number; needs: number; out: number; unchecked: number }>[]
  breaches: { key: string; times: number; red: number; spend: number }[]
  departments: (OutcomeCounts & { name: string })[]
  reasons: { code: string; times: number }[]
}

export async function compliance(db: Queryable, scope: Scope, f: ReportFilters): Promise<ComplianceFigures> {
  const where = booked(scope, f)
  const [totals, months, breaches, departments, reasons] = await Promise.all([
    one<OutcomeCounts & { out_spend: number }>(db, sql`
      select ${OUTCOME_COUNTS}, coalesce(sum(${AMOUNT}) filter (where ${OUT}), 0)::float8 as out_spend
      from ${FROM} where ${where}`),
    monthly<{ within: number; needs: number; out: number; unchecked: number }>(db, where, f, sql`
      count(*) filter (where ${WITHIN})::int as within, count(*) filter (where ${NEEDS})::int as needs,
      count(*) filter (where ${OUT})::int as out, count(*) filter (where ${UNCHECKED})::int as unchecked`),
    many<{ key: string; times: number; red: number; spend: number }>(db, sql`
      select br->>'limit_key' as key, count(*)::int as times,
             count(*) filter (where br->>'severity' = 'red')::int as red, sum(${AMOUNT})::float8 as spend
      from ${FROM} cross join lateral ${BREACHES} br
      where ${where} and br->>'limit_key' is not null
      group by 1 order by 2 desc, 1`),
    many<OutcomeCounts & { name: string }>(db, sql`
      select coalesce(nullif(e.department, ''), 'No department') as name, ${OUTCOME_COUNTS}
      from ${FROM} where ${where} group by 1 order by 2 desc, 1`),
    many<{ code: string; times: number }>(db, sql`
      select b.policy_reason_code as code, count(*)::int as times
      from ${FROM} where ${where} and b.policy_reason_code is not null group by 1 order by 2 desc, 1`),
  ])
  return { totals, months, breaches, departments, reasons }
}

// ── Corporate: savings ───────────────────────────────────────────────────────
// Two things the policy records at booking time:
//   a lowest-fare miss   a cheaper flight on the same route departed within
//                        the group's window (breach lowest_fare_window_minutes,
//                        with the alternative); the extra paid is the chosen
//                        fare less the cheaper one, both as shown on search
//   within grace         a fare over its cap but within the group's grace
//                        (a fare-cap breach that is amber); what was paid
//                        above the cap

const MISS = sql`br->>'limit_key' = 'lowest_fare_window_minutes' and jsonb_typeof(br->'alternative') = 'object'`
const MISS_EXTRA = sql`greatest((br->>'actualValue')::numeric - (br->'alternative'->>'total')::numeric, 0)`
const GRACE = sql`br->>'limit_key' in ('max_fare_domestic', 'max_fare_intl') and br->>'severity' = 'amber'`
const GRACE_EXTRA = sql`greatest((br->>'actualValue')::numeric - (br->>'policyValue')::numeric, 0)`

export interface Miss {
  date: string; traveller: string; origin: string | null; destination: string | null
  chosen_flight: string | null; chosen: number; cheaper_flight: string | null; cheaper_departure: string | null; cheaper: number
}

export const MISS_ROWS = 500

export interface SavingsFigures {
  totals: { misses: number; missed: number; grace: number; above_caps: number }
  months: { month: string; missed: number | null }[]
  misses: Miss[]
}

export async function savings(db: Queryable, scope: Scope, f: ReportFilters): Promise<SavingsFigures> {
  const where = booked(scope, f)
  const [totals, months, misses] = await Promise.all([
    one<{ misses: number; missed: number; grace: number; above_caps: number }>(db, sql`
      select count(*) filter (where ${MISS})::int as misses,
             coalesce(sum(${MISS_EXTRA}) filter (where ${MISS}), 0)::float8 as missed,
             count(*) filter (where ${GRACE})::int as grace,
             coalesce(sum(${GRACE_EXTRA}) filter (where ${GRACE}), 0)::float8 as above_caps
      from ${FROM} cross join lateral ${BREACHES} br where ${where}`),
    many<{ month: string; missed: number | null }>(db, sql`
      select to_char(m, 'YYYY-MM-DD') as month, x.missed
      from generate_series(date_trunc('month', ${f.from}::date::timestamp), date_trunc('month', ${f.to}::date::timestamp),
                           interval '1 month') as m
      left join (select ${MONTH} as at_month, sum(${MISS_EXTRA})::float8 as missed
                 from ${FROM} cross join lateral ${BREACHES} br where ${where} and ${MISS} group by 1) x on x.at_month = m
      order by m`),
    many<Miss>(db, sql`
      select to_char(b.created_at at time zone 'Asia/Kolkata', 'YYYY-MM-DD') as date, e.full_name as traveller,
             b.itinerary->'origin'->>'code' as origin, b.itinerary->'destination'->>'code' as destination,
             nullif(concat_ws(' ', coalesce(b.itinerary->'legs'->0->>'airlineCode', b.itinerary->'airline'->>'code'),
                                   b.itinerary->'legs'->0->>'flightNumber'), '') as chosen_flight,
             (br->>'actualValue')::float8 as chosen,
             nullif(br->'alternative'->>'label', '') as cheaper_flight,
             br->'alternative'->>'departure' as cheaper_departure,
             (br->'alternative'->>'total')::float8 as cheaper
      from ${FROM} cross join lateral ${BREACHES} br
      where ${where} and ${MISS}
      order by b.created_at desc, b.id limit ${MISS_ROWS}`),
  ])
  return { totals, months, misses }
}

// ── Corporate: approvals ─────────────────────────────────────────────────────
// Approval requests raised in the range (approvals.created_at), bookings and
// trip sign-offs alike. Decided = approved or rejected; a step passed on to
// someone's manager (escalated) or made moot by a parallel approver
// (superseded) is neither.

export interface ApproverRow {
  name: string; decided: number; approved: number; rejected: number; waiting: number
  median_hours: number | null; escalated_to: number
}

export interface ApprovalFigures {
  totals: { decided: number; approved: number; median_hours: number | null; escalated: number }
  waiting: { waiting: number; oldest_hours: number | null }
  months: { month: string; approved: number | null; rejected: number | null }[]
  approvers: ApproverRow[]
}

export async function approvals(db: Queryable, clientId: string, f: ReportFilters): Promise<ApprovalFigures> {
  const where = sql`a.client_id = ${clientId} and ${inRange(sql`a.created_at`, f)}`
  const DECIDED = sql`a.status in ('approved', 'rejected')`
  const HOURS = sql`extract(epoch from a.actioned_at - a.created_at) / 3600`
  const [totals, waiting, months, approvers] = await Promise.all([
    one<{ decided: number; approved: number; median_hours: number | null; escalated: number }>(db, sql`
      select count(*) filter (where ${DECIDED})::int as decided,
             count(*) filter (where a.status = 'approved')::int as approved,
             (percentile_cont(0.5) within group (order by ${HOURS}) filter (where ${DECIDED}))::float8 as median_hours,
             count(*) filter (where a.escalated_from is not null)::int as escalated
      from approvals a where ${where}`),
    // Waiting now, whenever it was raised.
    one<{ waiting: number; oldest_hours: number | null }>(db, sql`
      select count(*)::int as waiting, (max(extract(epoch from now() - a.created_at)) / 3600)::float8 as oldest_hours
      from approvals a where a.client_id = ${clientId} and a.status = 'pending'`),
    many<{ month: string; approved: number | null; rejected: number | null }>(db, sql`
      select to_char(m, 'YYYY-MM-DD') as month, x.approved, x.rejected
      from generate_series(date_trunc('month', ${f.from}::date::timestamp), date_trunc('month', ${f.to}::date::timestamp),
                           interval '1 month') as m
      left join (select date_trunc('month', a.created_at at time zone 'Asia/Kolkata') as at_month,
                        count(*) filter (where a.status = 'approved')::int as approved,
                        count(*) filter (where a.status = 'rejected')::int as rejected
                 from approvals a where ${where} group by 1) x on x.at_month = m
      order by m`),
    many<ApproverRow>(db, sql`
      select p.full_name as name,
             count(*) filter (where ${DECIDED})::int as decided,
             count(*) filter (where a.status = 'approved')::int as approved,
             count(*) filter (where a.status = 'rejected')::int as rejected,
             count(*) filter (where a.status = 'pending')::int as waiting,
             (percentile_cont(0.5) within group (order by ${HOURS}) filter (where ${DECIDED}))::float8 as median_hours,
             count(*) filter (where a.escalated_from is not null)::int as escalated_to
      from approvals a join employees p on p.id = a.approver_id
      where ${where}
      group by p.id, p.full_name order by 2 desc, 1`),
  ])
  return { totals, waiting, months, approvers }
}

// ── Corporate: trips and budgets ─────────────────────────────────────────────
// Trips set up in the range. Spent = the trip's booked bookings at the sell
// total, so it compares with the budget only when the trip's currency is INR.

export interface TripRow {
  name: string | null; traveller: string; cost_centre: string | null; project: string | null
  billable: boolean; currency: string; budget: number | null; spent: number; bookings: number
  approval_status: string; status: string; created: string
}

export const TRIP_ROWS = 2000

export async function trips(db: Queryable, clientId: string, f: ReportFilters): Promise<TripRow[]> {
  return many<TripRow>(db, sql`
    select t.name, tr.full_name as traveller, cc.name as cost_centre, t.project, t.billable, t.currency,
           t.budget_amount::float8 as budget,
           coalesce(s.spent, 0)::float8 as spent, coalesce(s.bookings, 0)::int as bookings,
           t.approval_status, t.status, to_char(t.created_at at time zone 'Asia/Kolkata', 'YYYY-MM-DD') as created
    from trips t
    join employees tr on tr.id = t.created_by
    left join cost_centres cc on cc.id = t.cost_centre_id
    left join lateral (
      select sum(${AMOUNT}) as spent, count(*) as bookings from bookings b where b.trip_id = t.id and ${BOOKED}
    ) s on true
    where t.client_id = ${clientId} and t.status <> 'deleted' and ${inRange(sql`t.created_at`, f)}
      ${f.costCentre ? sql`and cc.code = ${f.costCentre}` : empty}
      ${f.billable ? sql`and t.billable = ${f.billable === 'yes'}` : empty}
    order by t.created_at desc, t.id limit ${TRIP_ROWS}`)
}

// ── Corporate: travel patterns ───────────────────────────────────────────────

export interface Ranked { name: string; bookings: number; spend: number }

export interface PatternFigures {
  totals: { bookings: number; lead_avg: number | null; d0: number; d3: number; d7: number; d14: number; personal: number; guest: number }
  routes: Ranked[]
  airlines: Ranked[]
  travellers: Ranked[]
}

export async function patterns(db: Queryable, scope: Scope, f: ReportFilters): Promise<PatternFigures> {
  const where = booked(scope, f)
  // Days between booking and the outbound departure (the provider's local
  // date, as text). A departure that is not a date is left out.
  const LEAD = sql`(left(b.itinerary->'origin'->>'dateTime', 10)::date - (b.created_at at time zone 'Asia/Kolkata')::date)`
  const HAS_DATE = sql`b.itinerary->'origin'->>'dateTime' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'`
  const top = (label: Sql, group: Sql) => many<Ranked>(db, sql`
    select ${label} as name, count(*)::int as bookings, sum(${AMOUNT})::float8 as spend
    from ${FROM} where ${where} group by ${group} order by 2 desc, 3 desc, 1 limit 20`)
  const [totals, routes, airlines, travellers] = await Promise.all([
    one<{ bookings: number; lead_avg: number | null; d0: number; d3: number; d7: number; d14: number; personal: number; guest: number }>(db, sql`
      select count(*)::int as bookings,
             (avg(${LEAD}) filter (where ${HAS_DATE}))::float8 as lead_avg,
             count(*) filter (where ${HAS_DATE} and ${LEAD} <= 2)::int as d0,
             count(*) filter (where ${HAS_DATE} and ${LEAD} between 3 and 6)::int as d3,
             count(*) filter (where ${HAS_DATE} and ${LEAD} between 7 and 13)::int as d7,
             count(*) filter (where ${HAS_DATE} and ${LEAD} >= 14)::int as d14,
             count(*) filter (where b.purpose = 'personal')::int as personal,
             count(*) filter (where b.for_guest)::int as guest
      from ${FROM} where ${where}`),
    top(sql`concat_ws(' – ', b.itinerary->'origin'->>'code', b.itinerary->'destination'->>'code')`, sql`1`),
    top(sql`coalesce(max(b.itinerary->'airline'->>'name'), 'Unknown') || coalesce(' (' || (b.itinerary->'airline'->>'code') || ')', '')`,
      sql`b.itinerary->'airline'->>'code'`),
    top(sql`e.full_name`, sql`e.id, e.full_name`),
  ])
  return { totals, routes, airlines, travellers }
}

// ── TMC: revenue ─────────────────────────────────────────────────────────────
// From the commercials record stamped on each booking. A booking made before
// commercials has none: its airline cost is its total and its margin 0, and
// it is counted so the table can say so.

const HAS_COMMERCIALS = sql`jsonb_typeof(b.commercials->'airline') = 'object'`
const AIRLINE = sql`coalesce((b.commercials->'airline'->>'total')::numeric, b.total_cost)`
const MARGIN = sql`coalesce((b.commercials->>'tmcMargin')::numeric, 0)`
function adjustment(source: string): Sql {
  return sql`coalesce((select sum((x->>'amount')::numeric)
    from jsonb_array_elements(case when jsonb_typeof(b.commercials->'adjustments') = 'array'
      then b.commercials->'adjustments' else '[]'::jsonb end) x
    where x->>'source' = ${source}), 0)`
}
const REVENUE_SUMS = sql`
  count(*)::int as bookings,
  coalesce(sum(${AMOUNT}), 0)::float8 as sell,
  coalesce(sum(${AIRLINE}), 0)::float8 as airline,
  coalesce(sum(${adjustment('markup')}), 0)::float8 as markup,
  coalesce(sum(${adjustment('discount')}), 0)::float8 as discount,
  coalesce(sum(${adjustment('processing_fee')}), 0)::float8 as fee,
  coalesce(sum(${MARGIN}), 0)::float8 as margin,
  count(*) filter (where not ${HAS_COMMERCIALS})::int as without`

export interface RevenueSums { bookings: number; sell: number; airline: number; markup: number; discount: number; fee: number; margin: number; without: number }

export interface RevenueFigures {
  totals: RevenueSums
  months: Month<{ margin: number }>[]
  clients: (RevenueSums & { name: string })[]
}

export async function revenue(db: Queryable, scope: Scope, f: ReportFilters): Promise<RevenueFigures> {
  const where = booked(scope, f)
  const [totals, months, clients] = await Promise.all([
    one<RevenueSums>(db, sql`select ${REVENUE_SUMS} from ${FROM} where ${where}`),
    monthly<{ margin: number }>(db, where, f, sql`sum(${MARGIN})::float8 as margin`),
    many<RevenueSums & { name: string }>(db, sql`
      select c.name, ${REVENUE_SUMS}
      from ${FROM} join clients c on c.id = b.client_id
      where ${where} group by c.id, c.name order by 8 desc, 1`),
  ])
  return { totals, months, clients }
}

// ── TMC: client activity ─────────────────────────────────────────────────────

export interface ClientActivity {
  name: string; status: string; booking_mode: string; group_name: string | null; joined: string
  bookings: number; travellers: number; spend: number; last_booking: string | null
}

export interface ActivityFigures {
  rows: ClientActivity[]
  months: Month<{ bookings: number }>[]
  joined: number
}

export async function clientActivity(
  db: Queryable, scope: Extract<Scope, { side: 'tmc' }>, f: ReportFilters,
): Promise<ActivityFigures> {
  const IN_RANGE = sql`${inRange(sql`b.created_at`, f)}`
  const rows = await many<ClientActivity>(db, sql`
    select c.name, c.status, c.booking_mode, cg.name as group_name,
           to_char(c.created_at at time zone 'Asia/Kolkata', 'YYYY-MM-DD') as joined,
           count(b.id) filter (where ${IN_RANGE})::int as bookings,
           count(distinct b.employee_id) filter (where ${IN_RANGE})::int as travellers,
           coalesce(sum(${AMOUNT}) filter (where ${IN_RANGE}), 0)::float8 as spend,
           to_char(max(b.created_at) at time zone 'Asia/Kolkata', 'YYYY-MM-DD') as last_booking
    from clients c
    left join client_groups cg on cg.id = c.client_group_id
    left join bookings b on b.client_id = c.id and ${BOOKED}
    where c.tmc_id = ${scope.tmcId}
      ${scope.clientIds === null ? empty : sql`and c.id = any(${scope.clientIds})`}
      ${f.clientId ? sql`and c.id = ${f.clientId}` : empty}
      ${f.clientGroupId ? sql`and c.client_group_id = ${f.clientGroupId}` : empty}
    group by c.id, cg.name
    order by 6 desc, 8 desc, 1`)
  const where = booked(scope, f)
  const [months, created] = await Promise.all([
    monthly<{ bookings: number }>(db, where, f, sql`count(*)::int as bookings`),
    one<{ joined: number }>(db, sql`
      select count(*)::int as joined from clients c
      where c.tmc_id = ${scope.tmcId} and ${inRange(sql`c.created_at`, f)}
        ${scope.clientIds === null ? empty : sql`and c.id = any(${scope.clientIds})`}
        ${f.clientId ? sql`and c.id = ${f.clientId}` : empty}
        ${f.clientGroupId ? sql`and c.client_group_id = ${f.clientGroupId}` : empty}`),
  ])
  return { rows, months, joined: created.joined }
}

// ── TMC: airlines and deal codes ─────────────────────────────────────────────

export interface AirlineFigures {
  totals: { bookings: number; airlines: number; on_deal: number }
  airlines: { code: string | null; name: string; bookings: number; airline: number; sell: number }[]
  deals: { code: string; airline: string | null; code_type: string | null; uses: number; clients: number }[]
}

export async function airlinesAndDeals(db: Queryable, scope: Scope, f: ReportFilters): Promise<AirlineFigures> {
  const where = booked(scope, f)
  const DEALS = sql`jsonb_array_elements(case when jsonb_typeof(b.resolved_deal_codes) = 'array'
    then b.resolved_deal_codes else '[]'::jsonb end)`
  const [totals, airlines, deals] = await Promise.all([
    one<{ bookings: number; airlines: number; on_deal: number }>(db, sql`
      select count(*)::int as bookings,
             count(distinct b.itinerary->'airline'->>'code')::int as airlines,
             count(*) filter (where jsonb_typeof(b.resolved_deal_codes) = 'array'
                              and jsonb_array_length(b.resolved_deal_codes) > 0)::int as on_deal
      from ${FROM} where ${where}`),
    many<{ code: string | null; name: string; bookings: number; airline: number; sell: number }>(db, sql`
      select b.itinerary->'airline'->>'code' as code,
             coalesce(max(b.itinerary->'airline'->>'name'), b.itinerary->'airline'->>'code', 'Unknown') as name,
             count(*)::int as bookings, sum(${AIRLINE})::float8 as airline, sum(${AMOUNT})::float8 as sell
      from ${FROM} where ${where}
      group by b.itinerary->'airline'->>'code' order by 3 desc, 4 desc, 2`),
    many<{ code: string; airline: string | null; code_type: string | null; uses: number; clients: number }>(db, sql`
      select d->>'code' as code, d->>'airline' as airline, d->>'codeType' as code_type,
             count(distinct b.id)::int as uses, count(distinct b.client_id)::int as clients
      from ${FROM} cross join lateral ${DEALS} d
      where ${where} and d->>'code' is not null
      group by 1, 2, 3 order by 4 desc, 1`),
  ])
  return { totals, airlines, deals }
}

// ── TMC: desk productivity ───────────────────────────────────────────────────
// A desk booking is one the TMC's own staff made (booked_by a TMC admin or
// counsellor), for a traveller at a client.

const DESK = sql`k.role in ('tmc_admin', 'tc')`

export interface DeskFigures {
  totals: { bookings: number; desk: number; cbt: number; sbt: number; hybrid: number }
  months: { month: string; desk: number | null }[]
  people: { name: string; role: string; bookings: number; clients: number; spend: number }[]
}

export async function desk(db: Queryable, scope: Scope, f: ReportFilters): Promise<DeskFigures> {
  const where = booked(scope, f)
  const DESK_FROM = sql`${FROM} join employees k on k.id = b.booked_by join clients c on c.id = b.client_id`
  const [totals, months, people] = await Promise.all([
    one<{ bookings: number; desk: number; cbt: number; sbt: number; hybrid: number }>(db, sql`
      select count(*)::int as bookings, count(*) filter (where ${DESK})::int as desk,
             count(*) filter (where ${DESK} and c.booking_mode = 'cbt')::int as cbt,
             count(*) filter (where ${DESK} and c.booking_mode = 'sbt')::int as sbt,
             count(*) filter (where ${DESK} and c.booking_mode = 'hybrid')::int as hybrid
      from ${DESK_FROM} where ${where}`),
    many<{ month: string; desk: number | null }>(db, sql`
      select to_char(m, 'YYYY-MM-DD') as month, x.desk
      from generate_series(date_trunc('month', ${f.from}::date::timestamp), date_trunc('month', ${f.to}::date::timestamp),
                           interval '1 month') as m
      left join (select ${MONTH} as at_month, count(*)::int as desk
                 from ${DESK_FROM} where ${where} and ${DESK} group by 1) x on x.at_month = m
      order by m`),
    many<{ name: string; role: string; bookings: number; clients: number; spend: number }>(db, sql`
      select k.full_name as name, k.role, count(*)::int as bookings, count(distinct b.client_id)::int as clients,
             sum(${AMOUNT})::float8 as spend
      from ${DESK_FROM} where ${where} and ${DESK}
      group by k.id, k.full_name, k.role order by 3 desc, 5 desc, 1`),
  ])
  return { totals, months, people }
}

// ── TMC: compliance across clients ───────────────────────────────────────────

export interface ClientComplianceFigures {
  totals: OutcomeCounts
  clients: (OutcomeCounts & { name: string })[]
}

export async function complianceByClient(db: Queryable, scope: Scope, f: ReportFilters): Promise<ClientComplianceFigures> {
  const where = booked(scope, f)
  const [totals, clients] = await Promise.all([
    one<OutcomeCounts>(db, sql`select ${OUTCOME_COUNTS} from ${FROM} where ${where}`),
    many<OutcomeCounts & { name: string }>(db, sql`
      select c.name, ${OUTCOME_COUNTS}
      from ${FROM} join clients c on c.id = b.client_id
      where ${where} group by c.id, c.name order by 2 desc, 1`),
  ])
  return { totals, clients }
}

// ── TMC: payments ────────────────────────────────────────────────────────────
// Who pays, from the form of payment stamped on the booking. A booking made
// before forms of payment were stamped has none ("not recorded").

const PAYER = sql`coalesce(b.resolved_fop->>'payer', 'not_recorded')`

export interface PaymentFigures {
  totals: { payer: string; bookings: number; amount: number }[]
  months: { month: string; payer: string | null; bookings: number | null }[]
  clients: { name: string; payer: string; bookings: number; amount: number }[]
}

export async function payments(db: Queryable, scope: Scope, f: ReportFilters): Promise<PaymentFigures> {
  const where = booked(scope, f)
  const [totals, months, clients] = await Promise.all([
    many<{ payer: string; bookings: number; amount: number }>(db, sql`
      select ${PAYER} as payer, count(*)::int as bookings, sum(${AMOUNT})::float8 as amount
      from ${FROM} where ${where} group by 1 order by 2 desc`),
    many<{ month: string; payer: string | null; bookings: number | null }>(db, sql`
      select to_char(m, 'YYYY-MM-DD') as month, x.payer, x.bookings
      from generate_series(date_trunc('month', ${f.from}::date::timestamp), date_trunc('month', ${f.to}::date::timestamp),
                           interval '1 month') as m
      left join (select ${MONTH} as at_month, ${PAYER} as payer, count(*)::int as bookings
                 from ${FROM} where ${where} group by 1, 2) x on x.at_month = m
      order by m, x.payer`),
    many<{ name: string; payer: string; bookings: number; amount: number }>(db, sql`
      select c.name, ${PAYER} as payer, count(*)::int as bookings, sum(${AMOUNT})::float8 as amount
      from ${FROM} join clients c on c.id = b.client_id
      where ${where} group by c.id, c.name, 2 order by 1, 3 desc`),
  ])
  return { totals, months, clients }
}

// ── Filter choices ───────────────────────────────────────────────────────────

export interface FilterOption { value: string; label: string }

export async function corporateOptions(
  db: Queryable, clientId: string,
): Promise<{ departments: FilterOption[]; costCentres: FilterOption[]; bands: FilterOption[] }> {
  const [departments, costCentres, bands] = await Promise.all([
    many<{ value: string }>(db, sql`
      select distinct coalesce(nullif(department, ''), 'No department') as value
      from employees where client_id = ${clientId} order by 1`),
    many<{ value: string; label: string }>(db, sql`
      select code as value, name || ' (' || code || ')' as label from cost_centres where client_id = ${clientId} order by name`),
    many<{ value: string; label: string }>(db, sql`
      select code as value, label || ' (' || code || ')' as label from bands where client_id = ${clientId} order by rank`),
  ])
  return { departments: departments.map(d => ({ value: d.value, label: d.value })), costCentres, bands }
}

export async function tmcOptions(db: Queryable, tmcId: string): Promise<{ clientGroups: FilterOption[] }> {
  const groups = await many<{ value: string; label: string }>(db, sql`
    select id as value, name as label from client_groups where tmc_id = ${tmcId} order by name`)
  return { clientGroups: groups }
}
