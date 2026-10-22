import type { Queryable } from '@/app/lib/db'
import * as reports from '@/app/lib/repositories/reports'
import type { Scope } from '@/app/lib/repositories/reports'
import type { Report, ReportFilters } from './types'
import { pct, round2, series, stacked, num, col, plural } from './shape'
import { outcomeColumns, outcomeRow } from './corporate'

// ── The TMC's reports ────────────────────────────────────────────────────────
// Across the TMC's clients, or a counsellor's portfolio (the route decides
// the scope). Unlike the company's reports these read the commercials: the
// airline's figure, markup, discount, fee and margin.
// ─────────────────────────────────────────────────────────────────────────────

type TmcScope = Extract<Scope, { side: 'tmc' }>

const MODE_LABEL: Record<string, string> = { cbt: 'CBT', sbt: 'SBT', hybrid: 'Hybrid' }

export async function revenue(db: Queryable, scope: TmcScope, f: ReportFilters): Promise<Report> {
  const r = await reports.revenue(db, scope, f)
  const t = r.totals
  return {
    key: 'revenue', title: 'Revenue',
    description: 'What clients paid, what the airlines were owed, and the margin between: markup and fee, less discount.',
    headline: [
      { label: 'Sell', value: round2(t.sell), kind: 'money', hint: plural(t.bookings, 'booking', 'bookings') },
      { label: 'Airline cost', value: round2(t.airline), kind: 'money' },
      { label: 'Margin', value: round2(t.margin), kind: 'money',
        hint: t.without ? `${plural(t.without, 'booking has', 'bookings have')} no commercials recorded (margin 0)` : undefined },
      { label: 'Margin %', value: pct(t.margin, t.sell), kind: 'percent', hint: 'Of sell' },
    ],
    chart: { title: 'Margin by month', kind: 'series', valueKind: 'money', points: series(r.months, m => num(m.margin)) },
    tables: [{
      key: 'clients', title: 'By client',
      columns: [col('name', 'Client', 'text'), col('bookings', 'Bookings', 'count'), col('sell', 'Sell', 'money'),
        col('airline', 'Airline cost', 'money'), col('markup', 'Markup', 'money'), col('discount', 'Discount', 'money'),
        col('fee', 'Fee', 'money'), col('margin', 'Margin', 'money'), col('marginShare', 'Margin %', 'percent'),
        col('without', 'No commercials recorded', 'count')],
      rows: r.clients.map(c => ({
        name: c.name, bookings: c.bookings, sell: round2(c.sell), airline: round2(c.airline), markup: round2(c.markup),
        discount: round2(c.discount), fee: round2(c.fee), margin: round2(c.margin), marginShare: pct(c.margin, c.sell),
        without: c.without,
      })),
    }],
  }
}

export async function activity(db: Queryable, scope: TmcScope, f: ReportFilters): Promise<Report> {
  const r = await reports.clientActivity(db, scope, f)
  const active = r.rows.filter(c => c.bookings > 0).length
  return {
    key: 'activity', title: 'Client activity',
    description: 'Which clients booked in the period and which did not.',
    headline: [
      { label: 'Active clients', value: active, kind: 'count', hint: 'At least one booking' },
      { label: 'Dormant', value: r.rows.length - active, kind: 'count', hint: 'No bookings in the period' },
      { label: 'New in the period', value: r.joined, kind: 'count' },
    ],
    chart: { title: 'Bookings by month', kind: 'series', valueKind: 'count', points: series(r.months, m => num(m.bookings)) },
    tables: [{
      key: 'clients', title: 'Clients',
      columns: [col('name', 'Client', 'text'), col('group', 'Group', 'text'), col('mode', 'Booking mode', 'text'),
        col('status', 'Status', 'text'), col('bookings', 'Bookings', 'count'), col('travellers', 'Travellers', 'count'),
        col('spend', 'Spend', 'money'), col('lastBooking', 'Last booking', 'date'), col('joined', 'Joined', 'date')],
      rows: r.rows.map(c => ({
        name: c.name, group: c.group_name, mode: MODE_LABEL[c.booking_mode] ?? c.booking_mode,
        status: c.status === 'active' ? 'Active' : 'Inactive', bookings: c.bookings, travellers: c.travellers,
        spend: round2(c.spend), lastBooking: c.last_booking, joined: c.joined,
      })),
    }],
  }
}

export async function airlines(db: Queryable, scope: TmcScope, f: ReportFilters): Promise<Report> {
  const r = await reports.airlinesAndDeals(db, scope, f)
  const t = r.totals
  return {
    key: 'airlines', title: 'Airlines & deals',
    description: 'Which airlines carried the bookings, and how often a negotiated deal code applied.',
    headline: [
      { label: 'Airlines used', value: t.airlines, kind: 'count' },
      { label: 'Bookings on a deal code', value: t.on_deal, kind: 'count',
        hint: t.bookings ? `${pct(t.on_deal, t.bookings)}% of bookings` : undefined },
      { label: 'Top deal code', value: r.deals[0]?.code ?? null, kind: 'text',
        hint: r.deals[0] ? `${r.deals[0].airline ?? ''} · ${plural(r.deals[0].uses, 'booking', 'bookings')}`.replace(/^ · /, '') : 'None applied' },
    ],
    chart: { title: 'Bookings by airline', kind: 'list', valueKind: 'count',
      points: r.airlines.map(a => ({ label: a.code ? `${a.name} (${a.code})` : a.name, value: a.bookings })) },
    tables: [
      {
        key: 'airlines', title: 'By airline',
        columns: [col('code', 'Code', 'text'), col('name', 'Airline', 'text'), col('bookings', 'Bookings', 'count'),
          col('airline', 'Airline cost', 'money'), col('sell', 'Sell', 'money')],
        rows: r.airlines.map(a => ({ code: a.code, name: a.name, bookings: a.bookings, airline: round2(a.airline), sell: round2(a.sell) })),
      },
      {
        key: 'deal-codes', title: 'Deal codes applied',
        columns: [col('code', 'Deal code', 'text'), col('airline', 'Airline', 'text'), col('type', 'Type', 'text'),
          col('uses', 'Bookings', 'count'), col('clients', 'Clients', 'count')],
        rows: r.deals.map(d => ({ code: d.code, airline: d.airline, type: d.code_type, uses: d.uses, clients: d.clients })),
      },
    ],
  }
}

export async function desk(db: Queryable, scope: TmcScope, f: ReportFilters): Promise<Report> {
  const r = await reports.desk(db, scope, f)
  const t = r.totals
  return {
    key: 'desk', title: 'Desk productivity',
    description: 'Bookings the travel desk made for travellers, and who made them.',
    headline: [
      { label: 'Desk bookings', value: t.desk, kind: 'count' },
      { label: 'Share of all bookings', value: pct(t.desk, t.bookings), kind: 'percent', hint: plural(t.bookings, 'booking', 'bookings') + ' in all' },
      { label: 'By client booking mode', value: `CBT ${t.cbt} · SBT ${t.sbt} · Hybrid ${t.hybrid}`, kind: 'text' },
    ],
    chart: { title: 'Desk bookings by month', kind: 'series', valueKind: 'count', points: series(r.months, m => num(m.desk)) },
    tables: [{
      key: 'counsellors', title: 'By person',
      columns: [col('name', 'Name', 'text'), col('role', 'Role', 'text'), col('bookings', 'Bookings', 'count'),
        col('clients', 'Clients served', 'count'), col('spend', 'Booked value', 'money')],
      rows: r.people.map(p => ({ name: p.name, role: p.role === 'tmc_admin' ? 'TMC admin' : 'Travel counsellor',
        bookings: p.bookings, clients: p.clients, spend: round2(p.spend) })),
    }],
  }
}

export async function compliance(db: Queryable, scope: TmcScope, f: ReportFilters): Promise<Report> {
  const r = await reports.complianceByClient(db, scope, f)
  const t = r.totals
  const checked = t.within + t.needs + t.out
  const rows = r.clients.map(outcomeRow)
  const worst = rows.filter(c => c.outShare !== null)
    .sort((a, b) => (b.outShare as number) - (a.outShare as number) || b.out - a.out)[0]
  return {
    key: 'compliance', title: 'Compliance across clients',
    description: 'How each client’s bookings measured up to its travel policy.',
    headline: [
      { label: 'Within policy', value: pct(t.within, checked), kind: 'percent' },
      { label: 'Needs approval', value: pct(t.needs, checked), kind: 'percent' },
      { label: 'Out of policy', value: pct(t.out, checked), kind: 'percent', hint: plural(t.out, 'booking', 'bookings') },
      { label: 'Highest out-of-policy rate', value: worst?.name ?? null, kind: 'text',
        hint: worst ? `${worst.outShare}% of its bookings` : 'Nothing checked in this period' },
    ],
    chart: { title: 'Out of policy, by client', kind: 'list', valueKind: 'percent',
      points: rows.filter(c => c.outShare !== null).map(c => ({ label: c.name, value: c.outShare as number }))
        .sort((a, b) => b.value - a.value) },
    tables: [{ key: 'clients', title: 'By client', columns: outcomeColumns('Client'), rows }],
  }
}

const PAYERS = ['corporate', 'agency', 'traveller', 'not_recorded'] as const
const PAYER_LABEL: Record<string, string> = {
  corporate: 'Company', agency: 'Agency (TMC)', traveller: 'Traveller', not_recorded: 'Not recorded',
}

export async function payments(db: Queryable, scope: TmcScope, f: ReportFilters): Promise<Report> {
  const r = await reports.payments(db, scope, f)
  const by = (p: string) => r.totals.find(x => x.payer === p) ?? { bookings: 0, amount: 0 }
  const months = new Map<string, Record<string, number>>()
  for (const m of r.months) {
    const row = months.get(m.month) ?? {}
    if (m.payer) row[m.payer] = num(m.bookings)
    months.set(m.month, row)
  }
  const headline: Report['headline'] = [
    { label: 'Paid by the company', value: by('corporate').bookings, kind: 'count', hint: money(by('corporate').amount) },
    { label: 'Paid by the agency', value: by('agency').bookings, kind: 'count', hint: money(by('agency').amount) },
    { label: 'Paid by the traveller', value: by('traveller').bookings, kind: 'count', hint: money(by('traveller').amount) },
    { label: 'Agency-paid exposure', value: round2(by('agency').amount), kind: 'money', hint: 'What the TMC paid and bills on' },
  ]
  if (by('not_recorded').bookings) {
    headline.push({ label: 'Payer not recorded', value: by('not_recorded').bookings, kind: 'count', hint: 'Booked before payments were stamped' })
  }
  return {
    key: 'payments', title: 'Payments',
    description: 'Who paid for the bookings: the company, the agency on credit, or the traveller.',
    headline,
    chart: {
      title: 'Bookings by payer, by month', kind: 'series', valueKind: 'count', legend: PAYERS.map(p => PAYER_LABEL[p]),
      points: stacked([...months.keys()].map(month => ({ month })), PAYERS.map(p => (m: Record<string, unknown>) =>
        num(months.get(m.month as string)?.[p]))),
    },
    tables: [{
      key: 'clients', title: 'By client and payer',
      columns: [col('name', 'Client', 'text'), col('payer', 'Payer', 'text'), col('bookings', 'Bookings', 'count'),
        col('amount', 'Amount', 'money')],
      rows: r.clients.map(c => ({ name: c.name, payer: PAYER_LABEL[c.payer] ?? c.payer, bookings: c.bookings, amount: round2(c.amount) })),
    }],
  }
}

function money(n: number): string {
  return `₹${Math.round(n).toLocaleString('en-IN')}`
}
