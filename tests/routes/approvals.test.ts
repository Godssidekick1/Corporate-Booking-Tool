import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { GET as chainGet, POST as chainPost } from '@/app/api/tmc/approval-chains/direct/route'
import { GET as bindingsGet, POST as bindingPost, DELETE as bindingDelete } from '@/app/api/tmc/approval-tier-approvers/route'
import { GET as templatesGet, POST as templatesPost } from '@/app/api/tmc/approval-templates/route'
import { PATCH as templatePatch, DELETE as templateDelete } from '@/app/api/tmc/approval-templates/[id]/route'
import { GET as assignmentsGet, POST as assignmentsPost, DELETE as assignmentsDelete } from '@/app/api/tmc/approval-assignments/route'
import { POST as pricePost } from '@/app/api/book/price/route'
import { POST as addPassenger } from '@/app/api/book/add-passenger/route'
import { GET as approvalsGet } from '@/app/api/approvals/route'
import { PATCH as decide } from '@/app/api/approvals/[approvalId]/route'
import { POST as refreshFare } from '@/app/api/approvals/[approvalId]/refresh-fare/route'
import { call } from '../harness/call'
import { actors, type Actors } from '../harness/actors'
import { resetDatabase } from '../harness/db'
import { db } from '@/app/lib/db'
import { sql, many, one, maybeOne, exec } from '@/app/lib/db/sql'

// ── Approvals: configuration and the live queue ──────────────────────────────
// The TMC's side (templates, the direct chain editor, per-client approver
// bindings, the employee → band → client-default assignment ladder) and the
// approver's side (the queue, deciding, re-pricing before deciding), with
// add-passenger as the step that raises approvals in the first place.
//
// Amadeus is faked for pricing and passenger submission. The clock is frozen:
// the queue's history window and urgency count read it.
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

const HAS_DB = Boolean(process.env.DATABASE_URL)
const d = HAS_DB ? describe : describe.skip

function pricing(key: string, ref: string, total = 10800) {
  return {
    Key: key, ReferenceNo: ref,
    AirPricingResponse: [{ PricingInfos: { PricingInfo: [{
      Total: { Fare: String(total), BaseFare: String(total - 800), OtherTax: '500', FuelSurcharge: '300' },
      Currency: 'INR', FareType: 'Retail', Meal: 'NO',
      FareBreakDowns: { FareBreakDown: [{
        PaxType: 'ADT', BaseFare: String(total - 800), TotalTax: '800', TotalFare: String(total), Refundable: 'Refundable',
        Taxes: { Tax: [{ TaxCode: 'K3', Amount: '500' }, { TaxCode: 'YQ', Amount: '300' }] },
      }] },
      FareInfos: { FareInfo: [{ PaxFareBasis: 'Y1' }] },
      Penalties: { ChangePenalty: [], CancelPenalty: [] },
    }] } }],
  }
}

// Rows this run creates get random ids and database timestamps. Snapshots
// label them instead, so they are stable from run to run.
const created = new Map<string, string>()
function scrub<T>(value: T): T {
  return JSON.parse(JSON.stringify(value), (_key, v) =>
    typeof v === 'string' && created.has(v) ? created.get(v) : v)
}

const LEG = { airlineCode: 'AI', flightNumber: '101', bookingCode: 'Y', cabin: 'Economy' }
const ITINERARY = {
  flightKey: 'k', provider: 'test', isLcc: false, itemNo: '1', cabin: 'Economy', legs: [LEG],
  journeys: [{ journeyNo: 1, stops: [], stopCount: 0, legs: [LEG],
    origin: { code: 'DEL', name: 'Delhi', city: 'Delhi', dateTime: '2030-11-10T08:00:00' },
    destination: { code: 'BOM', name: 'Mumbai', city: 'Mumbai', dateTime: '2030-11-10T10:10:00' } }],
  origin: { code: 'DEL', name: 'Delhi', city: 'Delhi', dateTime: '2030-11-10T08:00:00' },
  destination: { code: 'BOM', name: 'Mumbai', city: 'Mumbai', dateTime: '2030-11-10T10:10:00' },
  airline: { code: 'AI', name: 'Air India' }, stopCount: 0, stops: [], fareOptions: [],
}

d('approvals', () => {
  let a: Actors
  let bcg: string
  let traveller: { id: string }      // a BCG employee (not the admin)
  let approver: { id: string }       // BCG's corporate admin, bound as a specific approver
  let secondApprover: { id: string } // another BCG employee, bound as step 2

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-23T12:00:00Z'))
    await resetDatabase()
    a = await actors()
    bcg = a.corpAdmin.client_id!
    approver = { id: a.corpAdmin.id }
    const others = await many<{ id: string }>(db, sql`
      select id from employees where client_id = ${bcg} and id <> ${approver.id} order by id`)
    traveller = others[0]
    secondApprover = others[1]
  })
  afterAll(() => { vi.useRealTimers() })

  // ── The direct chain editor ────────────────────────────────────────────────

  const saveChain = (body: Record<string, unknown>) => call(chainPost, {
    as: a.tmcAdmin, method: 'POST', url: '/api/tmc/approval-chains/direct',
    body: { clientId: bcg, employeeId: traveller.id, category: 'air', mode: 'sequential', quorum: 'all', ...body },
  })

  it('direct chain: validation', async () => {
    expect((await saveChain({ approvers: [] })).json).toEqual({ error: 'Add at least one approver' })
    expect((await saveChain({ mode: 'parallel', approvers: [{ approver_type: 'manager' }] })).json)
      .toEqual({ error: 'Multiple approvers needs at least two — use multi-tier for a single approver' })
    expect((await saveChain({ approvers: [{ approver_type: 'specific_user' }] })).json)
      .toEqual({ error: 'Approver 1: choose a person' })
    expect((await saveChain({ approvers: [{ approver_type: 'any_manager_at' }] })).json)
      .toEqual({ error: 'Approver 1: choose a minimum band rank' })
    expect((await saveChain({ employeeId: '00000000-0000-0000-0000-000000000000', approvers: [{ approver_type: 'manager' }] })))
      .toEqual({ status: 404, json: { error: 'Employee not found at this client' } })
    expect((await call(chainPost, { as: a.otherTmcAdmin!, method: 'POST', url: '/api/tmc/approval-chains/direct',
      body: { clientId: bcg, employeeId: null, category: 'air', mode: 'sequential', quorum: 'all', approvers: [{ approver_type: 'manager' }] } })).status)
      .toBe(404)
  })

  it('direct chain: someone from another client is refused and nothing changes', async () => {
    const before = await call(chainGet, { as: a.tmcAdmin, url: `/api/tmc/approval-chains/direct?clientId=${bcg}&category=air&employeeId=${traveller.id}` })
    const outsider = await one<{ id: string }>(db, sql`
      select id from employees where client_id is not null and client_id <> ${bcg} order by id limit 1`)
    const res = await saveChain({ approvers: [{ approver_type: 'specific_user', approver_user_id: outsider.id, min_verdict: 'green' }] })
    expect(res).toEqual({ status: 400, json: { error: 'One of those people does not work at this client' } })
    const after = await call(chainGet, { as: a.tmcAdmin, url: `/api/tmc/approval-chains/direct?clientId=${bcg}&category=air&employeeId=${traveller.id}` })
    expect(after.json).toEqual(before.json)
  })

  it('direct chain: saves two sequential steps, and reads back as the form sent it', async () => {
    const res = await saveChain({ approvers: [
      { approver_type: 'specific_user', approver_user_id: approver.id, min_verdict: 'green' },
      { approver_type: 'specific_user', approver_user_id: secondApprover.id, min_verdict: 'green' },
    ] })
    expect(res.status).toBe(200)
    const chainId = (res.json as { chainId: string }).chainId
    const read = await call(chainGet, { as: a.tmcAdmin, url: `/api/tmc/approval-chains/direct?clientId=${bcg}&category=air&employeeId=${traveller.id}` })
    expect(read.json).toEqual({
      ok: true,
      chain: {
        id: chainId, mode: 'sequential', quorum: 'all',
        approvers: [
          { approver_type: 'specific_user', approver_user_id: approver.id, min_band_rank: null, min_verdict: 'green' },
          { approver_type: 'specific_user', approver_user_id: secondApprover.id, min_band_rank: null, min_verdict: 'green' },
        ],
      },
    })
    // Saving again replaces the same chain rather than making another.
    const again = await saveChain({ approvers: [
      { approver_type: 'specific_user', approver_user_id: approver.id, min_verdict: 'green' },
      { approver_type: 'specific_user', approver_user_id: secondApprover.id, min_verdict: 'green' },
    ] })
    expect((again.json as { chainId: string }).chainId).toBe(chainId)
  })

  // ── Raising and deciding approvals ─────────────────────────────────────────

  async function book(key: string): Promise<{ bookingId: string; status: string }> {
    fake.pricing.mockResolvedValueOnce(pricing(key, `REF-${key}`))
    const priced = await call(pricePost, {
      as: traveller, method: 'POST', url: '/api/book/price',
      body: { key: 'SK', pricingKey: 'PK', provider: 'test', resultIndex: '1', itinerary: ITINERARY },
    })
    expect(priced.status).toBe(200)
    fake.addPassenger.mockResolvedValueOnce({ ReferenceNo: `REF-${key}` })
    const res = await call(addPassenger, {
      as: traveller, method: 'POST', url: '/api/book/add-passenger',
      body: {
        key, pricingKey: 'PK', provider: 'test', resultIndex: '1', referenceNo: `REF-${key}`, totalFare: 10800,
        currency: 'INR', isRefundable: true, fareType: 'Retail', passengerBreakup: [], searchKey: 'SK',
        itinerary: ITINERARY,
        customerInfo: { Email: 't@example.test', Mobile: '9999999999', PassengerDetails: [{ FirstName: 'T', LastName: 'Raveller' }] },
      },
    })
    expect(res.status).toBe(200)
    return res.json as { bookingId: string; status: string }
  }

  it('add-passenger: an unheld price is refused', async () => {
    const res = await call(addPassenger, {
      as: traveller, method: 'POST', url: '/api/book/add-passenger',
      body: { key: 'NOPE', pricingKey: 'PK', provider: 'test', referenceNo: 'NOPE', totalFare: 1,
        customerInfo: { PassengerDetails: [{ FirstName: 'X' }] } },
    })
    expect(res).toMatchObject({ status: 409, json: { code: 'QUOTE_EXPIRED' } })
  })

  let first: { bookingId: string; status: string }

  it('add-passenger: records the booking and raises step 1 of the chain', async () => {
    first = await book('K1')
    expect(first.status).toBe('pending_approval')
    const booking = await one<Record<string, unknown>>(db, sql`
      select status, total_cost, sell_total, employee_id, policy_status from bookings where id = ${first.bookingId}`)
    expect(booking).toMatchObject({ status: 'pending_approval', employee_id: traveller.id, total_cost: 10800 })
    const approvals = await many(db, sql`
      select tier, status, approver_id from approvals where booking_id = ${first.bookingId} order by tier`)
    expect(approvals).toEqual([{ tier: 1, status: 'pending', approver_id: approver.id }])
  })

  it('queue: the approver sees it, sell-side, with a summary for the dashboard', async () => {
    const res = await call(approvalsGet, { as: approver, url: '/api/approvals' })
    expect(res.status).toBe(200)
    const body = res.json as { pending: { bookingId: string; approvalId: string; createdAt: string }[]; history: unknown[] }
    expect(body.pending.map(p => p.bookingId)).toEqual([first.bookingId])
    expect(JSON.stringify(body)).not.toMatch(/"sell_total"|"commercials"/)
    created.set(first.bookingId, '<booking 1>')
    created.set(body.pending[0].approvalId, '<approval 1.1>')
    expect(scrub({ ...body, pending: body.pending.map(p => ({ ...p, createdAt: '<now>' })) })).toMatchSnapshot()

    const summary = await call(approvalsGet, { as: approver, url: '/api/approvals?summary=1' })
    expect(summary.json).toMatchObject({ ok: true, pendingCount: 1, urgentCount: 0 })
  })

  const decideAs = (as: { id: string }, approvalId: string, body: unknown) =>
    call(decide, { as, method: 'PATCH', url: `/api/approvals/${approvalId}`, params: { approvalId }, body })

  const pendingFor = async (bookingId: string) => one<{ id: string; approver_id: string; tier: number }>(db, sql`
    select id, approver_id, tier from approvals where booking_id = ${bookingId} and status = 'pending'`)

  it('decide: only the assigned approver, only once, only approve or reject', async () => {
    const step = await pendingFor(first.bookingId)
    expect((await decideAs(traveller, step.id, { decision: 'approve' })).status).toBe(403)
    expect(await decideAs(approver, step.id, { decision: 'maybe' }))
      .toEqual({ status: 400, json: { error: 'decision must be "approve" or "reject"' } })
    expect((await decideAs(approver, '00000000-0000-0000-0000-000000000000', { decision: 'approve' })).status).toBe(404)
  })

  it('refresh-fare: re-prices, and the booking and step carry the new figures', async () => {
    const step = await pendingFor(first.bookingId)
    fake.pricing.mockResolvedValueOnce(pricing('K1-NEW', 'REF-K1', 12000))
    const res = await call(refreshFare, {
      as: approver, method: 'POST', url: `/api/approvals/${step.id}/refresh-fare`, params: { approvalId: step.id }, body: {},
    })
    expect(res.status).toBe(200)
    expect(res.json).toMatchObject({ ok: true, totalCost: 12000 })
    expect(await one(db, sql`select amadeus_key, total_cost from bookings where id = ${first.bookingId}`))
      .toEqual({ amadeus_key: 'K1-NEW', total_cost: 12000 })
    expect((await call(refreshFare, {
      as: traveller, method: 'POST', url: `/api/approvals/${step.id}/refresh-fare`, params: { approvalId: step.id }, body: {},
    })).status).toBe(403)
  })

  it('decide: approving step 1 raises step 2; approving step 2 approves the booking', async () => {
    const step1 = await pendingFor(first.bookingId)
    expect(await decideAs(approver, step1.id, { decision: 'approve', note: 'ok' }))
      .toEqual({ status: 200, json: { ok: true, bookingStatus: 'pending_approval', nextTier: 2 } })
    expect((await decideAs(approver, step1.id, { decision: 'approve' })).status).toBe(409)

    const step2 = await pendingFor(first.bookingId)
    expect(step2).toMatchObject({ approver_id: secondApprover.id, tier: 2 })
    expect(await decideAs(secondApprover, step2.id, { decision: 'approve' }))
      .toEqual({ status: 200, json: { ok: true, bookingStatus: 'approved' } })
    expect((await one<{ status: string }>(db, sql`select status from bookings where id = ${first.bookingId}`)).status).toBe('approved')
  })

  it('decide: a rejection ends the booking', async () => {
    const second = await book('K2')
    const step1 = await pendingFor(second.bookingId)
    expect(await decideAs(approver, step1.id, { decision: 'reject', note: 'too dear' }))
      .toEqual({ status: 200, json: { ok: true, bookingStatus: 'rejected' } })
    expect(await one(db, sql`select status, decision_note from approvals where id = ${step1.id}`))
      .toEqual({ status: 'rejected', decision_note: 'too dear' })
    expect((await one<{ status: string }>(db, sql`select status from bookings where id = ${second.bookingId}`)).status).toBe('rejected')
  })

  it('queue: decisions appear in the approver\'s history', async () => {
    const res = await call(approvalsGet, { as: approver, url: '/api/approvals' })
    const body = res.json as { pending: unknown[]; history: { bookingId: string; status: string; decisionNote: string | null }[] }
    expect(body.pending).toEqual([])
    // The template carries older decisions of theirs too; only this run's.
    const mine = body.history.filter(h => h.bookingId === first.bookingId || h.decisionNote === 'too dear')
    expect(mine.map(h => h.status).sort()).toEqual(['approved', 'rejected'])
  })

  it('direct chain: a brand-new chain for someone with none', async () => {
    const res = await call(chainPost, {
      as: a.tmcAdmin, method: 'POST', url: '/api/tmc/approval-chains/direct',
      body: { clientId: bcg, employeeId: secondApprover.id, category: 'misc', mode: 'sequential', quorum: 'all',
        approvers: [{ approver_type: 'manager', min_verdict: 'amber' }] },
    })
    expect(res.status).toBe(200)
    const chainId = (res.json as { chainId: string }).chainId
    created.set(chainId, '<new misc chain>')
    expect(await one(db, sql`
      select client_id, mode, jsonb_array_length(tiers) as steps from approval_chain_templates where id = ${chainId}`))
      .toEqual({ client_id: bcg, mode: 'sequential', steps: 1 })
    expect(await one(db, sql`
      select template_id from employee_approval_templates where employee_id = ${secondApprover.id} and category = 'misc'`))
      .toEqual({ template_id: chainId })
  })

  // ── Bindings ───────────────────────────────────────────────────────────────

  it('tier approvers: list, bind, clear, and the tenancy checks', async () => {
    const template = await one<{ id: string }>(db, sql`
      select id from approval_chain_templates where tmc_id = ${a.tmcAdmin.tmc_id} and client_id is null order by name limit 1`)
    const base = `/api/tmc/approval-tier-approvers?clientId=${bcg}&templateId=${template.id}`
    const list = await call(bindingsGet, { as: a.tmcAdmin, url: base })
    expect(list.status).toBe(200)
    expect(list.json).toMatchSnapshot()

    const bind = (body: Record<string, unknown>) => call(bindingPost, {
      as: a.tmcAdmin, method: 'POST', url: '/api/tmc/approval-tier-approvers',
      body: { clientId: bcg, templateId: template.id, tier: 2, ...body },
    })
    expect(await bind({ approverType: 'wizard' })).toEqual({ status: 400, json: { error: 'Invalid approver type: wizard' } })
    expect(await bind({ approverType: 'specific_user' })).toEqual({ status: 400, json: { error: 'Choose a person for this step' } })
    expect(await bind({ approverType: 'finance_role' })).toEqual({ status: 200, json: { ok: true } })
    expect(await maybeOne(db, sql`
      select approver_type from approval_tier_approvers where client_id = ${bcg} and template_id = ${template.id} and tier = 2`))
      .toEqual({ approver_type: 'finance_role' })

    const owned = await one<{ id: string }>(db, sql`
      select id from approval_chain_templates where client_id is not null and client_id <> ${bcg} and tmc_id = ${a.tmcAdmin.tmc_id} limit 1`)
    expect(await call(bindingsGet, { as: a.tmcAdmin, url: `/api/tmc/approval-tier-approvers?clientId=${bcg}&templateId=${owned.id}` }))
      .toEqual({ status: 403, json: { error: 'This approval chain belongs to a different client' } })

    expect(await call(bindingDelete, { as: a.tmcAdmin, method: 'DELETE', url: `${base}&tier=2` })).toEqual({ status: 200, json: { ok: true } })
    expect(await maybeOne(db, sql`
      select 1 from approval_tier_approvers where client_id = ${bcg} and template_id = ${template.id} and tier = 2`)).toBeNull()
  })

  // ── Templates ──────────────────────────────────────────────────────────────

  it('templates: list with usage counts', async () => {
    const res = await call(templatesGet, { as: a.tmcAdmin, url: '/api/tmc/approval-templates' })
    expect(res.status).toBe(200)
    // Chains made earlier in this run are left out: their timestamps are the
    // database's clock, not a fixture.
    const body = res.json as { templates: { id: string }[] }
    expect({ ...body, templates: body.templates.filter(t => !created.has(t.id)) }).toMatchSnapshot()
    expect((await call(templatesGet, { as: a.corpAdmin, url: '/api/tmc/approval-templates' })).status).toBe(403)
  })

  it('templates: create, validate, edit (bumping the version), delete', async () => {
    const post = (body: unknown) => call(templatesPost, { as: a.tmcAdmin, method: 'POST', url: '/api/tmc/approval-templates', body })
    expect(await post({ name: ' ' })).toEqual({ status: 400, json: { error: 'name is required' } })
    expect(await post({ name: 'X', mode: 'parallel', tiers: [{ tier: 1, min_verdict: 'amber' }] }))
      .toEqual({ status: 400, json: { error: 'Parallel mode needs at least two steps — use multi-tier for a single approver' } })
    expect(await post({ name: 'X', tiers: [{ tier: 1, min_verdict: 'amber' }, { tier: 1, min_verdict: 'red' }] }))
      .toEqual({ status: 400, json: { error: 'Duplicate step number: 1' } })

    const created = await post({ name: ' Two step ', code: ' TS ', tiers: [{ tier: 1, min_verdict: 'amber' }, { tier: 2, min_verdict: 'red' }] })
    expect(created.status).toBe(201)
    const template = (created.json as { template: { id: string; version: number } }).template
    expect(created.json).toMatchObject({ ok: true, template: { name: 'Two step', code: 'TS', mode: 'sequential', employeeCount: 0 } })
    expect((await post({ name: 'Two step', tiers: [{ tier: 1, min_verdict: 'amber' }] })).status).toBe(409)

    const patch = (body: unknown) => call(templatePatch, {
      as: a.tmcAdmin, method: 'PATCH', url: `/api/tmc/approval-templates/${template.id}`, params: { id: template.id }, body,
    })
    expect(await patch({})).toEqual({ status: 400, json: { error: 'Nothing to update' } })
    expect(await patch({ mode: 'parallel', tiers: [{ tier: 1, min_verdict: 'amber' }] }))
      .toEqual({ status: 400, json: { error: 'Parallel mode needs at least two steps — use multi-tier for a single approver' } })
    const edited = await patch({ name: 'Two-step' })
    expect(edited).toMatchObject({ status: 200, json: { ok: true, template: { name: 'Two-step', version: template.version + 1 } } })
    expect((await call(templatePatch, {
      as: a.otherTmcAdmin!, method: 'PATCH', url: `/api/tmc/approval-templates/${template.id}`, params: { id: template.id }, body: { name: 'x' },
    })).status).toBe(403)

    expect(await call(templateDelete, {
      as: a.tmcAdmin, method: 'DELETE', url: `/api/tmc/approval-templates/${template.id}`, params: { id: template.id },
    })).toEqual({ status: 200, json: { ok: true } })
  })

  it('templates: deleting one a band routes through is refused', async () => {
    const res = await call(templatesPost, {
      as: a.tmcAdmin, method: 'POST', url: '/api/tmc/approval-templates',
      body: { name: 'Band only', tiers: [{ tier: 1, min_verdict: 'amber' }] },
    })
    const id = (res.json as { template: { id: string } }).template.id
    created.set(id, '<band only template>')
    await exec(db, sql`
      insert into band_approval_templates (client_id, band_code, category, template_id)
      values (${bcg}, 'L2', 'misc', ${id})`)
    const refused = await call(templateDelete, {
      as: a.tmcAdmin, method: 'DELETE', url: `/api/tmc/approval-templates/${id}`, params: { id },
    })
    expect(refused).toEqual({ status: 409, json: { error: '"Band only" is assigned to 1 band. Reassign it before deleting.' } })
    expect(await maybeOne(db, sql`select 1 as kept from band_approval_templates where template_id = ${id}`)).toEqual({ kept: 1 })
  })

  it('assignments DELETE: another client\'s employee cannot be cleared', async () => {
    const outsider = await one<{ employee_id: string; category: string }>(db, sql`
      select e.employee_id, e.category from employee_approval_templates e
      join employees x on x.id = e.employee_id
      where x.client_id <> ${bcg} order by e.employee_id limit 1`).catch(() => null)
    const target = outsider ?? { employee_id: (await one<{ id: string }>(db, sql`
      select id from employees where client_id is not null and client_id <> ${bcg} order by id limit 1`)).id, category: 'air' }
    const res = await call(assignmentsDelete, {
      as: a.tmcAdmin, method: 'DELETE',
      url: `/api/tmc/approval-assignments?clientId=${bcg}&category=${target.category}&employeeId=${target.employee_id}`,
    })
    expect(res).toEqual({ status: 404, json: { error: 'Employee not found at this client' } })
  })

  it('templates: deleting one someone is routed through is refused', async () => {
    const used = await one<{ id: string; name: string }>(db, sql`
      select t.id, t.name from approval_chain_templates t
      where exists (select 1 from employee_approval_templates e where e.template_id = t.id)
      order by t.name limit 1`)
    const res = await call(templateDelete, {
      as: a.tmcAdmin, method: 'DELETE', url: `/api/tmc/approval-templates/${used.id}`, params: { id: used.id },
    })
    expect(res.status).toBe(409)
    expect((res.json as { error: string }).error).toMatch(/routed through/)
  })

  // ── Assignments ────────────────────────────────────────────────────────────

  it('assignments: the whole ladder for a client', async () => {
    const res = await call(assignmentsGet, { as: a.tmcAdmin, url: `/api/tmc/approval-assignments?clientId=${bcg}` })
    expect(res.status).toBe(200)
    expect(scrub(res.json)).toMatchSnapshot()
    expect((await call(assignmentsGet, { as: a.otherTmcAdmin!, url: `/api/tmc/approval-assignments?clientId=${bcg}` })).status).toBe(404)
  })

  it('assignments: employees, a band, the client default; set and clear', async () => {
    const template = await one<{ id: string }>(db, sql`
      select id from approval_chain_templates where tmc_id = ${a.tmcAdmin.tmc_id} and client_id is null order by name limit 1`)
    const assign = (body: Record<string, unknown>) => call(assignmentsPost, {
      as: a.tmcAdmin, method: 'POST', url: '/api/tmc/approval-assignments', body: { clientId: bcg, category: 'misc', ...body },
    })
    expect(await assign({ category: 'spa', templateId: template.id })).toEqual({ status: 400, json: { error: 'Invalid category: spa' } })
    expect(await assign({ templateId: template.id, employeeIds: [traveller.id], bandCode: 'L1' }))
      .toEqual({ status: 400, json: { error: 'Assign to employees or to a band, not both in one request' } })
    expect(await assign({ templateId: '00000000-0000-0000-0000-000000000000' }))
      .toEqual({ status: 404, json: { error: 'Approval template not found for this TMC' } })
    const outsider = await one<{ id: string }>(db, sql`
      select id from employees where client_id is not null and client_id <> ${bcg} order by id limit 1`)
    expect(await assign({ templateId: template.id, employeeIds: [outsider.id] }))
      .toEqual({ status: 400, json: { error: 'One or more employees do not belong to this client' } })
    expect(await assign({ templateId: template.id, bandCode: 'ZZ' }))
      .toEqual({ status: 400, json: { error: '"ZZ" is not a band at this client' } })

    expect(await assign({ templateId: template.id, employeeIds: [traveller.id, secondApprover.id] }))
      .toEqual({ status: 200, json: { ok: true, assigned: 2 } })
    expect(await assign({ templateId: template.id, bandCode: 'L1' })).toEqual({ status: 200, json: { ok: true, bandSet: true } })
    expect(await assign({ templateId: template.id })).toEqual({ status: 200, json: { ok: true, defaultSet: true } })
    expect((await one<{ n: number }>(db, sql`
      select count(*)::int as n from employee_approval_templates where category = 'misc' and template_id = ${template.id}`)).n).toBe(2)

    expect(await assign({ templateId: null, employeeIds: [traveller.id] })).toEqual({ status: 200, json: { ok: true, cleared: 1 } })
    expect(await assign({ templateId: null, bandCode: 'L1' })).toEqual({ status: 200, json: { ok: true, bandCleared: true } })
    const del = (qs: string) => call(assignmentsDelete, {
      as: a.tmcAdmin, method: 'DELETE', url: `/api/tmc/approval-assignments?clientId=${bcg}&category=misc${qs}`,
    })
    expect(await del(`&employeeId=${secondApprover.id}`)).toEqual({ status: 200, json: { ok: true } })
    expect(await del('')).toEqual({ status: 200, json: { ok: true } })
    expect(await maybeOne(db, sql`
      select 1 from client_default_approval_templates where client_id = ${bcg} and category = 'misc'`)).toBeNull()
  })
})
