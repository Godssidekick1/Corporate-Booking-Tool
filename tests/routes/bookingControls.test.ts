import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import { POST as pricePost } from '@/app/api/book/price/route'
import { POST as addPassengerPost } from '@/app/api/book/add-passenger/route'
import { GET as controlsGet } from '@/app/api/book/controls/route'
import { PATCH as clientPatch } from '@/app/api/tmc/clients/[id]/route'
import { POST as tripsPost } from '@/app/api/trips/route'
import { POST as chainPost } from '@/app/api/tmc/approval-chains/direct/route'
import { GET as rulesGet, POST as rulesPost } from '@/app/api/tmc/policy-rules/route'
import { resolveEffectivePolicy } from '@/app/lib/rule-engine/resolveEffectivePolicy'
import { call } from '../harness/call'
import { actors, type Actors } from '../harness/actors'
import { resetDatabase } from '../harness/db'
import { db } from '@/app/lib/db'
import { sql, one, maybeOne, exec } from '@/app/lib/db/sql'

// ── How a company books (Corporate Settings), through add-passenger ──────────
// Personal trips, guest bookings (the company switch AND the traveller's
// band, through their policy group), a reason for out-of-policy fares, blocking
// red fares, the duplicate check, and the quote hold. Each is refused before
// the airline sees a passenger, which the fake's call count proves.
//
// A corporate admin books for a colleague throughout: the TRAVELLER's company
// settings apply. Amadeus is faked; the verdict is set per test.
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

let verdict: 'green' | 'amber' | 'red' = 'green'
vi.mock('@/app/lib/rule-engine/checkBookingAgainstPolicy', async orig => {
  const actual = await orig<typeof import('@/app/lib/rule-engine/checkBookingAgainstPolicy')>()
  return {
    ...actual,
    checkBookingAgainstPolicy: () => Promise.resolve({
      ok: true, policyGroupName: 'P', bandCode: 'L1', verdict,
      breaches: verdict === 'green' ? [] : [{ limit_key: 'max_fare_domestic', kind: 'numeric', policyValue: 5000, actualValue: 9000, severity: verdict }],
      costTier: 'not_evaluated',
    }),
  }
})

const HAS_DB = Boolean(process.env.DATABASE_URL)
const d = HAS_DB ? describe : describe.skip

const NOW = new Date('2026-10-19T06:00:00Z')

function pricing(ref: string) {
  return {
    Key: `KEY-${ref}`, ReferenceNo: ref,
    AirPricingResponse: [{ PricingInfos: { PricingInfo: [{
      Total: { Fare: '9000', BaseFare: '8200', OtherTax: '800', FuelSurcharge: '0' },
      Currency: 'INR', FareType: 'NRM', Meal: 'NO',
      FareBreakDowns: { FareBreakDown: [{ PaxType: 'ADT', BaseFare: '8200', TotalTax: '800', TotalFare: '9000', Refundable: 'Refundable' }] },
      FareInfos: { FareInfo: [{ PaxFareBasis: 'Y1' }] },
      Penalties: { ChangePenalty: [], CancelPenalty: [] },
    }] } }],
  }
}

// One itinerary per test, on its own day, so the duplicate check only sees
// what a test means it to.
function itinerary(day: string) {
  const at = (t: string) => `${day}T${t}:00`
  const origin = { code: 'DEL', name: 'Delhi', city: 'Delhi', dateTime: at('08:00') }
  const destination = { code: 'BOM', name: 'Mumbai', city: 'Mumbai', dateTime: at('10:10') }
  const leg = { airlineCode: 'AI', flightNumber: '101', bookingCode: 'Y', cabin: 'Economy' }
  return {
    flightKey: 'k', provider: 'test', isLcc: false, itemNo: '1', cabin: 'Economy', legs: [leg],
    journeys: [{ journeyNo: 1, stops: [], stopCount: 0, legs: [leg], origin, destination }],
    origin, destination, airline: { code: 'AI', name: 'Air India' }, stopCount: 0, stops: [], fareOptions: [],
  }
}

d('booking controls (Corporate Settings)', () => {
  let a: Actors
  let clientId: string
  let colleague: { id: string }

  const setClient = (fields: Record<string, unknown>) =>
    call(clientPatch, { as: a.tmcAdmin, method: 'PATCH', url: `/api/tmc/clients/${clientId}`, params: { id: clientId }, body: fields })

  // One yes/no rule of the colleague's policy group, saved as the editor
  // does: a new version carrying every other rule unchanged.
  async function setBandRule(key: string, value: boolean) {
    const policy = await resolveEffectivePolicy(db, colleague.id, 'flight')
    if (!policy.ok) throw new Error(policy.message)
    const got = await call(rulesGet, { as: a.tmcAdmin, url: `/api/tmc/policy-rules?groupId=${policy.policyGroupId}` })
    const rows = (got.json as { rows: { travel_type: string; limit_key: string }[] }).rows.filter(r => r.limit_key !== key)
    const res = await call(rulesPost, {
      as: a.tmcAdmin, method: 'POST', url: '/api/tmc/policy-rules',
      body: { policyGroupId: policy.policyGroupId, rules: [...rows, { travel_type: 'flight', limit_key: key, limit_bool: value }] },
    })
    expect(res.status).toBe(200)
  }
  const controls = async () =>
    (await call(controlsGet, { as: a.corpAdmin, url: `/api/book/controls?travellerId=${colleague.id}` })).json as { personalAllowed: boolean; guestAllowed: boolean }

  async function price(ref: string, day: string) {
    fake.pricing.mockResolvedValueOnce(pricing(ref))
    const res = await call(pricePost, {
      as: a.corpAdmin, method: 'POST', url: '/api/book/price',
      body: { key: 'SEARCH-KEY', pricingKey: 'PK', provider: 'test', resultIndex: '1', itinerary: itinerary(day), travellerId: colleague.id },
    })
    expect(res.status).toBe(200)
  }

  function addPassenger(ref: string, day: string, extra: Record<string, unknown> = {}) {
    fake.addPassenger.mockResolvedValueOnce({ ReferenceNo: ref })
    return call(addPassengerPost, {
      as: a.corpAdmin, method: 'POST', url: '/api/book/add-passenger',
      body: {
        key: `KEY-${ref}`, pricingKey: 'PK', provider: 'test', resultIndex: '1', referenceNo: ref, totalFare: 9000,
        currency: 'INR', isRefundable: true, fareType: 'NRM', passengerBreakup: [], searchKey: 'SK',
        itinerary: itinerary(day), travellerId: colleague.id,
        customerInfo: { Email: 'c@example.test', Mobile: '9999999999', PassengerDetails: [{ FirstName: 'C', LastName: 'Olleague' }] },
        ...extra,
      },
    })
  }

  const bookingFor = (ref: string) => maybeOne<{ id: string; status: string; purpose: string; for_guest: boolean; policy_status: string; policy_reason_code: string | null }>(db, sql`
    select id, status, purpose, for_guest, policy_status, policy_reason_code from bookings where provider_order_id = ${ref}`)

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
    await resetDatabase()
    a = await actors()
    clientId = a.corpAdmin.client_id!
    colleague = await one<{ id: string }>(db, sql`
      select id from employees where client_id = ${clientId} and id <> ${a.corpAdmin.id}
        and role = 'employee' and status = 'active' order by id limit 1`)
    // The colleague's own chain: one named approver, every verdict -- so a
    // business booking always reaches an approver who reads the reason.
    const approver = await one<{ id: string }>(db, sql`
      select id from employees where client_id = ${clientId} and id not in (${a.corpAdmin.id}, ${colleague.id})
        and role = 'employee' and status = 'active' order by id limit 1`)
    const chain = await call(chainPost, {
      as: a.tmcAdmin, method: 'POST', url: '/api/tmc/approval-chains/direct',
      body: { clientId, employeeId: colleague.id, category: 'air', mode: 'sequential', quorum: 'all',
        approvers: [{ approver_type: 'specific_user', approver_user_id: approver.id, min_verdict: 'green' }] },
    })
    expect(chain.status).toBe(200)
  })
  afterAll(() => { vi.useRealTimers() })
  beforeEach(() => {
    for (const f of Object.values(fake)) f.mockReset()
    verdict = 'green'
    vi.setSystemTime(NOW)
  })

  it('settings: validated, and offered to the booking screens for the traveller', async () => {
    expect((await setClient({ out_of_policy_handling: 'never' })).status).toBe(400)
    expect((await setClient({ duplicate_booking_check: 'sometimes' })).status).toBe(400)
    const res = await call(controlsGet, { as: a.corpAdmin, url: `/api/book/controls?travellerId=${colleague.id}` })
    expect(res.json).toEqual({
      ok: true, personalAllowed: false, guestAllowed: true, reasonRequired: false, blocksRed: false,
      duplicateCheck: 'off', quoteHoldMinutes: 30,
    })
  })

  it('personal: refused unless the company and the band allow it; then no policy, no approval, never in a trip', async () => {
    await price('P1', '2030-01-01')
    expect(await addPassenger('P1', '2030-01-01', { purpose: 'personal' }))
      .toMatchObject({ status: 403, json: { code: 'PERSONAL_NOT_ALLOWED', error: 'Your company does not allow personal trips to be booked here.' } })
    expect(fake.addPassenger).not.toHaveBeenCalled()

    // The company allows it; the colleague's band does not (the group says No).
    expect((await setClient({ personal_bookings_allowed: true })).status).toBe(200)
    expect(await addPassenger('P1', '2030-01-01', { purpose: 'personal' }))
      .toMatchObject({ status: 403, json: { code: 'PERSONAL_NOT_ALLOWED', error: "The traveller's travel policy does not allow personal trips." } })
    expect(fake.addPassenger).not.toHaveBeenCalled()
    expect((await controls()).personalAllowed).toBe(false)

    // The band allows it, but the company switch still decides first.
    await setBandRule('personal_trips_allowed', true)
    await setClient({ personal_bookings_allowed: false })
    expect((await controls()).personalAllowed).toBe(false)
    expect((await addPassenger('P1', '2030-01-01', { purpose: 'personal' })).status).toBe(403)

    await setClient({ personal_bookings_allowed: true })
    expect((await controls()).personalAllowed).toBe(true)
    verdict = 'red'  // a personal trip is not judged at all
    const res = await addPassenger('P1', '2030-01-01', { purpose: 'personal' })
    expect(res.status).toBe(200)
    const booking = await bookingFor('P1')
    expect(booking).toMatchObject({ purpose: 'personal', status: 'approved', policy_status: 'not_evaluated' })
    expect(await maybeOne(db, sql`select 1 from approvals where booking_id = ${booking!.id}`)).toBeNull()
    // Paid by the traveller's own card, or by nothing the resolver could pick.
    const fop = await one<{ payer: string | null }>(db, sql`select resolved_fop->>'payer' as payer from bookings where id = ${booking!.id}`)
    expect([null, 'traveller']).toContain(fop.payer)

    const trip = await call(tripsPost, { as: a.corpAdmin, method: 'POST', url: '/api/trips', body: { name: 'Work', travellerId: colleague.id } })
    const tripId = (trip.json as { trip: { id: string } }).trip.id
    await price('P2', '2030-01-02')
    expect((await addPassenger('P2', '2030-01-02', { purpose: 'personal', tripId })).status).toBe(400)
    await setClient({ personal_bookings_allowed: false })
    await setBandRule('personal_trips_allowed', false)
  })

  it('personal: with policy control off, the company switch alone decides', async () => {
    await setClient({ personal_bookings_allowed: true, policy_controlling: false })
    expect((await controls()).personalAllowed).toBe(true)
    await price('P3', '2030-01-03')
    expect((await addPassenger('P3', '2030-01-03', { purpose: 'personal' })).status).toBe(200)
    await setClient({ personal_bookings_allowed: false, policy_controlling: true })
  })

  it('guest: refused when the company books employees only, or the band may not', async () => {
    await setClient({ guest_bookings_allowed: false })
    await price('G1', '2030-02-01')
    expect(await addPassenger('G1', '2030-02-01', { forGuest: true }))
      .toMatchObject({ status: 403, json: { code: 'GUEST_NOT_ALLOWED' } })
    expect(fake.addPassenger).not.toHaveBeenCalled()

    await setClient({ guest_bookings_allowed: true })
    // The group never set the rule, so guests were allowed (the first test);
    // a band that may not is refused.
    await setBandRule('guest_bookings_allowed', false)
    expect(await addPassenger('G1', '2030-02-01', { forGuest: true }))
      .toMatchObject({ status: 403, json: { code: 'GUEST_NOT_ALLOWED', error: "The traveller's travel policy does not allow bookings for guests." } })
    expect((await controls()).guestAllowed).toBe(false)
    expect(fake.addPassenger).not.toHaveBeenCalled()

    await setBandRule('guest_bookings_allowed', true)
    expect((await controls()).guestAllowed).toBe(true)
    expect((await addPassenger('G1', '2030-02-01', { forGuest: true })).status).toBe(200)
    expect(await bookingFor('G1')).toMatchObject({ for_guest: true, purpose: 'business' })
  })

  it('reason required: an amber fare needs a reason from anyone, and the approver reads it', async () => {
    await setClient({ out_of_policy_reason_required: true })
    verdict = 'amber'
    await price('R1', '2030-03-01')
    expect(await addPassenger('R1', '2030-03-01'))
      .toMatchObject({ status: 400, json: { code: 'POLICY_REASON_REQUIRED' } })
    expect(fake.addPassenger).not.toHaveBeenCalled()

    const res = await addPassenger('R1', '2030-03-01', { policyReasonCode: 'schedule_need', policyReasonNote: 'Client meeting at 9' })
    expect(res.status).toBe(200)
    const booking = await bookingFor('R1')
    expect(booking?.policy_reason_code).toBe('schedule_need')
    const approval = await one<{ reason: string }>(db, sql`select reason from approvals where booking_id = ${booking!.id} order by tier limit 1`)
    expect(approval.reason).toContain('Reason given: Schedule or timing need (Client meeting at 9)')

    // Green needs none.
    verdict = 'green'
    await price('R2', '2030-03-02')
    expect((await addPassenger('R2', '2030-03-02')).status).toBe(200)
    await setClient({ out_of_policy_reason_required: false })
  })

  it('block red: a red fare is refused before the airline; amber still goes to approval', async () => {
    await setClient({ out_of_policy_handling: 'block_red' })
    verdict = 'red'
    await price('B1', '2030-04-01')
    expect(await addPassenger('B1', '2030-04-01'))
      .toMatchObject({ status: 409, json: { code: 'POLICY_BLOCKED' } })
    expect(fake.addPassenger).not.toHaveBeenCalled()
    expect(await bookingFor('B1')).toBeNull()

    verdict = 'amber'
    expect((await addPassenger('B1', '2030-04-01')).status).toBe(200)
    await setClient({ out_of_policy_handling: 'approve' })
  })

  it('duplicates: warn asks once and books on confirm; block refuses', async () => {
    await setClient({ duplicate_booking_check: 'warn' })
    await price('D1', '2030-05-01')
    expect((await addPassenger('D1', '2030-05-01')).status).toBe(200)

    await price('D2', '2030-05-01')
    const warned = await addPassenger('D2', '2030-05-01')
    expect(warned).toMatchObject({ status: 409, json: { code: 'DUPLICATE_WARNING', existingBookingId: (await bookingFor('D1'))!.id } })
    expect(fake.addPassenger).toHaveBeenCalledTimes(1)
    expect((await addPassenger('D2', '2030-05-01', { confirmDuplicate: true })).status).toBe(200)

    // Another day is not a duplicate.
    await price('D3', '2030-05-02')
    expect((await addPassenger('D3', '2030-05-02')).status).toBe(200)

    await setClient({ duplicate_booking_check: 'block' })
    await price('D4', '2030-05-01')
    expect(await addPassenger('D4', '2030-05-01', { confirmDuplicate: true }))
      .toMatchObject({ status: 409, json: { code: 'DUPLICATE_BOOKING' } })

    // A cancelled booking does not count.
    await exec(db, sql`update bookings set status = 'cancelled' where provider_order_id in ('D1', 'D2')`)
    expect((await addPassenger('D4', '2030-05-01')).status).toBe(200)
    await setClient({ duplicate_booking_check: 'off' })
  })

  it('quote hold: a fare priced more than 30 minutes ago is not booked', async () => {
    await price('Q1', '2030-06-01')
    await price('Q2', '2030-06-02')
    vi.setSystemTime(new Date(NOW.getTime() + 29 * 60_000))
    expect((await addPassenger('Q1', '2030-06-01')).status).toBe(200)
    vi.setSystemTime(new Date(NOW.getTime() + 31 * 60_000))
    expect(await addPassenger('Q2', '2030-06-02'))
      .toMatchObject({ status: 409, json: { code: 'QUOTE_EXPIRED' } })
    expect(fake.addPassenger).toHaveBeenCalledTimes(1)
  })
})
