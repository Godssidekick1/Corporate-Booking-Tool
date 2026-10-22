import { describe, it, expect, beforeAll } from 'vitest'
import { GET as corporateIndex } from '@/app/api/reports/route'
import { GET as corporateReport } from '@/app/api/reports/[report]/route'
import { GET as tmcIndex } from '@/app/api/tmc/reports/route'
import { GET as tmcReport } from '@/app/api/tmc/reports/[report]/route'
import { call } from '../harness/call'
import { actors, type Actors, type Actor } from '../harness/actors'
import { resetDatabase } from '../harness/db'
import { db } from '@/app/lib/db'
import { sql, one, exec } from '@/app/lib/db/sql'
import { CORPORATE_REPORTS, TMC_REPORTS } from '@/app/lib/reports/registry'
import type { Report } from '@/app/lib/reports/types'

// ── Reports ──────────────────────────────────────────────────────────────────
// Every report is counted from the bookings that exist: a booking added in
// the range moves exactly the figures it should, one outside the range or
// not booked with the airline moves none, a filter narrows, and the CSV is
// the table on screen. Company reports never carry the airline's side; a
// counsellor sees their portfolio only; other tenants see nothing.
// ─────────────────────────────────────────────────────────────────────────────

const HAS_DB = Boolean(process.env.DATABASE_URL)
const d = HAS_DB ? describe : describe.skip

// The template's bookings were made in August and September 2026.
const RANGE = 'from=2026-08-01&to=2026-09-30'
// An empty month, for bookings these tests add.
const LATER = 'from=2030-03-01&to=2030-03-31'

interface Body { report: Report }

d('reports', () => {
  let a: Actors
  let clientId: string
  let traveller: { id: string; department: string | null }

  const company = async (key: string, query = RANGE, as: Actor = a.corpAdmin) =>
    call(corporateReport, { as, url: `/api/reports/${key}?${query}`, params: { report: key } })
  const tmc = async (key: string, query = RANGE, as: Actor = a.tmcAdmin) =>
    call(tmcReport, { as, url: `/api/tmc/reports/${key}?${query}`, params: { report: key } })
  const tile = (r: Report, label: string) => r.headline.find(t => t.label === label)?.value

  // A copy of one of the company's bookings for the traveller, booked on the
  // given day (India), with what the test sets.
  const addBooking = (o: {
    at: string; status?: string; verdict?: string; sell: number; employee?: string; bookedBy?: string
    detail?: unknown; fop?: unknown; commercials?: unknown
  }) => exec(db, sql`
    insert into bookings
    select (jsonb_populate_record(null::bookings, to_jsonb(b) || jsonb_build_object(
      'id', gen_random_uuid(), 'trip_id', null,
      'employee_id', ${o.employee ?? traveller.id}::uuid, 'booked_by', ${o.bookedBy ?? o.employee ?? traveller.id}::uuid,
      'status', ${o.status ?? 'ticketed'}::text, 'policy_status', 'evaluated', 'policy_verdict', ${o.verdict ?? 'green'}::text,
      'policy_verdict_detail', ${JSON.stringify(o.detail ?? { breaches: [] })}::jsonb,
      'resolved_fop', ${o.fop === undefined ? null : JSON.stringify(o.fop)}::jsonb,
      'commercials', ${o.commercials === undefined ? null : JSON.stringify(o.commercials)}::jsonb,
      'sell_total', ${o.sell}::numeric, 'total_cost', ${o.sell}::numeric,
      'created_at', (${o.at}::date::timestamp + interval '12 hours') at time zone 'Asia/Kolkata',
      'share_token', null, 'pnr', null, 'provider_order_id', null, 'policy_reason_code', null,
      'itinerary', jsonb_build_object('origin', jsonb_build_object('code', 'DEL', 'dateTime', '2030-03-20T08:00:00'),
                                      'destination', jsonb_build_object('code', 'BOM'),
                                      'airline', jsonb_build_object('code', 'AI', 'name', 'Air India'))))).*
    from (select * from bookings where client_id = ${clientId} order by created_at, id limit 1) b`)

  beforeAll(async () => {
    await resetDatabase()
    a = await actors()
    clientId = a.corpAdmin.client_id!
    traveller = await one(db, sql`
      select id, department from employees where client_id = ${clientId} and role = 'employee' and status = 'active'
      order by id limit 1`)
  })

  it('every company report answers on the template’s bookings, as recorded', async () => {
    const index = await call(corporateIndex, { as: a.corpAdmin, url: '/api/reports' })
    expect(index.status).toBe(200)
    expect((index.json as { options: { departments: unknown[] } }).options.departments.length).toBeGreaterThan(0)
    for (const { key } of CORPORATE_REPORTS) {
      const res = await company(key)
      expect(res.status, key).toBe(200)
      expect((res.json as Body).report).toMatchSnapshot(key)
    }
  })

  it('every TMC report answers on the template’s bookings, as recorded', async () => {
    const index = await call(tmcIndex, { as: a.tmcAdmin, url: '/api/tmc/reports' })
    expect(index.status).toBe(200)
    for (const { key } of TMC_REPORTS) {
      const res = await tmc(key)
      expect(res.status, key).toBe(200)
      expect((res.json as Body).report).toMatchSnapshot(key)
    }
  })

  it('spend moves by exactly the bookings booked in the range; others never count', async () => {
    const before = (await company('spend', LATER)).json as Body
    expect(tile(before.report, 'Bookings')).toBe(0)
    await addBooking({ at: '2030-03-05', sell: 5000 })
    await addBooking({ at: '2030-03-31', sell: 7000, status: 'held' })
    // Outside the range, or not booked with the airline: left out.
    await addBooking({ at: '2030-04-01', sell: 9000 })
    await addBooking({ at: '2030-03-10', sell: 9000, status: 'cancelled' })
    await addBooking({ at: '2030-03-10', sell: 9000, status: 'pending_approval' })

    const after = ((await company('spend', LATER)).json as Body).report
    expect(tile(after, 'Bookings')).toBe(2)
    expect(tile(after, 'Total spend')).toBe(12000)
    expect(tile(after, 'Average fare')).toBe(6000)
    expect(tile(after, 'Domestic')).toBe(100) // DEL – BOM
    expect(after.chart?.points).toEqual([{ label: 'Mar ’30', value: 12000 }])
    const dept = traveller.department || 'No department'
    expect(after.tables[0].rows).toEqual([{ name: dept, bookings: 2, spend: 12000, average: 6000, share: 100 }])

    // A department filter narrows to its people.
    const other = ((await company('spend', `${LATER}&department=${encodeURIComponent('Nobody here')}`)).json as Body).report
    expect(tile(other, 'Bookings')).toBe(0)
    const mine = ((await company('spend', `${LATER}&department=${encodeURIComponent(dept)}`)).json as Body).report
    expect(tile(mine, 'Bookings')).toBe(2)
  })

  it('the CSV is the table on screen, values unformatted', async () => {
    const shown = ((await company('spend', LATER)).json as Body).report.tables[1]
    const res = await company('spend', `${LATER}&format=csv&table=${shown.key}`)
    expect(res.status).toBe(200)
    const lines = String(res.json).replace(/^﻿/, '').split('\r\n')
    expect(lines[0]).toBe(shown.columns.map(c => c.label).join(','))
    expect(lines.slice(1)).toEqual(shown.rows.map(r => shown.columns.map(c => r[c.key] ?? '').join(',')))
    expect((await company('spend', `${LATER}&format=csv&table=nope`)).status).toBe(404)
  })

  it('compliance and savings count what the policy recorded at booking', async () => {
    await addBooking({ at: '2030-03-12', sell: 11000, verdict: 'amber', detail: { breaches: [
      { limit_key: 'lowest_fare_window_minutes', kind: 'numeric', severity: 'amber', policyValue: 60, actualValue: 11000,
        alternative: { total: 9500, departure: '2030-03-20T08:40:00', label: '6E 201' } },
    ] } })
    await addBooking({ at: '2030-03-13', sell: 8600, verdict: 'amber', detail: { breaches: [
      { limit_key: 'max_fare_domestic', kind: 'numeric', severity: 'amber', policyValue: 8000, actualValue: 8600, graceLimit: 8800 },
    ] } })
    await addBooking({ at: '2030-03-14', sell: 20000, verdict: 'red', detail: { breaches: [
      { limit_key: 'max_fare_domestic', kind: 'numeric', severity: 'red', policyValue: 8000, actualValue: 20000 },
    ] } })

    const savings = ((await company('savings', LATER)).json as Body).report
    expect(tile(savings, 'Lowest-fare misses')).toBe(1)
    expect(tile(savings, 'Extra paid on them')).toBe(1500)
    expect(tile(savings, 'Fares within grace')).toBe(1)
    expect(tile(savings, 'Paid above the caps')).toBe(600)
    expect(savings.tables[0].rows[0]).toMatchObject({ route: 'DEL – BOM', cheaperFlight: '6E 201 at 08:40', difference: 1500 })

    const compliance = ((await company('compliance', LATER)).json as Body).report
    // 2 green from the spend test, 2 amber, 1 red.
    expect(tile(compliance, 'Within policy')).toBe(40)
    expect(tile(compliance, 'Needs approval')).toBe(40)
    expect(tile(compliance, 'Out of policy')).toBe(20)
    expect(tile(compliance, 'Out-of-policy spend')).toBe(20000)
    expect(compliance.tables[0].rows).toContainEqual({ rule: 'Domestic fare limit', times: 2, red: 1, spend: 28600 })
  })

  it('a company report never carries the airline’s side', async () => {
    await addBooking({ at: '2030-03-15', sell: 10000, commercials: {
      airline: { total: 9000 }, adjustments: [{ source: 'markup', amount: 1000 }], sellTotal: 10000, tmcMargin: 1000,
    } })
    for (const { key } of CORPORATE_REPORTS) {
      const text = JSON.stringify(((await company(key, LATER)).json as Body).report)
      expect(text, key).not.toMatch(/markup|margin|airline cost|9000/i)
    }
    // The TMC's revenue does read it.
    const revenue = ((await tmc('revenue', `${LATER}&clientId=${clientId}`)).json as Body).report
    expect(tile(revenue, 'Margin')).toBe(1000)
    expect(revenue.tables[0].rows[0]).toMatchObject({ markup: 1000, airline: expect.any(Number) })
  })

  it('the desk report counts what TMC staff booked; payments by who paid', async () => {
    await addBooking({ at: '2030-03-16', sell: 4000, bookedBy: a.tmcAdmin.id, fop: { payer: 'agency' } })
    const desk = ((await tmc('desk', `${LATER}&clientId=${clientId}`)).json as Body).report
    expect(tile(desk, 'Desk bookings')).toBe(1)
    expect(desk.tables[0].rows[0]).toMatchObject({ bookings: 1, clients: 1, spend: 4000 })

    const payments = ((await tmc('payments', `${LATER}&clientId=${clientId}`)).json as Body).report
    expect(tile(payments, 'Paid by the agency')).toBe(1)
    expect(tile(payments, 'Agency-paid exposure')).toBe(4000)
  })

  it('only a company’s admins and finance read its reports', async () => {
    if (a.employee) {
      expect((await company('spend', RANGE, a.employee)).status).toBe(403)
      expect((await call(corporateIndex, { as: a.employee, url: '/api/reports' })).status).toBe(403)
    }
    expect((await company('spend', RANGE, a.tmcAdmin)).status).toBe(403)
    expect((await call(corporateReport, { as: null, url: `/api/reports/spend?${RANGE}`, params: { report: 'spend' } })).status).toBe(401)
    // Company staff cannot reach the TMC's.
    expect((await tmc('revenue', RANGE, a.corpAdmin)).status).toBe(403)
  })

  it('a counsellor sees their portfolio only; another TMC sees none of these clients', async () => {
    if (a.tc) {
      const portfolio = await one<{ ids: string[] }>(db, sql`
        select coalesce(array_agg(client_id), '{}') as ids from employee_client_access where employee_id = ${a.tc.id}`)
      await exec(db, sql`
        insert into employee_permissions (employee_id, permission_key) values (${a.tc.id}, 'view_reports')
        on conflict do nothing`)
      const outside = await one<{ id: string } | null>(db, sql`
        select (select id from clients where tmc_id = ${a.tc.tmc_id} and not (id = any(${portfolio.ids})) order by id limit 1) as id`)
      if (outside?.id) expect((await tmc('revenue', `${LATER}&clientId=${outside.id}`, a.tc)).status).toBe(403)
      if (!portfolio.ids.includes(clientId)) {
        const theirs = ((await tmc('revenue', LATER, a.tc)).json as Body).report
        expect(theirs.tables[0].rows.map(r => r.name)).not.toContain(
          (await one<{ name: string }>(db, sql`select name from clients where id = ${clientId}`)).name)
      }
    }
    if (a.otherTmcAdmin) {
      const theirs = ((await tmc('revenue', `${LATER}&clientId=${clientId}`, a.otherTmcAdmin)).json as Body).report
      expect(tile(theirs, 'Sell')).toBe(0)
    }
  })

  it('refuses dates and reports that do not exist', async () => {
    expect((await company('spend', 'from=2030-03-10&to=2030-03-01')).status).toBe(400)
    expect((await company('spend', 'from=2030-02-30&to=2030-03-01')).status).toBe(400)
    expect((await company('spend', 'from=2020-01-01&to=2030-03-01')).status).toBe(400)
    expect((await company('nope')).status).toBe(404)
    expect((await tmc('revenue', 'clientId=not-a-uuid')).status).toBe(400)
  })
})
