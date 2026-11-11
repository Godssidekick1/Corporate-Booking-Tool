import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import { POST as pricePost } from '@/app/api/book/price/route'
import { POST as addPassengerPost } from '@/app/api/book/add-passenger/route'
import { POST as chainPost } from '@/app/api/tmc/approval-chains/direct/route'
import { PATCH as decide } from '@/app/api/approvals/[approvalId]/route'
import { GET as bookingGet } from '@/app/api/book/[bookingId]/route'
import { call } from '../harness/call'
import { actors, type Actors } from '../harness/actors'
import { resetDatabase } from '../harness/db'
import { db } from '@/app/lib/db'
import { sql, one, many, exec } from '@/app/lib/db/sql'

// ── A domestic round trip booked as two linked bookings ──────────────────────
// The onward is added first and waits (nothing sent for approval); the return
// names it, the two are linked, and ONE approval is raised for the pair on the
// onward, judged by the worse verdict. A decision applies to both. Amadeus is
// faked; each add-passenger's verdict is set by the test.
// ─────────────────────────────────────────────────────────────────────────────

const fake = { pricing: vi.fn(), addPassenger: vi.fn() }

vi.mock('@/app/lib/amadeus/client', async orig => {
  const actual = await orig<typeof import('@/app/lib/amadeus/client')>()
  return {
    ...actual,
    amadeus: {
      ...actual.amadeus,
      pricing: (...a: unknown[]) => fake.pricing(...a),
      addPassenger: (...a: unknown[]) => fake.addPassenger(...a),
    },
  }
})

// The verdict each policy check returns, in call order.
let verdicts: ('green' | 'amber' | 'red')[] = []
vi.mock('@/app/lib/rule-engine/checkBookingAgainstPolicy', async orig => {
  const actual = await orig<typeof import('@/app/lib/rule-engine/checkBookingAgainstPolicy')>()
  return {
    ...actual,
    checkBookingAgainstPolicy: () => {
      const verdict = verdicts.shift() ?? 'green'
      return Promise.resolve({
        ok: true, policyGroupName: 'P', bandCode: 'L1', verdict,
        breaches: verdict === 'green' ? [] : [{ limit_key: 'max_fare_domestic', kind: 'numeric', policyValue: 5000, actualValue: 9000, severity: verdict }],
      })
    },
  }
})

const HAS_DB = Boolean(process.env.DATABASE_URL)
const d = HAS_DB ? describe : describe.skip

function pricing(ref: string) {
  return {
    Key: `KEY-${ref}`, ReferenceNo: ref,
    AirPricingResponse: [{ PricingInfos: { PricingInfo: [{
      Total: { Fare: '6000', BaseFare: '5200', OtherTax: '800', FuelSurcharge: '0' },
      Currency: 'INR', FareType: 'NRM', Meal: 'NO',
      FareBreakDowns: { FareBreakDown: [{ PaxType: 'ADT', BaseFare: '5200', TotalTax: '800', TotalFare: '6000', Refundable: 'Refundable' }] },
      FareInfos: { FareInfo: [{ PaxFareBasis: 'Y1' }] },
      Penalties: { ChangePenalty: [], CancelPenalty: [] },
    }] } }],
  }
}

function leg(from: string, to: string, at: string, no: string) {
  const origin = { code: from, name: from, city: from, dateTime: `${at}T08:00:00` }
  const destination = { code: to, name: to, city: to, dateTime: `${at}T10:10:00` }
  const l = { airlineCode: 'AI', flightNumber: no, bookingCode: 'Y', cabin: 'Economy' }
  return {
    flightKey: `${from}-${no}`, provider: 'test', isLcc: false, itemNo: '1', cabin: 'Economy', legs: [l],
    journeys: [{ journeyNo: 1, stops: [], stopCount: 0, legs: [l], origin, destination }],
    origin, destination, airline: { code: 'AI', name: 'Air India' }, stopCount: 0, stops: [], fareOptions: [],
  }
}

d('round trip pairs', () => {
  let a: Actors
  let clientId: string
  let colleague: { id: string }
  let approverId: string
  let day = 0

  const setChain = (minVerdict: string) => call(chainPost, {
    as: a.tmcAdmin, method: 'POST', url: '/api/tmc/approval-chains/direct',
    body: { clientId, employeeId: colleague.id, category: 'air', mode: 'sequential', quorum: 'all',
      approvers: [{ approver_type: 'specific_user', approver_user_id: approverId, min_verdict: minVerdict }] },
  })

  async function add(ref: string, itinerary: ReturnType<typeof leg>, pair?: unknown, as: { id: string } = a.corpAdmin) {
    fake.pricing.mockResolvedValueOnce(pricing(ref))
    expect((await call(pricePost, {
      as, method: 'POST', url: '/api/book/price',
      body: { key: 'SEARCH-KEY', pricingKey: 'PK', provider: 'test', resultIndex: '1', itinerary, travellerId: colleague.id },
    })).status).toBe(200)
    fake.addPassenger.mockResolvedValueOnce({ ReferenceNo: ref })
    return call(addPassengerPost, {
      as, method: 'POST', url: '/api/book/add-passenger',
      body: {
        key: `KEY-${ref}`, pricingKey: 'PK', provider: 'test', resultIndex: '1', referenceNo: ref, totalFare: 6000,
        currency: 'INR', isRefundable: true, fareType: 'NRM', passengerBreakup: [], searchKey: 'SK',
        itinerary, travellerId: colleague.id, pair,
        customerInfo: { Email: 'c@example.test', Mobile: '9999999999', PassengerDetails: [{ FirstName: 'Ravi', LastName: 'Kumar' }] },
      },
    })
  }

  // A fresh pair of days for each test, so the duplicate check sees nothing.
  function legs() {
    day += 2
    const date = (n: number) => `2030-12-${String(n).padStart(2, '0')}`
    return { onward: leg('DEL', 'BOM', date(day), '2993'), back: leg('BOM', 'DEL', date(day + 1), '2994') }
  }

  const row = (id: string) => one<{ status: string; pair_id: string | null }>(db, sql`select status, pair_id from bookings where id = ${id}`)
  const approvalsOf = (id: string) => many<{ id: string; status: string; verdict: string; reason: string }>(db, sql`
    select id, status, verdict, reason from approvals where booking_id = ${id} order by created_at`)

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-11T06:00:00Z'))
    await resetDatabase()
    a = await actors()
    clientId = a.corpAdmin.client_id!
    colleague = await one(db, sql`
      select id from employees where client_id = ${clientId} and id <> ${a.corpAdmin.id}
        and role = 'employee' and status = 'active' order by id limit 1`)
    approverId = (await one<{ id: string }>(db, sql`
      select id from employees where client_id = ${clientId} and id not in (${a.corpAdmin.id}, ${colleague.id})
        and role = 'employee' and status = 'active' order by id limit 1`)).id
  })
  afterAll(() => { vi.useRealTimers() })
  beforeEach(() => { fake.pricing.mockReset(); fake.addPassenger.mockReset(); verdicts = [] })

  it('the onward waits; the return links to it; one approval for both; approving approves both', async () => {
    expect((await setChain('green')).status).toBe(200)
    const { onward, back } = legs()

    const first = await add('REF-ON-1', onward, { role: 'first' })
    expect(first.status).toBe(200)
    const firstId = (first.json as { bookingId: string }).bookingId
    expect(first.json).toMatchObject({ status: 'pending_approval', awaitingPair: true })
    expect(await row(firstId)).toEqual({ status: 'pending_approval', pair_id: firstId })
    expect(await approvalsOf(firstId)).toEqual([])

    const second = await add('REF-RET-1', back, { role: 'second', withBookingId: firstId })
    expect(second.status).toBe(200)
    const secondId = (second.json as { bookingId: string }).bookingId
    expect(second.json).toMatchObject({ status: 'pending_approval', pairedWith: firstId })
    expect(await row(secondId)).toEqual({ status: 'pending_approval', pair_id: firstId })

    // One approval, on the onward; the return has none of its own.
    const raised = await approvalsOf(firstId)
    expect(raised).toHaveLength(1)
    expect(raised[0].reason).toMatch(/^Onward flight: .*\. Return flight: /)
    expect(await approvalsOf(secondId)).toEqual([])

    // The booking page shows the pair, onward first.
    const page = await call(bookingGet, { as: a.corpAdmin, url: `/api/book/${secondId}`, params: { bookingId: secondId } })
    expect((page.json as { booking: { pair: { id: string; direction: string }[]; awaitingReturn: boolean } }).booking)
      .toMatchObject({ awaitingReturn: false, pair: [{ id: firstId, direction: 'onward' }, { id: secondId, direction: 'return' }] })

    const decided = await call(decide, { as: { id: approverId }, method: 'PATCH', url: `/api/approvals/${raised[0].id}`,
      params: { approvalId: raised[0].id }, body: { decision: 'approve' } })
    expect(decided.status).toBe(200)
    expect((await row(firstId)).status).toBe('approved')
    expect((await row(secondId)).status).toBe('approved')
  })

  it('rejecting the pair rejects both', async () => {
    const { onward, back } = legs()
    const firstId = ((await add('REF-ON-2', onward, { role: 'first' })).json as { bookingId: string }).bookingId
    const secondId = ((await add('REF-RET-2', back, { role: 'second', withBookingId: firstId })).json as { bookingId: string }).bookingId
    const [raised] = await approvalsOf(firstId)
    expect((await call(decide, { as: { id: approverId }, method: 'PATCH', url: `/api/approvals/${raised.id}`,
      params: { approvalId: raised.id }, body: { decision: 'reject', note: 'Too dear' } })).status).toBe(200)
    expect((await row(firstId)).status).toBe('rejected')
    expect((await row(secondId)).status).toBe('rejected')
  })

  it('the worse verdict decides: an out-of-policy onward sends a within-policy return for approval', async () => {
    // Only out-of-policy bookings go to this approver.
    expect((await setChain('red')).status).toBe(200)
    const { onward, back } = legs()
    verdicts = ['red', 'green']
    const firstId = ((await add('REF-ON-3', onward, { role: 'first' })).json as { bookingId: string }).bookingId
    const second = await add('REF-RET-3', back, { role: 'second', withBookingId: firstId })
    expect(second.json).toMatchObject({ status: 'pending_approval', policyVerdict: 'green' })
    expect(await approvalsOf(firstId)).toEqual([expect.objectContaining({ verdict: 'red', status: 'pending' })])

    // Both within policy, at a company that approves those automatically:
    // neither goes to an out-of-policy-only approver.
    await exec(db, sql`update clients set within_policy_approval = 'auto' where id = ${clientId}`)
    const next = legs()
    verdicts = ['green', 'green']
    const id = ((await add('REF-ON-4', next.onward, { role: 'first' })).json as { bookingId: string }).bookingId
    const both = await add('REF-RET-4', next.back, { role: 'second', withBookingId: id })
    expect(both.json).toMatchObject({ status: 'approved' })
    expect((await row(id)).status).toBe('approved')
  })

  it('a return is refused when its onward cannot be paired', async () => {
    expect((await setChain('green')).status).toBe(200)
    const { onward, back } = legs()
    const firstId = ((await add('REF-ON-5', onward, { role: 'first' })).json as { bookingId: string }).bookingId
    expect((await add('REF-RET-5', back, { role: 'second', withBookingId: firstId })).status).toBe(200)

    // Already has its return.
    const again = await add('REF-RET-6', legs().back, { role: 'second', withBookingId: firstId })
    expect(again).toMatchObject({ status: 409, json: { code: 'PAIR_NOT_OPEN' } })
    // Not an onward at all, or nothing there.
    const single = ((await add('REF-SINGLE', legs().onward)).json as { bookingId: string }).bookingId
    expect((await add('REF-RET-7', legs().back, { role: 'second', withBookingId: single })).status).toBe(409)
    expect((await add('REF-RET-8', legs().back, { role: 'second', withBookingId: '00000000-0000-0000-0000-000000000000' })).status).toBe(409)
    // Too late: the onward has waited longer than the window.
    const late = legs()
    const lateId = ((await add('REF-ON-9', late.onward, { role: 'first' })).json as { bookingId: string }).bookingId
    await exec(db, sql`update bookings set created_at = now() - interval '4 hours' where id = ${lateId}`)
    expect((await add('REF-RET-9', late.back, { role: 'second', withBookingId: lateId })).status).toBe(409)
    // The airline was never asked for the refused returns.
    expect(fake.addPassenger).toHaveBeenCalledTimes(4)
  })
})
