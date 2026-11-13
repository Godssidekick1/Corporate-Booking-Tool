import { describe, it, expect, beforeAll } from 'vitest'
import { GET as tmcReport } from '@/app/api/tmc/reports/[report]/route'
import { GET as bookingGet } from '@/app/api/tmc/bookings/[id]/route'
import { call } from '../harness/call'
import { actors, type Actors, type Actor } from '../harness/actors'
import { resetDatabase } from '../harness/db'
import { db } from '@/app/lib/db'
import { sql, one, exec } from '@/app/lib/db/sql'
import type { Report } from '@/app/lib/reports/types'

// ── The TMC's Bookings report, and the booking page it opens ─────────────────
// Each booking with its money (airline fare, markup, discount, fee, sell,
// margin), filtered by status, search and who booked it, as CSV too; each row
// opens /api/tmc/bookings/[id], which only the booking's own TMC can read, a
// counsellor only within their portfolio, and a company never.
// ─────────────────────────────────────────────────────────────────────────────

const HAS_DB = Boolean(process.env.DATABASE_URL)
const d = HAS_DB ? describe : describe.skip

const RANGE = 'from=2031-01-01&to=2031-01-31'

const COMMERCIALS = {
  airline: { total: 10000, base: 9000, otherTax: 1000, fuelSurcharge: 0, taxLines: [{ code: 'K3', amount: 500 }, { code: 'YR', amount: 500 }] },
  adjustments: [
    { source: 'discount', visibility: 'line', sign: -1, amount: 500, ruleId: null, via: 'Direct assignment', calcType: 'percent', calcOn: 'base', rate: 5 },
    { source: 'markup', visibility: 'embedded', sign: 1, amount: 800, ruleId: null, via: 'Bucket · Corporates', calcType: 'fixed', rate: 800 },
    { source: 'processing_fee', visibility: 'line', sign: 1, amount: 300, ruleId: null, via: 'Direct assignment', calcType: 'fixed', rate: 300, calcBasis: 'per_transaction', pax: 1 },
  ],
  displayedFare: 10800, sellTotal: 10600, tmcCost: 10000, tmcMargin: 600, ambiguous: false,
}

d('the TMC bookings report', () => {
  let a: Actors
  let clientId: string
  let traveller: { id: string }
  let deskBookingId: string
  let selfBookingId: string

  const report = (query: string, as: Actor = a.tmcAdmin) =>
    call(tmcReport, { as, url: `/api/tmc/reports/bookings?${RANGE}&${query}`, params: { report: 'bookings' } })
  const page = (id: string, as: Actor | { id: string } = a.tmcAdmin) =>
    call(bookingGet, { as, url: `/api/tmc/bookings/${id}`, params: { id } })

  // A copy of one of the client's bookings, made on 15 Jan 2031, as set here.
  async function addBooking(o: { status: string; pnr: string; bookedBy: string; commercials?: unknown }): Promise<string> {
    return (await one<{ id: string }>(db, sql`
      insert into bookings
      select (jsonb_populate_record(null::bookings, to_jsonb(b) || jsonb_build_object(
        'id', gen_random_uuid(), 'trip_id', null, 'pair_id', null, 'share_token', null,
        'employee_id', ${traveller.id}::uuid, 'booked_by', ${o.bookedBy}::uuid,
        'status', ${o.status}::text, 'pnr', ${o.pnr}::text, 'provider_order_id', ${`REF-${o.pnr}`}::text,
        'commercials', ${o.commercials === undefined ? null : JSON.stringify(o.commercials)}::jsonb,
        'sell_total', 10600::numeric, 'total_cost', 10000::numeric,
        'created_at', timestamptz '2031-01-15 12:00:00+05:30',
        'itinerary', jsonb_build_object('origin', jsonb_build_object('code', 'DEL', 'dateTime', '2031-02-01T08:00:00'),
                                        'destination', jsonb_build_object('code', 'BOM'),
                                        'airline', jsonb_build_object('code', 'AI', 'name', 'Air India'))))).*
      from (select * from bookings where client_id = ${clientId} order by created_at, id limit 1) b
      returning id`)).id
  }

  beforeAll(async () => {
    await resetDatabase()
    a = await actors()
    clientId = a.corpAdmin.client_id!
    traveller = await one(db, sql`
      select id from employees where client_id = ${clientId} and role = 'employee' and status = 'active' order by id limit 1`)
    deskBookingId = await addBooking({ status: 'ticketed', pnr: 'DESK01', bookedBy: a.tmcAdmin.id, commercials: COMMERCIALS })
    selfBookingId = await addBooking({ status: 'pending_approval', pnr: 'SELF01', bookedBy: traveller.id })
  })

  it('lists each booking with its money; each row opens the booking', async () => {
    const res = await report('')
    expect(res.status).toBe(200)
    const r = (res.json as { report: Report }).report
    const table = r.tables[0]
    expect(table.columns.map(c => c.label)).toEqual([
      'Booked', 'Traveller', 'Client', 'Route', 'Departs', 'PNR', 'Status', 'Booked by',
      'Airline fare', 'Markup', 'Discount', 'Fee', 'Sell', 'Margin',
    ])
    const desk = table.rows.find(row => row.pnr === 'DESK01')
    expect(desk).toMatchObject({
      _href: `/tmc/reports/bookings/${deskBookingId}`, status: 'Ticketed', route: 'DEL → BOM · AI', departs: '2031-02-01',
      airline: 10000, markup: 800, discount: 500, fee: 300, sell: 10600, margin: 600,
    })
    expect(String(desk?.bookedBy)).toMatch(/^Travel desk/)
    // Any status is listed; a booking without commercials shows no margin.
    expect(table.rows.find(row => row.pnr === 'SELF01')).toMatchObject({ status: 'Awaiting approval', bookedBy: 'Traveller', margin: null })
    // The tiles count what was booked with the airline.
    expect(r.headline.find(t => t.label === 'Booked with the airline')?.value).toBe(1)
    expect(r.headline.find(t => t.label === 'Margin')?.value).toBe(600)
  })

  it('filters by status, by search and by who booked it; refuses a bad filter', async () => {
    const pnrs = async (q: string) => ((await report(q)).json as { report: Report }).report.tables[0].rows.map(r => r.pnr)
    expect(await pnrs('status=ticketed')).toEqual(['DESK01'])
    expect(await pnrs('search=SELF01')).toEqual(['SELF01'])
    expect(await pnrs('bookedBy=desk')).toEqual(['DESK01'])
    expect(await pnrs('bookedBy=self')).toEqual(['SELF01'])
    expect((await report('status=lost')).status).toBe(400)
    expect((await report('bookedBy=robot')).status).toBe(400)
  })

  it('downloads as CSV: the columns on screen, not the row links', async () => {
    const res = await call(tmcReport, {
      as: a.tmcAdmin, url: `/api/tmc/reports/bookings?${RANGE}&format=csv`, params: { report: 'bookings' },
    })
    expect(res.status).toBe(200)
    const text = String(res.json ?? '')
    expect(text.split(/\r?\n/)[0]).toBe('Booked,Traveller,Client,Route,Departs,PNR,Status,Booked by,Airline fare,Markup,Discount,Fee,Sell,Margin')
    expect(text).toContain('DESK01')
    expect(text).not.toContain('/tmc/reports/bookings/')
  })

  it('the booking page: the money line by line, for its own TMC only', async () => {
    const res = await page(deskBookingId)
    expect(res.status).toBe(200)
    const b = (res.json as { booking: Record<string, unknown> }).booking
    expect(b).toMatchObject({
      id: deskBookingId, status: 'ticketed',
      references: { pnr: 'DESK01', providerReference: 'REF-DESK01' },
      bookedBy: { kind: 'desk' },
      money: {
        airline: { total: 10000, base: 9000 },
        desk: { airlineTotal: 10000, markup: 800, discount: 500, fee: 300, sellTotal: 10600, margin: 600 },
      },
    })
    const adjustments = (b.money as { adjustments: { label: string; via: string }[] }).adjustments
    expect(adjustments.map(x => [x.label, x.via])).toEqual([
      ['Discount', 'Direct assignment'], ['Markup', 'Bucket · Corporates'], ['Processing fee', 'Direct assignment'],
    ])

    // Another TMC: as if it did not exist. Nonsense ids likewise.
    if (a.otherTmcAdmin) expect((await page(deskBookingId, a.otherTmcAdmin)).status).toBe(404)
    expect((await page('00000000-0000-0000-0000-000000000000')).status).toBe(404)
    expect((await page('not-an-id')).status).toBe(404)
    // A company never reads it, its own booking included.
    expect((await page(deskBookingId, a.corpAdmin)).status).toBe(403)
    expect((await page(deskBookingId, { id: traveller.id })).status).toBe(403)
  })

  it('a counsellor: within their portfolio and holding view_reports, else refused', async () => {
    if (!a.tc) return
    const tc = a.tc
    await exec(db, sql`delete from employee_client_access where employee_id = ${tc.id}`)
    await exec(db, sql`insert into employee_permissions (employee_id, permission_key) values (${tc.id}, 'view_reports')
      on conflict do nothing`)
    // Outside the portfolio.
    expect((await page(deskBookingId, tc)).status).toBe(403)
    expect(((await report('', tc)).json as { report: Report }).report.tables[0].rows.map(r => r.pnr)).not.toContain('DESK01')
    // Inside it.
    await exec(db, sql`insert into employee_client_access (employee_id, client_id) values (${tc.id}, ${clientId})`)
    expect((await page(deskBookingId, tc)).status).toBe(200)
    // Without view_reports, refused even within it.
    await exec(db, sql`delete from employee_permissions where employee_id = ${tc.id} and permission_key = 'view_reports'`)
    expect((await page(deskBookingId, tc)).status).toBe(403)
    expect(selfBookingId).toBeTruthy()
  })
})
