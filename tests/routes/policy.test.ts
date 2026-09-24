import { describe, it, expect, beforeAll } from 'vitest'
import { GET as groupsGet, POST as groupsPost } from '@/app/api/tmc/policy-groups/route'
import { PATCH as groupPatch, DELETE as groupDelete } from '@/app/api/tmc/policy-groups/[id]/route'
import { GET as linksGet, POST as linksPost, DELETE as linksDelete } from '@/app/api/tmc/client-policy-groups/route'
import { GET as rulesGet, POST as rulesPost } from '@/app/api/tmc/policy-rules/route'
import { GET as settingsPolicy } from '@/app/api/settings/policy/route'
import { POST as ruleEngineTest } from '@/app/api/rule-engine/test/route'
import { call } from '../harness/call'
import { actors, type Actors } from '../harness/actors'
import { resetDatabase } from '../harness/db'
import { db } from '@/app/lib/db'
import { sql, many, one, maybeOne } from '@/app/lib/db/sql'

// ── Policy: groups, links, rules ─────────────────────────────────────────────
// The TMC's policy master (groups covering band ranks, versioned rules), the
// links that attach groups to clients, the corporate admin's read-only view,
// and the rule-engine test harness.
// ─────────────────────────────────────────────────────────────────────────────

const HAS_DB = Boolean(process.env.DATABASE_URL)
const d = HAS_DB ? describe : describe.skip

// Rows this run creates are labelled in snapshots (random ids, db clock).
const created = new Map<string, string>()
function scrub<T>(value: T): T {
  return JSON.parse(JSON.stringify(value), (_key, v) =>
    typeof v === 'string' && created.has(v) ? created.get(v) : v)
}

d('policy', () => {
  let a: Actors
  let bcg: string
  let groupD: string       // linked to BCG, ranks 1-3, 14 rules
  let fresh: string        // created below

  beforeAll(async () => {
    await resetDatabase()
    a = await actors()
    bcg = a.corpAdmin.client_id!
    groupD = (await one<{ id: string }>(db, sql`
      select id from policy_groups where tmc_id = ${a.tmcAdmin.tmc_id} and name = 'd'`)).id
  })

  // ── Groups ─────────────────────────────────────────────────────────────────

  it('groups: list with ranks and client counts; search', async () => {
    expect((await call(groupsGet, { as: a.corpAdmin, url: '/api/tmc/policy-groups' })).status).toBe(403)
    const res = await call(groupsGet, { as: a.tmcAdmin, url: '/api/tmc/policy-groups' })
    expect(res.status).toBe(200)
    expect(res.json).toMatchSnapshot()
    const found = await call(groupsGet, { as: a.tmcAdmin, url: '/api/tmc/policy-groups?search=hey' })
    expect((found.json as { groups: { name: string }[] }).groups.map(g => g.name).sort()).toEqual(['hey', 'hey1'])
  })

  it('groups POST: required, created with normalised ranks, duplicates', async () => {
    const post = (body: unknown) => call(groupsPost, { as: a.tmcAdmin, method: 'POST', url: '/api/tmc/policy-groups', body })
    expect(await post({ name: ' ' })).toEqual({ status: 400, json: { error: 'name is required' } })
    const res = await post({ name: ' Senior ', code: ' SNR ', bandRanks: [7, 6, 6, -1, 'x', 8.5] })
    expect(res.status).toBe(201)
    const group = (res.json as { group: { id: string } }).group
    fresh = group.id
    created.set(fresh, '<fresh group>')
    expect(res.json).toMatchObject({ ok: true, group: { name: 'Senior', code: 'SNR', bandRanks: [6, 7], clientCount: 0 } })
    expect((await post({ name: 'Senior' })).json).toEqual({ error: 'A policy group named "Senior" already exists' })
    expect((await post({ name: 'Other', code: 'SNR' })).json).toEqual({ error: 'A policy group with code "SNR" already exists' })
  })

  const patch = (id: string, body: unknown, as = a.tmcAdmin) =>
    call(groupPatch, { as, method: 'PATCH', url: `/api/tmc/policy-groups/${id}`, params: { id }, body })

  it('group PATCH: not found, another TMC, empty name', async () => {
    expect((await patch('00000000-0000-0000-0000-000000000000', {})).status).toBe(404)
    expect((await patch(fresh, { name: 'x' }, a.otherTmcAdmin!)).json)
      .toEqual({ error: 'This policy group belongs to a different TMC' })
    expect(await patch(fresh, { name: ' ' })).toEqual({ status: 400, json: { error: 'name cannot be empty' } })
  })

  it('group PATCH: ranks added AND removed; rules stay with the group', async () => {
    const res = await patch(fresh, { name: 'Senior staff', bandRanks: [7, 9] })
    expect(res).toMatchObject({ status: 200, json: { ok: true, group: { id: fresh, name: 'Senior staff', bandRanks: [7, 9] } } })
    const ranks = await many<{ band_rank: number }>(db, sql`
      select band_rank from policy_group_band_ranks where policy_group_id = ${fresh} order by band_rank`)
    expect(ranks.map(r => r.band_rank)).toEqual([7, 9])
  })

  it('group PATCH: a rank already covered at a linked client is a 409', async () => {
    // Group "e" (ranks 5, 6) is linked to BCG with "d" (1, 2, 3): moving d onto 5 collides.
    const res = await patch(groupD, { bandRanks: [1, 2, 3, 5] })
    expect(res.status).toBe(409)
  })

  // ── Links ──────────────────────────────────────────────────────────────────

  it('links: what a client uses, ordered by lowest rank', async () => {
    const res = await call(linksGet, { as: a.tmcAdmin, url: `/api/tmc/client-policy-groups?clientId=${bcg}` })
    expect(res.status).toBe(200)
    expect(res.json).toMatchSnapshot()
  })

  it('links: another TMC can neither read nor unlink a client\'s groups', async () => {
    expect((await call(linksGet, { as: a.otherTmcAdmin!, url: `/api/tmc/client-policy-groups?clientId=${bcg}` })).status).toBe(404)
    expect((await call(linksDelete, {
      as: a.otherTmcAdmin!, method: 'DELETE', url: `/api/tmc/client-policy-groups?clientId=${bcg}&policyGroupId=${groupD}`,
    })).status).toBe(404)
    expect(await maybeOne(db, sql`
      select 1 as linked from client_policy_groups where client_id = ${bcg} and policy_group_id = ${groupD}`)).toEqual({ linked: 1 })
  })

  const link = (policyGroupId: string) => call(linksPost, {
    as: a.tmcAdmin, method: 'POST', url: '/api/tmc/client-policy-groups', body: { clientId: bcg, policyGroupId },
  })

  it('links POST: already linked, empty group, overlap, success', async () => {
    expect((await link(groupD)).status).toBe(409)
    const empty = await one<{ id: string }>(db, sql`
      select id from policy_groups g where tmc_id = ${a.tmcAdmin.tmc_id}
        and not exists (select 1 from policy_group_band_ranks r where r.policy_group_id = g.id)
        and not exists (select 1 from client_policy_groups l where l.policy_group_id = g.id and l.client_id = ${bcg})
      order by name limit 1`)
    expect((await link(empty.id)).status).toBe(400)
    const clash = await call(groupsPost, { as: a.tmcAdmin, method: 'POST', url: '/api/tmc/policy-groups', body: { name: 'Clash', bandRanks: [2] } })
    expect((await link((clash.json as { group: { id: string } }).group.id)).status).toBe(409)
    expect(await link(fresh)).toEqual({ status: 201, json: { ok: true } })
  })

  it('links DELETE', async () => {
    expect(await call(linksDelete, {
      as: a.tmcAdmin, method: 'DELETE', url: `/api/tmc/client-policy-groups?clientId=${bcg}&policyGroupId=${fresh}`,
    })).toEqual({ status: 200, json: { ok: true } })
  })

  // ── Rules ──────────────────────────────────────────────────────────────────

  it('rules: the latest version of a group', async () => {
    const res = await call(rulesGet, { as: a.tmcAdmin, url: `/api/tmc/policy-rules?groupId=${groupD}` })
    expect(res.status).toBe(200)
    const body = res.json as { version: number; rows: { travel_type: string; limit_key: string }[] }
    expect({ ...body, rows: [...body.rows].sort((x, y) => `${x.travel_type}${x.limit_key}`.localeCompare(`${y.travel_type}${y.limit_key}`)) })
      .toMatchSnapshot()
  })

  it('rules POST: validation, then a new version', async () => {
    const post = (body: unknown) => call(rulesPost, { as: a.tmcAdmin, method: 'POST', url: '/api/tmc/policy-rules', body })
    expect((await post({ policyGroupId: groupD, rules: [] })).status).toBe(400)
    expect((await post({ policyGroupId: groupD, rules: [{ travel_type: 'flight', limit_key: 'x' }] })).json)
      .toEqual({ error: 'Rule (flight/x) needs either limit_value or limit_bool' })
    expect((await post({ policyGroupId: groupD, rules: [
      { travel_type: 'flight', limit_key: 'x', limit_value: 1 }, { travel_type: 'flight', limit_key: 'x', limit_value: 2 },
    ] })).json).toEqual({ error: 'Duplicate rule: flight::x' })

    const before = await call(rulesGet, { as: a.tmcAdmin, url: `/api/tmc/policy-rules?groupId=${groupD}` })
    const version = (before.json as { version: number }).version
    const res = await post({ policyGroupId: groupD, rules: [
      { travel_type: 'flight', limit_key: 'max_fare_domestic', limit_value: 9000 },
      { travel_type: 'flight', limit_key: 'refundable_fare_required', limit_bool: false },
    ] })
    expect(res).toEqual({ status: 200, json: { ok: true, newVersion: version + 1 } })
    const after = await call(rulesGet, { as: a.tmcAdmin, url: `/api/tmc/policy-rules?groupId=${groupD}` })
    expect((after.json as { version: number; rows: unknown[] })).toMatchObject({ version: version + 1 })
    expect((after.json as { rows: unknown[] }).rows).toHaveLength(2)
  })

  // ── The corporate admin's view ─────────────────────────────────────────────

  it('settings/policy: admins only; the policy in force per band', async () => {
    const employee = await one<{ id: string }>(db, sql`
      select id from employees where client_id = ${bcg} and role <> 'admin' order by id limit 1`)
    expect((await call(settingsPolicy, { as: employee, url: '/api/settings/policy' })).status).toBe(403)
    const res = await call(settingsPolicy, { as: a.corpAdmin, url: '/api/settings/policy' })
    expect(res.status).toBe(200)
    const body = res.json as { rows: { band_code: string; limit_key: string }[] }
    expect(scrub({ ...body, rows: [...body.rows].sort((x, y) => `${x.band_code}${x.limit_key}`.localeCompare(`${y.band_code}${y.limit_key}`)) }))
      .toMatchSnapshot()
  })

  // ── The rule engine harness ────────────────────────────────────────────────

  it('rule-engine test: evaluates for the TMC that owns the traveller, and nobody else', async () => {
    const traveller = await one<{ id: string }>(db, sql`
      select id from employees where client_id = ${bcg} and band_code = 'L1' order by id limit 1`)
    const body = { employeeId: traveller.id, travelType: 'flight_domestic', totalCost: 9500,
      numericValues: { max_fare_domestic: 9500 }, booleanValues: {} }
    const res = await call(ruleEngineTest, { as: a.tmcAdmin, method: 'POST', url: '/api/rule-engine/test', body })
    expect(res.status).toBe(200)
    expect(res.json).toMatchSnapshot()
    expect((await call(ruleEngineTest, { as: a.otherTmcAdmin!, method: 'POST', url: '/api/rule-engine/test', body })).status).toBe(404)
  })

  // ── Delete ─────────────────────────────────────────────────────────────────

  it('group DELETE: refused while linked; removes an unlinked group and its rules', async () => {
    const refused = await call(groupDelete, { as: a.tmcAdmin, method: 'DELETE', url: `/api/tmc/policy-groups/${groupD}`, params: { id: groupD } })
    expect(refused.status).toBe(409)
    expect(await call(groupDelete, { as: a.tmcAdmin, method: 'DELETE', url: `/api/tmc/policy-groups/${fresh}`, params: { id: fresh } }))
      .toEqual({ status: 200, json: { ok: true } })
    expect(await maybeOne(db, sql`select id from policy_groups where id = ${fresh}`)).toBeNull()
  })
})
