import type { Queryable } from '@/app/lib/db'
import * as reports from '@/app/lib/repositories/reports'
import type { Scope, SpendGroup, OutcomeCounts } from '@/app/lib/repositories/reports'
import { BREACH_LABELS } from '@/app/lib/policy/breachText'
import { POLICY_REASONS } from '@/app/lib/book/policyReasons'
import { tripStatus, signOffStatus } from '@/app/lib/trips/status'
import type { Report, ReportFilters, ReportTable } from './types'
import { pct, round2, series, stacked, num, col, sentence, plural } from './shape'

// ── The company's reports ────────────────────────────────────────────────────
// For a company's admins and finance. Sell side only: every amount is what
// the company pays. Each builder shapes what app/lib/repositories/reports.ts
// counted; nothing here reads the database itself.
// ─────────────────────────────────────────────────────────────────────────────

const OUTCOME_LEGEND = ['Within policy', 'Needs approval', 'Out of policy', 'Not checked']

function spendTable(key: string, title: string, label: string, rows: SpendGroup[], total: number): ReportTable {
  return {
    key, title,
    columns: [col('name', label, 'text'), col('bookings', 'Bookings', 'count'), col('spend', 'Spend', 'money'),
      col('average', 'Average fare', 'money'), col('share', 'Share of spend', 'percent')],
    rows: rows.map(r => ({
      name: r.name, bookings: r.bookings, spend: round2(r.spend),
      average: r.bookings ? round2(r.spend / r.bookings) : null, share: pct(r.spend, total),
    })),
  }
}

export async function spend(db: Queryable, scope: Scope, f: ReportFilters): Promise<Report> {
  const r = await reports.spend(db, scope, f)
  const { bookings, spend: total, domestic } = r.totals
  return {
    key: 'spend', title: 'Spend',
    description: 'What the company paid for flights booked in the period, by who travelled.',
    headline: [
      { label: 'Total spend', value: round2(total), kind: 'money' },
      { label: 'Bookings', value: bookings, kind: 'count' },
      { label: 'Average fare', value: bookings ? round2(total / bookings) : null, kind: 'money' },
      { label: 'Domestic', value: pct(domestic, bookings), kind: 'percent',
        hint: bookings ? `${plural(bookings - domestic, 'international booking', 'international bookings')}` : 'No bookings in this period' },
    ],
    chart: { title: 'Spend by month', kind: 'series', valueKind: 'money', points: series(r.months, m => num(m.spend)) },
    tables: [
      spendTable('departments', 'By department', 'Department', r.departments, total),
      spendTable('cost-centres', 'By cost centre', 'Cost centre', r.costCentres, total),
      spendTable('bands', 'By band', 'Band', r.bands, total),
    ],
  }
}

export function outcomeColumns(label: string) {
  return [col('name', label, 'text'), col('bookings', 'Bookings', 'count'), col('within', 'Within policy', 'count'),
    col('needs', 'Needs approval', 'count'), col('out', 'Out of policy', 'count'), col('unchecked', 'Not checked', 'count'),
    col('outShare', 'Out of policy %', 'percent'), col('reasons', 'Reasons given', 'count')]
}

export function outcomeRow(r: OutcomeCounts & { name: string }) {
  const checked = r.within + r.needs + r.out
  return { name: r.name, bookings: r.bookings, within: r.within, needs: r.needs, out: r.out,
    unchecked: r.unchecked, outShare: pct(r.out, checked), reasons: r.reasons }
}

const REASON_LABEL: Record<string, string> = Object.fromEntries(POLICY_REASONS.map(r => [r.code, r.label]))

export async function compliance(db: Queryable, scope: Scope, f: ReportFilters): Promise<Report> {
  const r = await reports.compliance(db, scope, f)
  const t = r.totals
  const checked = t.within + t.needs + t.out
  const headline: Report['headline'] = [
    { label: 'Within policy', value: pct(t.within, checked), kind: 'percent', hint: plural(t.within, 'booking', 'bookings') },
    { label: 'Needs approval', value: pct(t.needs, checked), kind: 'percent', hint: plural(t.needs, 'booking', 'bookings') },
    { label: 'Out of policy', value: pct(t.out, checked), kind: 'percent', hint: plural(t.out, 'booking', 'bookings') },
    { label: 'Out-of-policy spend', value: round2(t.out_spend), kind: 'money' },
    { label: 'Reasons given', value: t.reasons, kind: 'count', hint: 'Why a booking went ahead outside policy' },
  ]
  if (t.unchecked > 0) {
    headline.push({ label: 'Not checked', value: t.unchecked, kind: 'count',
      hint: 'No band or policy group, or policy control off; not in the percentages' })
  }
  return {
    key: 'compliance', title: 'Policy compliance',
    description: 'How bookings measured up to the travel policy when they were made, and which rules were broken.',
    headline,
    chart: {
      title: 'Outcomes by month', kind: 'series', valueKind: 'count', legend: OUTCOME_LEGEND,
      points: stacked(r.months, [m => num(m.within), m => num(m.needs), m => num(m.out), m => num(m.unchecked)]),
    },
    tables: [
      {
        key: 'rules', title: 'Rules broken',
        note: 'A booking that broke two rules is counted under each.',
        columns: [col('rule', 'Rule', 'text'), col('times', 'Bookings', 'count'), col('red', 'Out of policy', 'count'),
          col('spend', 'Spend on them', 'money')],
        rows: r.breaches.map(b => ({ rule: sentence(BREACH_LABELS[b.key] ?? b.key.replace(/_/g, ' ')), times: b.times,
          red: b.red, spend: round2(b.spend) })),
      },
      { key: 'departments', title: 'By department', columns: outcomeColumns('Department'), rows: r.departments.map(outcomeRow) },
      {
        key: 'reasons', title: 'Reasons given',
        columns: [col('reason', 'Reason', 'text'), col('times', 'Bookings', 'count')],
        rows: r.reasons.map(x => ({ reason: (REASON_LABEL[x.code] ?? x.code).replace(/ \(explain\)$/, ''), times: x.times })),
      },
    ],
  }
}

export async function savings(db: Queryable, scope: Scope, f: ReportFilters): Promise<Report> {
  const r = await reports.savings(db, scope, f)
  const t = r.totals
  return {
    key: 'savings', title: 'Savings',
    description: 'Money left on the table: cheaper flights at nearly the same time that were not taken, and fares paid above their cap within the grace. Counted where the policy group sets a lowest-fare window or a grace.',
    headline: [
      { label: 'Lowest-fare misses', value: t.misses, kind: 'count', hint: 'A cheaper flight left within the window' },
      { label: 'Extra paid on them', value: round2(t.missed), kind: 'money' },
      { label: 'Fares within grace', value: t.grace, kind: 'count', hint: 'Over the fare cap, within the grace' },
      { label: 'Paid above the caps', value: round2(t.above_caps), kind: 'money' },
    ],
    chart: { title: 'Extra paid on lowest-fare misses, by month', kind: 'series', valueKind: 'money',
      points: series(r.months, m => num(m.missed)) },
    tables: [{
      key: 'misses', title: 'Lowest-fare misses',
      note: r.misses.length === reports.MISS_ROWS ? `The latest ${reports.MISS_ROWS} are listed.` : 'Fares as the traveller saw them on search.',
      columns: [col('date', 'Booked', 'date'), col('traveller', 'Traveller', 'text'), col('route', 'Route', 'text'),
        col('chosenFlight', 'Flight taken', 'text'), col('chosen', 'Its fare', 'money'), col('cheaperFlight', 'Cheaper flight', 'text'),
        col('cheaper', 'Its fare', 'money'), col('difference', 'Difference', 'money')],
      rows: r.misses.map(m => {
        const time = m.cheaper_departure ? /T(\d{2}:\d{2})/.exec(m.cheaper_departure)?.[1] : undefined
        return {
          date: m.date, traveller: m.traveller, route: [m.origin, m.destination].filter(Boolean).join(' – '),
          chosenFlight: m.chosen_flight, chosen: round2(m.chosen),
          cheaperFlight: [m.cheaper_flight, time && `at ${time}`].filter(Boolean).join(' ') || null,
          cheaper: round2(m.cheaper), difference: round2(Math.max(m.chosen - m.cheaper, 0)),
        }
      }),
    }],
  }
}

export async function approvals(db: Queryable, scope: Scope, f: ReportFilters): Promise<Report> {
  if (scope.side !== 'client') throw new Error('approvals is a company report')
  const r = await reports.approvals(db, scope.clientId, f)
  const t = r.totals
  const hours = (h: number | null) => (h === null ? null : Math.round(h * 10) / 10)
  return {
    key: 'approvals', title: 'Approvals',
    description: 'Approval requests raised in the period, for bookings and trip sign-offs, and how quickly they were decided.',
    headline: [
      { label: 'Decided', value: t.decided, kind: 'count' },
      { label: 'Approved', value: pct(t.approved, t.decided), kind: 'percent', hint: plural(t.approved, 'request', 'requests') },
      { label: 'Median time to decide', value: hours(t.median_hours), kind: 'hours' },
      { label: 'Waiting now', value: r.waiting.waiting, kind: 'count',
        hint: r.waiting.oldest_hours !== null ? `Oldest ${Math.round(r.waiting.oldest_hours)} h` : 'Nothing waiting' },
      { label: 'Escalated', value: t.escalated, kind: 'count', hint: 'Passed to the approver’s manager' },
    ],
    chart: { title: 'Decisions by month', kind: 'series', valueKind: 'count', legend: ['Approved', 'Rejected'],
      points: stacked(r.months, [m => num(m.approved), m => num(m.rejected)]) },
    tables: [{
      key: 'approvers', title: 'By approver',
      columns: [col('name', 'Approver', 'text'), col('decided', 'Decided', 'count'), col('approved', 'Approved', 'count'),
        col('rejected', 'Rejected', 'count'), col('waiting', 'Waiting', 'count'), col('median', 'Median time', 'hours'),
        col('escalatedTo', 'Escalated to them', 'count')],
      rows: r.approvers.map(a => ({ name: a.name, decided: a.decided, approved: a.approved, rejected: a.rejected,
        waiting: a.waiting, median: hours(a.median_hours), escalatedTo: a.escalated_to })),
    }],
  }
}

export async function trips(db: Queryable, scope: Scope, f: ReportFilters): Promise<Report> {
  if (scope.side !== 'client') throw new Error('trips is a company report')
  const rows = await reports.trips(db, scope.clientId, f)
  const budgeted = rows.filter(t => t.budget !== null)
  const comparable = (t: reports.TripRow) => t.budget !== null && t.currency === 'INR'
  const over = rows.filter(t => comparable(t) && t.spent > (t.budget as number))
  const byCentre = new Map<string, number>()
  for (const t of rows) {
    const k = t.cost_centre ?? 'No cost centre'
    byCentre.set(k, (byCentre.get(k) ?? 0) + t.spent)
  }
  return {
    key: 'trips', title: 'Trips & budgets',
    description: 'Trips set up in the period: what each has spent on booked flights against its budget.',
    headline: [
      { label: 'Trips', value: rows.length, kind: 'count' },
      { label: 'Billable', value: pct(rows.filter(t => t.billable).length, rows.length), kind: 'percent' },
      { label: 'With a budget', value: budgeted.length, kind: 'count' },
      { label: 'Over budget', value: over.length, kind: 'count', hint: 'INR budgets only' },
    ],
    chart: { title: 'Spent by cost centre', kind: 'list', valueKind: 'money',
      points: [...byCentre].map(([label, value]) => ({ label, value: round2(value) })).sort((a, b) => b.value - a.value) },
    tables: [{
      key: 'trips', title: 'Trips',
      note: rows.length === reports.TRIP_ROWS ? `The latest ${reports.TRIP_ROWS} are listed.` : 'Spent: booked flights at what the company pays.',
      columns: [col('name', 'Trip', 'text'), col('traveller', 'Traveller', 'text'), col('costCentre', 'Cost centre', 'text'),
        col('project', 'Project', 'text'), col('billable', 'Billable', 'text'), col('bookings', 'Flights', 'count'),
        col('budget', 'Budget', 'money'), col('spent', 'Spent', 'money'), col('difference', 'Left', 'money'),
        col('status', 'Status', 'text'), col('signOff', 'Sign-off', 'text'), col('created', 'Set up', 'date')],
      rows: rows.map(t => ({
        name: t.name ?? 'Untitled trip', traveller: t.traveller, costCentre: t.cost_centre, project: t.project,
        billable: t.billable ? 'Yes' : 'No', bookings: t.bookings,
        budget: t.budget === null ? null : round2(t.budget), spent: round2(t.spent),
        difference: comparable(t) ? round2((t.budget as number) - t.spent) : null,
        status: tripStatus(t.status).label, signOff: signOffStatus(t.approval_status)?.label ?? 'Not needed', created: t.created,
      })),
    }],
  }
}

const LEAD_LABELS = ['0–2 days', '3–6 days', '7–13 days', '14+ days']

export async function patterns(db: Queryable, scope: Scope, f: ReportFilters): Promise<Report> {
  const r = await reports.patterns(db, scope, f)
  const t = r.totals
  const ranked = (key: string, title: string, label: string, rows: reports.Ranked[]): ReportTable => ({
    key, title, note: rows.length === 20 ? 'The top 20.' : undefined,
    columns: [col('name', label, 'text'), col('bookings', 'Bookings', 'count'), col('spend', 'Spend', 'money')],
    rows: rows.map(x => ({ name: x.name, bookings: x.bookings, spend: round2(x.spend) })),
  })
  return {
    key: 'patterns', title: 'Travel patterns',
    description: 'Where people fly, with whom, and how far ahead they book.',
    headline: [
      { label: 'Top route', value: r.routes[0]?.name ?? null, kind: 'text',
        hint: r.routes[0] ? plural(r.routes[0].bookings, 'booking', 'bookings') : 'No bookings in this period' },
      { label: 'Top airline', value: r.airlines[0]?.name ?? null, kind: 'text',
        hint: r.airlines[0] ? plural(r.airlines[0].bookings, 'booking', 'bookings') : undefined },
      { label: 'Booked ahead, on average', value: t.lead_avg === null ? null : Math.round(t.lead_avg * 10) / 10, kind: 'days' },
      { label: 'Personal trips', value: t.personal, kind: 'count' },
      { label: 'Guest bookings', value: t.guest, kind: 'count' },
    ],
    chart: { title: 'How far ahead flights were booked', kind: 'series', valueKind: 'count',
      points: [t.d0, t.d3, t.d7, t.d14].map((value, i) => ({ label: LEAD_LABELS[i], value })) },
    tables: [
      ranked('routes', 'Top routes', 'Route', r.routes),
      ranked('airlines', 'Top airlines', 'Airline', r.airlines),
      ranked('travellers', 'Top travellers', 'Traveller', r.travellers),
    ],
  }
}
