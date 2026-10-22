import { sql, one, maybeOne, many, type Queryable } from '@/app/lib/db/sql'

// ── The corporate dashboard's figures ────────────────────────────────────────
// Counted in SQL, never fetched and added up: a large company has thousands
// of bookings. A booking counts once it is booked with the airline (held or
// ticketed); its amount is what the company pays (sell_total, or total_cost
// on bookings made before commercials, where the two are the same). Months
// and years are India's (Asia/Kolkata), as the rest of the product.
// ─────────────────────────────────────────────────────────────────────────────

const BOOKED = sql`status in ('held', 'ticketed')`
const AMOUNT = sql`coalesce(sell_total, total_cost)`
const MONTH_START = sql`(date_trunc('month', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata')`
const YEAR_START = sql`(date_trunc('year', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata')`

export interface MyTravel {
  bookedThisYear: number
  spendThisYear: number
  awaitingApproval: number
  next: { id: string; origin: string | null; destination: string | null; departure: string } | null
}

// The traveller's own: what they have flown or will fly this year, and what
// is next. The departure is the provider's local time, compared as text
// against today's date in India: it carries no zone.
export async function myTravel(db: Queryable, employeeId: string): Promise<MyTravel> {
  const [totals, next] = await Promise.all([
    one<{ booked: number; spend: number; awaiting: number }>(db, sql`
      select count(*) filter (where ${BOOKED} and created_at >= ${YEAR_START})::int as booked,
             coalesce(sum(${AMOUNT}) filter (where ${BOOKED} and created_at >= ${YEAR_START}), 0)::float8 as spend,
             count(*) filter (where status = 'pending_approval')::int as awaiting
      from bookings where employee_id = ${employeeId}`),
    maybeOne<{ id: string; origin: string | null; destination: string | null; departure: string }>(db, sql`
      select id, itinerary->'origin'->>'code' as origin, itinerary->'destination'->>'code' as destination,
             itinerary->'origin'->>'dateTime' as departure
      from bookings
      where employee_id = ${employeeId} and ${BOOKED}
        and itinerary->'origin'->>'dateTime' >= to_char(now() at time zone 'Asia/Kolkata', 'YYYY-MM-DD"T"HH24:MI')
      order by itinerary->'origin'->>'dateTime' limit 1`),
  ])
  return { bookedThisYear: totals.booked, spendThisYear: totals.spend, awaitingApproval: totals.awaiting, next }
}

export interface ApproverWork {
  decided30d: number
  medianHours: number | null
}

export async function approverWork(db: Queryable, approverId: string): Promise<ApproverWork> {
  const row = await one<{ decided: number; median: number | null }>(db, sql`
    select count(*)::int as decided,
           (percentile_cont(0.5) within group (order by extract(epoch from actioned_at - created_at) / 3600))::float8 as median
    from approvals
    where approver_id = ${approverId} and status in ('approved', 'rejected')
      and actioned_at >= now() - interval '30 days'`)
  return { decided30d: row.decided, medianHours: row.median === null ? null : Math.round(row.median * 10) / 10 }
}

export interface CompanyFigures {
  thisMonth: { bookings: number; spend: number }
  lastMonth: { bookings: number; spend: number }
  // This month's booked bookings by outcome; not_evaluated when policy was
  // not checked (no band, no group, policy control off).
  outcomes: { within: number; needsApproval: number; outOfPolicy: number; notEvaluated: number }
  outOfPolicySpend: number
  topDepartment: { name: string; spend: number } | null
  // The last six months, oldest first, each with its first day (India).
  months: { month: string; bookings: number; spend: number }[]
}

export async function companyFigures(db: Queryable, clientId: string): Promise<CompanyFigures> {
  const [totals, top, months] = await Promise.all([
    one<{
      tm_b: number; tm_s: number; lm_b: number; lm_s: number
      within: number; needs: number; out: number; none: number; out_s: number
    }>(db, sql`
      select count(*) filter (where created_at >= ${MONTH_START})::int as tm_b,
             coalesce(sum(${AMOUNT}) filter (where created_at >= ${MONTH_START}), 0)::float8 as tm_s,
             count(*) filter (where created_at < ${MONTH_START} and created_at >= ${MONTH_START} - interval '1 month')::int as lm_b,
             coalesce(sum(${AMOUNT}) filter (where created_at < ${MONTH_START} and created_at >= ${MONTH_START} - interval '1 month'), 0)::float8 as lm_s,
             count(*) filter (where created_at >= ${MONTH_START} and policy_status = 'evaluated' and policy_verdict = 'green')::int as within,
             count(*) filter (where created_at >= ${MONTH_START} and policy_status = 'evaluated' and policy_verdict = 'amber')::int as needs,
             count(*) filter (where created_at >= ${MONTH_START} and policy_status = 'evaluated' and policy_verdict = 'red')::int as out,
             count(*) filter (where created_at >= ${MONTH_START} and policy_status is distinct from 'evaluated')::int as none,
             coalesce(sum(${AMOUNT}) filter (where created_at >= ${MONTH_START} and policy_verdict = 'red'), 0)::float8 as out_s
      from bookings
      where client_id = ${clientId} and ${BOOKED} and created_at >= ${MONTH_START} - interval '1 month'`),
    maybeOne<{ name: string; spend: number }>(db, sql`
      select coalesce(nullif(e.department, ''), 'No department') as name, sum(${AMOUNT})::float8 as spend
      from bookings b join employees e on e.id = b.employee_id
      where b.client_id = ${clientId} and b.${BOOKED} and b.created_at >= ${MONTH_START}
      group by 1 order by 2 desc, 1 limit 1`),
    many<{ month: string; bookings: number; spend: number }>(db, sql`
      select to_char(m, 'YYYY-MM-DD') as month,
             count(b.id)::int as bookings, coalesce(sum(coalesce(b.sell_total, b.total_cost)), 0)::float8 as spend
      from generate_series(
             date_trunc('month', now() at time zone 'Asia/Kolkata') - interval '5 months',
             date_trunc('month', now() at time zone 'Asia/Kolkata'), interval '1 month') as m
      left join bookings b on b.client_id = ${clientId} and b.status in ('held', 'ticketed')
        and date_trunc('month', b.created_at at time zone 'Asia/Kolkata') = m
      group by m order by m`),
  ])
  return {
    thisMonth: { bookings: totals.tm_b, spend: totals.tm_s },
    lastMonth: { bookings: totals.lm_b, spend: totals.lm_s },
    outcomes: { within: totals.within, needsApproval: totals.needs, outOfPolicy: totals.out, notEvaluated: totals.none },
    outOfPolicySpend: totals.out_s,
    topDepartment: top,
    months,
  }
}
