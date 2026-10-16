import { describe, it, expect, beforeAll } from 'vitest'
import { GET as tripsGet, POST as tripsPost } from '@/app/api/trips/route'
import { GET as tripGet, PATCH as tripPatch } from '@/app/api/trips/[tripId]/route'
import { GET as optionsGet } from '@/app/api/trips/options/route'
import { call } from '../harness/call'
import { actors, type Actors } from '../harness/actors'
import { resetDatabase } from '../harness/db'
import { db } from '@/app/lib/db'
import { sql, many, one, exec } from '@/app/lib/db/sql'

// ── Trips: details ───────────────────────────────────────────────────────────
// What a trip is for -- domestic or abroad, billable, which cost centre, what
// budget, a project -- on the New trip form and the trip page. The cost centre
// is always one of the TRAVELLER's company's; edits stop while the trip is
// awaiting sign-off or signed off.
// ─────────────────────────────────────────────────────────────────────────────

const HAS_DB = Boolean(process.env.DATABASE_URL)
const d = HAS_DB ? describe : describe.skip

d('trips: details', () => {
  let a: Actors
  let clientId: string
  let me: { id: string }
  let ours: { id: string; code: string }
  let theirs: { id: string }

  beforeAll(async () => {
    await resetDatabase()
    a = await actors()
    clientId = a.corpAdmin.client_id!
    me = { id: a.corpAdmin.id }
    ours = await one(db, sql`
      insert into cost_centres (client_id, code, name) values (${clientId}, 'TRIP-CC', 'Trips test centre')
      returning id, code`)
    const other = await one<{ id: string }>(db, sql`
      select id from clients where id <> ${clientId} and tmc_id is not null order by id limit 1`)
    theirs = await one(db, sql`
      insert into cost_centres (client_id, code, name) values (${other.id}, 'OTHER-CC', 'Not yours') returning id`)
  })

  const create = (body: Record<string, unknown>) =>
    call(tripsPost, { as: me, method: 'POST', url: '/api/trips', body })
  const at = (id: string) => ({ url: `/api/trips/${id}`, params: { tripId: id } })
  const idOf = (r: { json: unknown }) => (r.json as { trip: { id: string } }).trip.id

  it('a trip with every detail, read back on the trip and in the list', async () => {
    const res = await create({
      name: 'Pune plant audit', travelType: 'domestic', billable: true, project: ' Plant audit FY27 ',
      currency: 'inr', budgetAmount: '45000.505', costCentreId: ours.id,
    })
    expect(res.status).toBe(200)
    const trip = (await call(tripGet, { as: me, ...at(idOf(res)) })).json as { trip: Record<string, unknown> }
    expect(trip.trip).toMatchObject({
      name: 'Pune plant audit', travel_type: 'domestic', billable: true, project: 'Plant audit FY27',
      currency: 'INR', budget_amount: 45000.51, cost_centre_id: ours.id, cost_centre_code: 'TRIP-CC',
      approval_status: 'none', flight_count: 0, total_cost: 0,
    })
    const list = (await call(tripsGet, { as: me, url: '/api/trips?page=1' })).json as { trips: { id: string; cost_centre_name: string | null }[] }
    expect(list.trips.find(t => t.id === idOf(res))?.cost_centre_name).toBe('Trips test centre')
  })

  it('a name alone still makes a trip (the trip picker), with the defaults', async () => {
    const res = await create({ name: 'Quick one' })
    const trip = (await call(tripGet, { as: me, ...at(idOf(res)) })).json as { trip: Record<string, unknown> }
    expect(trip.trip).toMatchObject({ travel_type: null, billable: false, project: null, currency: 'INR', budget_amount: null, cost_centre_id: null })
  })

  it('bad details are refused, and nothing is created', async () => {
    const before = (await one<{ n: number }>(db, sql`select count(*)::int as n from trips where created_by = ${me.id}`)).n
    expect(await create({ name: 'X', travelType: 'space' }))
      .toEqual({ status: 400, json: { error: 'travelType must be "domestic" or "international"' } })
    expect((await create({ name: 'X', budgetAmount: -1 })).status).toBe(400)
    expect((await create({ name: 'X', currency: 'RUPEES' })).status).toBe(400)
    expect((await create({ name: 'X', billable: 'yes' })).status).toBe(400)
    expect((await create({ name: 'X', project: 'p'.repeat(121) })).status).toBe(400)
    expect((await create({ name: 'X', costCentreId: 'not-an-id' })).status).toBe(400)
    // Another company's cost centre, by a valid id: refused, not borrowed.
    expect(await create({ name: 'X', costCentreId: theirs.id }))
      .toEqual({ status: 422, json: { error: "That cost centre is not one of your company's" } })
    expect((await one<{ n: number }>(db, sql`select count(*)::int as n from trips where created_by = ${me.id}`)).n).toBe(before)
  })

  it('details are edited on the trip; not while it awaits sign-off or is signed off', async () => {
    const id = idOf(await create({ name: 'Edit me' }))
    const patch = (body: Record<string, unknown>) => call(tripPatch, { as: me, method: 'PATCH', ...at(id), body })

    expect(await patch({ name: 'Edited', travelType: 'international', budgetAmount: 1200, costCentreId: ours.id }))
      .toMatchObject({ status: 200, json: { trip: { name: 'Edited', travel_type: 'international', budget_amount: 1200, cost_centre_id: ours.id } } })
    // Naming only one field changes only that one.
    expect(await patch({ billable: true })).toMatchObject({ status: 200, json: { trip: { name: 'Edited', billable: true, budget_amount: 1200 } } })
    expect(await patch({ costCentreId: null })).toMatchObject({ status: 200, json: { trip: { cost_centre_id: null } } })
    expect((await patch({ name: '  ' })).status).toBe(400)
    expect(await patch({ costCentreId: theirs.id })).toEqual({ status: 422, json: { error: "That cost centre is not one of this company's" } })
    expect(await patch({})).toEqual({ status: 400, json: { error: 'Nothing to change' } })

    for (const [status, error] of [
      ['pending', 'This trip is awaiting sign-off and cannot be changed until it is decided.'],
      ['approved', 'This trip is signed off and cannot be changed.'],
    ] as const) {
      await exec(db, sql`update trips set approval_status = ${status} where id = ${id}`)
      expect(await patch({ name: 'Sneaky' })).toEqual({ status: 409, json: { error } })
    }
    // A rejected trip is edited and sent again.
    await exec(db, sql`update trips set approval_status = 'rejected' where id = ${id}`)
    expect((await patch({ name: 'Fixed' })).status).toBe(200)
  })

  it('at a company that signs trips off, a trip is complete only once signed off', async () => {
    const id = idOf(await create({ name: 'Needs sign-off' }))
    await exec(db, sql`update clients set trip_approval_mode = 'on_submit' where id = ${clientId}`)
    try {
      expect(await call(tripPatch, { as: me, method: 'PATCH', ...at(id), body: { status: 'completed' } }))
        .toEqual({ status: 409, json: { error: 'This company signs trips off: submit it for approval first.' } })
      await exec(db, sql`update trips set approval_status = 'approved' where id = ${id}`)
      expect((await call(tripPatch, { as: me, method: 'PATCH', ...at(id), body: { status: 'completed' } })).status).toBe(200)
    } finally {
      await exec(db, sql`update clients set trip_approval_mode = 'not_required' where id = ${clientId}`)
    }
  })

  it('options: the traveller company\'s cost centres, the currencies, whether trips are signed off', async () => {
    const res = await call(optionsGet, { as: me, url: '/api/trips/options' })
    const body = res.json as { costCentres: { id: string }[]; currencies: string[]; tripApprovalRequired: boolean }
    expect(res.status).toBe(200)
    expect(body.costCentres.map(c => c.id)).toContain(ours.id)
    expect(body.costCentres.map(c => c.id)).not.toContain(theirs.id)
    expect(body.currencies[0]).toBe('INR')
    expect(body.tripApprovalRequired).toBe(false)

    // For a colleague, by the booking-for rule; a plain employee may not ask for someone else.
    const [colleague, plain] = await many<{ id: string }>(db, sql`
      select id from employees where client_id = ${clientId} and id <> ${me.id} and role = 'employee' and status = 'active'
      order by id limit 2`)
    expect((await call(optionsGet, { as: me, url: `/api/trips/options?travellerId=${colleague.id}` })).status).toBe(200)
    expect((await call(optionsGet, { as: plain, url: `/api/trips/options?travellerId=${colleague.id}` })).status).toBe(403)
  })
})
