import { describe, it, expect, beforeAll } from 'vitest'
import { GET as dashboardGet } from '@/app/api/dashboard/route'
import { call } from '../harness/call'
import { actors, type Actors } from '../harness/actors'
import { resetDatabase } from '../harness/db'
import { db } from '@/app/lib/db'
import { sql, one, exec } from '@/app/lib/db/sql'

// ── The corporate dashboard's figures ────────────────────────────────────────
// Every tile is counted from bookings and approvals: bookings added now move
// this month's figures by exactly what they are, a traveller sees only their
// own, and the TMC side has no such dashboard.
// ─────────────────────────────────────────────────────────────────────────────

const HAS_DB = Boolean(process.env.DATABASE_URL)
const d = HAS_DB ? describe : describe.skip

interface Figures {
  mine: { bookedThisYear: number; spendThisYear: number; awaitingApproval: number; next: { origin: string; departure: string } | null }
  approver: { decided30d: number; medianHours: number | null } | null
  company: {
    thisMonth: { bookings: number; spend: number }
    outcomes: { within: number; needsApproval: number; outOfPolicy: number; notEvaluated: number }
    outOfPolicySpend: number
    topDepartment: { name: string; spend: number } | null
    months: { month: string; bookings: number; spend: number }[]
  } | null
}

d('dashboard', () => {
  let a: Actors
  let clientId: string
  let traveller: { id: string }

  // A copy of one of the company's bookings for the traveller, booked now.
  const addBooking = (o: { status: string; verdict: string; sell: number; departure: string }) => exec(db, sql`
    insert into bookings
    select (jsonb_populate_record(null::bookings, to_jsonb(b) || jsonb_build_object(
      'id', gen_random_uuid(), 'trip_id', null, 'employee_id', ${traveller.id}::uuid, 'booked_by', ${traveller.id}::uuid,
      'status', ${o.status}::text, 'policy_status', 'evaluated', 'policy_verdict', ${o.verdict}::text,
      'sell_total', ${o.sell}::numeric, 'created_at', now(), 'share_token', null, 'pnr', null, 'provider_order_id', null,
      'itinerary', jsonb_build_object('origin', jsonb_build_object('code', 'DEL', 'dateTime', ${o.departure}::text),
                                      'destination', jsonb_build_object('code', 'BOM'))))).*
    from (select * from bookings where client_id = ${clientId} order by created_at, id limit 1) b`)

  const figures = async (as: { id: string }) => (await call(dashboardGet, { as, url: '/api/dashboard' })).json as Figures

  beforeAll(async () => {
    await resetDatabase()
    a = await actors()
    clientId = a.corpAdmin.client_id!
    traveller = await one<{ id: string }>(db, sql`
      select id from employees where client_id = ${clientId} and role = 'employee' and status = 'active'
        and not exists (select 1 from employees r where r.manager_id = employees.id)
      order by id limit 1`)
  })

  it('the company: this month moves by exactly the bookings made now; sell side only', async () => {
    const before = (await figures(a.corpAdmin)).company!
    await addBooking({ status: 'ticketed', verdict: 'green', sell: 5000, departure: '2099-01-10T08:00:00' })
    await addBooking({ status: 'held', verdict: 'red', sell: 12000, departure: '2099-02-10T08:00:00' })
    // Not booked with the airline: never counted.
    await addBooking({ status: 'pending_approval', verdict: 'amber', sell: 7000, departure: '2099-03-10T08:00:00' })
    await addBooking({ status: 'cancelled', verdict: 'green', sell: 9000, departure: '2099-04-10T08:00:00' })

    const after = (await figures(a.corpAdmin)).company!
    expect(after.thisMonth.bookings - before.thisMonth.bookings).toBe(2)
    expect(after.thisMonth.spend - before.thisMonth.spend).toBe(17000)
    expect(after.outcomes.within - before.outcomes.within).toBe(1)
    expect(after.outcomes.outOfPolicy - before.outcomes.outOfPolicy).toBe(1)
    expect(after.outcomes.needsApproval - before.outcomes.needsApproval).toBe(0)
    expect(after.outOfPolicySpend - before.outOfPolicySpend).toBe(12000)
    expect(after.months).toHaveLength(6)
    expect(after.months[5].spend - before.months[5].spend).toBe(17000)
    expect(after.topDepartment).not.toBeNull()
    // Nothing of the airline's side reaches it.
    expect(JSON.stringify(after)).not.toMatch(/total_cost|airline|margin|markup/i)
  })

  it('a traveller sees their own travel, not the company', async () => {
    const mine = await figures(traveller)
    expect(mine.company).toBeNull()
    expect(mine.approver).toBeNull()
    expect(mine.mine).toMatchObject({ bookedThisYear: expect.any(Number), awaitingApproval: 1 })
    expect(mine.mine.bookedThisYear).toBeGreaterThanOrEqual(2)
    expect(mine.mine.spendThisYear).toBeGreaterThanOrEqual(17000)
    // The next flight is the earliest booked one still ahead.
    expect(mine.mine.next).toMatchObject({ origin: 'DEL', departure: '2099-01-10T08:00:00' })
  })

  it('an approver sees what they decided', async () => {
    const work = (await figures(a.corpAdmin)).approver
    expect(work).toMatchObject({ decided30d: expect.any(Number) })
  })

  it('the TMC side has no corporate dashboard', async () => {
    expect((await call(dashboardGet, { as: a.tmcAdmin, url: '/api/dashboard' })).status).toBe(403)
  })
})
