import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { loadCommercialContext, priceWithContext, stampCommercials } from '@/app/lib/commercials/stampCommercials'
import { stampDealCodes } from '@/app/lib/deal-codes/stampBooking'
import { stampFop } from '@/app/lib/fop/stampFop'
import { checkBookingAgainstPolicy } from '@/app/lib/rule-engine/checkBookingAgainstPolicy'
import { resolveEffectivePolicy } from '@/app/lib/rule-engine/resolveEffectivePolicy'
import { getLinkedPolicyGroups } from '@/app/lib/rule-engine/linkedPolicyGroups'
import { buildPolicyInputsFromFlight } from '@/app/lib/rule-engine/buildPolicyInputs'
import type { FlatFlightResult } from '@/app/lib/book/types'
import type { FareComponents } from '@/app/lib/commercials/fareComponents'
import { actors, type Actors } from '../harness/actors'
import { resetDatabase } from '../harness/db'
import { db } from '@/app/lib/db'
import { sql, one, many, exec } from '@/app/lib/db/sql'

// ── The booking stamps and the policy check ──────────────────────────────────
// What every search, price and booking asks the database: which commercials,
// deal codes and form of payment reach this client for this flight, and what
// policy the traveller is held to.
//
// Characterised against the anonymised template with synthetic flights, so the
// answers come from real configuration. "Today" is frozen: every one of these
// reads validity windows.
// ─────────────────────────────────────────────────────────────────────────────

const HAS_DB = Boolean(process.env.DATABASE_URL)
const d = HAS_DB ? describe : describe.skip

// The connection the modules under test are handed.
const conn = db

function flight(airline: string, legs: { rbd: string; number: string }[], opts: { lcc?: boolean } = {}): FlatFlightResult {
  const origin = { code: 'DEL', name: 'Delhi', city: 'Delhi', dateTime: '2026-11-10T08:00:00' }
  const destination = { code: 'BOM', name: 'Mumbai', city: 'Mumbai', dateTime: '2026-11-10T10:10:00' }
  const flightLegs = legs.map(l => ({ airlineCode: airline, flightNumber: l.number, bookingCode: l.rbd, cabin: 'Economy' }))
  return {
    flightKey: `${airline}-test`,
    provider: 'test',
    isLcc: opts.lcc ?? false,
    itemNo: '1',
    cabin: 'Economy',
    bookingCode: legs[0].rbd,
    legs: flightLegs,
    journeys: [{
      journeyNo: 1, origin, destination, airline: { code: airline, name: airline },
      stops: [], stopCount: legs.length - 1, legs: flightLegs,
    }],
    origin, destination,
    airline: { code: airline, name: airline },
    stopCount: legs.length - 1,
    stops: [],
    fareOptions: [],
  } as FlatFlightResult
}

const AI = flight('AI', [{ rbd: 'Y', number: '101' }])
const SIXE = flight('6E', [{ rbd: 'R', number: '201' }, { rbd: 'R', number: '202' }], { lcc: true })
const UK = flight('UK', [{ rbd: 'Y', number: '301' }])

const components: FareComponents = {
  base: 10000, otherTax: 500, fuelSurcharge: 300,
  taxLines: [{ code: 'K3', amount: 500 }, { code: 'YQ', amount: 300 }],
  total: 10800,
}

d('booking stamps', () => {
  let a: Actors
  let bcg: string
  let byBand: Record<string, string>

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-23T12:00:00Z'))
    await resetDatabase()
    a = await actors()
    bcg = a.corpAdmin.client_id!
    const people = await many<{ id: string; band_code: string }>(db, sql`
      select id, band_code from employees where client_id = ${bcg} order by id`)
    byBand = Object.fromEntries(people.map(p => [p.band_code, p.id]))
  })
  afterAll(() => { vi.useRealTimers() })

  // ── Commercials ────────────────────────────────────────────────────────────

  it('commercials: the rules and assignments that reach the client', async () => {
    const context = await loadCommercialContext(conn, bcg)
    expect({
      rules: [...context.rules].map(r => r.id).sort(),
      assignments: [...context.assignments].sort((x, y) => x.rule_id.localeCompare(y.rule_id)),
      categories: [...context.categoryIdByCode.keys()].sort(),
      enabledKinds: [...context.enabledKinds].sort(),
    }).toMatchSnapshot()
  })

  it('commercials: priced for an AI fare and a two-sector 6E fare', async () => {
    const context = await loadCommercialContext(conn, bcg)
    expect(priceWithContext(context, { flight: AI, components, pax: 1, pricedOn: '2026-09-23' })).toMatchSnapshot()
    expect(priceWithContext(context, { flight: SIXE, components, pax: 2, pricedOn: '2026-09-23' })).toMatchSnapshot()
  })

  it('commercials: the one-shot form agrees, and no client prices at the airline fare', async () => {
    const context = await loadCommercialContext(conn, bcg)
    const oneShot = await stampCommercials(conn, { clientId: bcg, flight: AI, components, pax: 1, pricedOn: '2026-09-23' })
    expect(oneShot).toEqual(priceWithContext(context, { flight: AI, components, pax: 1, pricedOn: '2026-09-23' }))

    const none = await loadCommercialContext(conn, null)
    expect(none.rules).toEqual([])
    expect((await loadCommercialContext(conn, '00000000-0000-0000-0000-000000000000')).rules).toEqual([])
  })

  it('commercials: a kind switched off for the client resolves to nothing', async () => {
    await exec(db, sql`update clients set processing_fee_active = false where id = ${bcg}`)
    const context = await loadCommercialContext(conn, bcg)
    expect(context.enabledKinds.has('processing_fee')).toBe(false)
    expect(priceWithContext(context, { flight: SIXE, components, pax: 2, pricedOn: '2026-09-23' }).resolved.processing_fee).toBeNull()
    await exec(db, sql`update clients set processing_fee_active = true where id = ${bcg}`)
  })

  // ── Deal codes ─────────────────────────────────────────────────────────────

  it('deal codes: stamped per airline flown; none for an airline without one', async () => {
    expect(await stampDealCodes(conn, bcg, AI)).toMatchSnapshot()
    expect(await stampDealCodes(conn, bcg, UK)).toBeNull()
    expect(await stampDealCodes(conn, '00000000-0000-0000-0000-000000000000', AI)).toBeNull()
  })

  // ── Form of payment ────────────────────────────────────────────────────────

  it('form of payment: resolved against airline, RBD and the client\'s payer order', async () => {
    expect(await stampFop(conn, bcg, AI)).toMatchSnapshot()
    expect(await stampFop(conn, bcg, SIXE)).toMatchSnapshot()
    expect(await stampFop(conn, '00000000-0000-0000-0000-000000000000', AI)).toBeNull()
  })

  it('form of payment: with the client on the cards\' branch, one is chosen by payer order', async () => {
    // Every card in the template is branch-scoped and BCG has no branch, so the
    // case above resolves nothing. Filed under the cards' branch, it must pick.
    const branch = await one<{ branch_id: string }>(db, sql`
      select branch_id from forms_of_payment where label = 'Credit AMEX'`)
    await exec(db, sql`update clients set branch_id = ${branch.branch_id} where id = ${bcg}`)
    const stamped = await stampFop(conn, bcg, AI)
    expect(stamped).not.toBeNull()
    expect(stamped).toMatchSnapshot()
    await exec(db, sql`update clients set branch_id = null where id = ${bcg}`)
  })

  // ── Policy ─────────────────────────────────────────────────────────────────

  it('policy: the groups linked to the client and the ranks they cover', async () => {
    const groups = await getLinkedPolicyGroups(conn, bcg)
    expect([...groups].sort((x, y) => x.name.localeCompare(y.name))).toMatchSnapshot()
  })

  const inputs = buildPolicyInputsFromFlight({ flight: AI, totalFare: 14000, isRefundable: false, selectedSeatFees: [] })
  const check = (employeeId: string) => checkBookingAgainstPolicy(conn, { employeeId, ...inputs })

  it('policy: a covered band is evaluated against its group\'s latest rules', async () => {
    expect(await resolveEffectivePolicy(conn, byBand.L1, inputs.travelType)).toMatchSnapshot()
    expect(await check(byBand.L3)).toMatchSnapshot()
  })

  it('policy: every way a policy can be missing is reported, never evaluated', async () => {
    // L4 is linked to no group covering rank 4; L5's group has no rules.
    expect(await check(byBand.L4)).toMatchObject({ ok: false, reason: 'no_policy_group' })
    expect(await check(byBand.L5)).toMatchObject({ ok: false, reason: 'no_policy_rules' })

    const unbanded = (await one<{ id: string }>(db, sql`
      update employees set band_code = null, band_id = null, band_rank = null where id = ${byBand.L3} returning id`)).id
    expect(await check(unbanded)).toMatchObject({ ok: false, reason: 'no_band' })

    await exec(db, sql`update clients set policy_controlling = false where id = ${bcg}`)
    expect(await check(byBand.L1)).toMatchObject({ ok: false, reason: 'policy_disabled' })
  })
})
