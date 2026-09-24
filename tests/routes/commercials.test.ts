import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { GET as rulesGet, POST as rulesPost } from '@/app/api/tmc/commercial-rules/route'
import { GET as ruleGet, PATCH as rulePatch, DELETE as ruleDelete } from '@/app/api/tmc/commercial-rules/[id]/route'
import { GET as effectiveGet } from '@/app/api/tmc/commercial-rules/effective/route'
import { GET as assignmentsGet, POST as assignmentsPost, DELETE as assignmentsDelete } from '@/app/api/tmc/commercial-rule-assignments/route'
import { call } from '../harness/call'
import { actors, type Actors } from '../harness/actors'
import { resetDatabase } from '../harness/db'
import { db } from '@/app/lib/db'
import { sql, many, one, maybeOne, exec } from '@/app/lib/db/sql'

// ── The commercial rules master ──────────────────────────────────────────────
// Markup, discount and processing fee rules, who they reach, and what each
// client ends up with. TMC-side only: this is the one place the airline-vs-sell
// arithmetic is SUPPOSED to be visible.
//
// Rule status depends on today's date against each rule's validity window, so
// the clock is frozen.
// ─────────────────────────────────────────────────────────────────────────────

const HAS_DB = Boolean(process.env.DATABASE_URL)
const d = HAS_DB ? describe : describe.skip

const NO_SUCH_ID = '00000000-0000-0000-0000-0000000c0ffe'

interface Paged<T> { items: T[]; total: number }

function fresh<T extends Record<string, unknown>>(row: T) {
  const { id, created_at, updated_at, ...rest } = row
  expect(typeof id).toBe('string')
  expect(typeof created_at).toBe('string')
  expect(typeof updated_at).toBe('string')
  return rest
}

d('commercial rules', () => {
  let a: Actors
  let categoryId: string
  let theirCategory: string
  let markupId: string       // the template's AI markup, which has assignments

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-23T12:00:00Z'))
    await resetDatabase()
    a = await actors()
    categoryId = (await one<{ id: string }>(db, sql`
      select id from deal_code_categories where tmc_id = ${a.tmcAdmin.tmc_id} and code = 'DOMAIRBSP'
      order by created_at, id limit 1`)).id
    theirCategory = (await one<{ id: string }>(db, sql`
      select id from deal_code_categories where tmc_id <> ${a.tmcAdmin.tmc_id} order by id limit 1`)).id
    markupId = (await one<{ id: string }>(db, sql`
      select id from commercial_rules where tmc_id = ${a.tmcAdmin.tmc_id} and kind = 'markup' order by id limit 1`)).id
  })
  afterAll(() => { vi.useRealTimers() })

  // ── GET/POST /api/tmc/commercial-rules ─────────────────────────────────────

  it('list: 401, and a corporate user is refused', async () => {
    expect((await call(rulesGet, { url: '/api/tmc/commercial-rules' })).status).toBe(401)
    expect((await call(rulesGet, { as: a.corpAdmin, url: '/api/tmc/commercial-rules' })).status).toBe(403)
  })

  it('list: every rule with its category, status and reach', async () => {
    const res = await call(rulesGet, { as: a.tmcAdmin, url: '/api/tmc/commercial-rules' })
    expect(res.status).toBe(200)
    expect(res.json).toMatchSnapshot()
  })

  it('list: by kind, by status, by search', async () => {
    const ids = async (qs: string) =>
      ((await call(rulesGet, { as: a.tmcAdmin, url: `/api/tmc/commercial-rules?${qs}` })).json as Paged<{ id: string }>)
        .items.map(r => r.id).sort()
    const discounts = await many<{ id: string }>(db, sql`
      select id from commercial_rules where tmc_id = ${a.tmcAdmin.tmc_id} and kind = 'discount' order by id`)
    expect(await ids('kind=discount')).toEqual(discounts.map(r => r.id))
    expect(await ids('search=6e')).toHaveLength(1)
    expect(await ids('search=zz-nothing-zz')).toEqual([])
    const active = await ids('status=active')
    expect(active.length).toBeGreaterThan(0)
  })

  const post = (body: Record<string, unknown>) =>
    call(rulesPost, { as: a.tmcAdmin, method: 'POST', url: '/api/tmc/commercial-rules', body })

  it('POST: validation', async () => {
    expect(await post({ kind: 'bonus' })).toEqual({ status: 400, json: { error: 'kind must be markup, discount or processing_fee' } })
    expect(await post({ kind: 'markup' })).toEqual({ status: 400, json: { error: 'A category is required' } })
    expect(await post({ kind: 'markup', category_id: categoryId })).toEqual({ status: 400, json: { error: 'A rate is required' } })
    expect(await post({ kind: 'markup', category_id: theirCategory, rate: 2 }))
      .toEqual({ status: 422, json: { error: 'Category not found for this TMC' } })
    expect(await post({ kind: 'markup', category_id: categoryId, rate: 150, calc_type: 'percent' }))
      .toEqual({ status: 400, json: { error: 'A percentage over 100 — did you mean a fixed amount?' } })
    expect(await post({ kind: 'markup', category_id: categoryId, rate: 2, calc_basis: 'per_sector' }))
      .toEqual({ status: 400, json: { error: 'Calculation basis, excluded taxes and SSR only apply to a processing fee' } })
  })

  it('POST: a markup, and a fee with its fee-only defaults', async () => {
    const markup = await post({ kind: 'markup', category_id: categoryId, rate: 3, airline_code: ' uk ', notes: ' test ' })
    expect(markup.status).toBe(200)
    expect(fresh((markup.json as { rule: Record<string, unknown> }).rule)).toMatchSnapshot()

    const fee = await post({ kind: 'processing_fee', category_id: categoryId, rate: 250, calc_type: 'fixed' })
    expect(fee.status).toBe(200)
    expect((fee.json as { rule: unknown }).rule).toMatchObject({
      kind: 'processing_fee', calc_basis: 'per_transaction', exclude_tax_codes: [], include_ssr: false, targetCount: 0,
    })
  })

  // ── /api/tmc/commercial-rules/[id] ─────────────────────────────────────────

  const at = (id: string) => ({ url: `/api/tmc/commercial-rules/${id}`, params: { id } })

  it('[id]: another TMC cannot see it; one rule with the targets it reaches', async () => {
    expect(await call(ruleGet, { as: a.otherTmcAdmin!, ...at(markupId) })).toEqual({ status: 404, json: { error: 'Rule not found' } })
    const res = await call(ruleGet, { as: a.tmcAdmin, ...at(markupId) })
    expect(res.status).toBe(200)
    expect(res.json).toMatchSnapshot()
  })

  it('[id] PATCH: kind is fixed; validated against the merged rule', async () => {
    const p = (id: string, body: unknown) => call(rulePatch, { as: a.tmcAdmin, method: 'PATCH', ...at(id), body })
    expect(await p(markupId, { kind: 'discount' }))
      .toEqual({ status: 400, json: { error: 'A rule cannot change kind. Delete it and create the new one.' } })

    // The 6E fee is ₹1200 fixed; switching only calc_type would make it 1200%.
    const fee = await one<{ id: string }>(db, sql`
      select id from commercial_rules where tmc_id = ${a.tmcAdmin.tmc_id} and kind = 'processing_fee' and airline_code = '6E'`)
    expect(await p(fee.id, { calc_type: 'percent' }))
      .toEqual({ status: 400, json: { error: 'A percentage over 100 — did you mean a fixed amount?' } })
    expect(await p(markupId, { category_id: theirCategory }))
      .toEqual({ status: 422, json: { error: 'Category not found for this TMC' } })
    expect((await p(NO_SUCH_ID, { rate: 1 })).status).toBe(404)
  })

  it('[id] PATCH: saves, and a fee-only field is ignored on a markup', async () => {
    const res = await call(rulePatch, {
      as: a.tmcAdmin, method: 'PATCH', ...at(markupId),
      body: { rate: 12.5, notes: '  Tuned  ', active: false, rbd_spec: ' Y, B ' },
    })
    expect(res.status).toBe(200)
    expect((res.json as { rule: unknown }).rule).toMatchObject({
      id: markupId, rate: 12.5, notes: 'Tuned', active: false, rbd_spec: 'Y, B', status: 'inactive',
    })
  })

  // ── Effective coverage ─────────────────────────────────────────────────────

  it('effective: what each client ends up with', async () => {
    const res = await call(effectiveGet, { as: a.tmcAdmin, url: '/api/tmc/commercial-rules/effective' })
    expect(res.status).toBe(200)
    expect(res.json).toMatchSnapshot()
  })

  it('effective: by kind, and a tc sees only their clients', async () => {
    const byKind = await call(effectiveGet, { as: a.tmcAdmin, url: '/api/tmc/commercial-rules/effective?kind=discount' })
    const rows = (byKind.json as Paged<{ discount: string | null }>).items
    expect(rows.every(r => r.discount !== null)).toBe(true)

    // manage_commercials for the tc, and one granted client.
    await exec(db, sql`
      insert into employee_permissions (employee_id, permission_key) values (${a.tc!.id}, 'manage_commercials')
      on conflict do nothing`)
    const granted = await many<{ client_id: string }>(db, sql`
      select client_id from employee_client_access where employee_id = ${a.tc!.id}`)
    const asTc = await call(effectiveGet, { as: a.tc!, url: '/api/tmc/commercial-rules/effective' })
    expect(asTc.status).toBe(200)
    expect((asTc.json as Paged<{ clientId: string }>).items.map(r => r.clientId).sort())
      .toEqual(granted.map(g => g.client_id).sort())
  })

  // ── Assignments ────────────────────────────────────────────────────────────

  it('assignments: list, by rule', async () => {
    const res = await call(assignmentsGet, { as: a.tmcAdmin, url: `/api/tmc/commercial-rule-assignments?ruleId=${markupId}` })
    expect(res.status).toBe(200)
    const rows = (res.json as { assignments: { rule_id: string }[] }).assignments
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every(r => r.rule_id === markupId)).toBe(true)
  })

  const assign = (body: unknown) =>
    call(assignmentsPost, { as: a.tmcAdmin, method: 'POST', url: '/api/tmc/commercial-rule-assignments', body })

  it('assignments POST: validation and tenancy', async () => {
    expect(await assign({ ruleId: markupId, targets: [] }))
      .toEqual({ status: 400, json: { error: 'ruleId and at least one target are required' } })
    expect(await assign({ ruleId: NO_SUCH_ID, targets: [{ kind: 'client', id: NO_SUCH_ID }] }))
      .toEqual({ status: 404, json: { error: 'Rule not found' } })
    expect(await assign({ ruleId: markupId, targets: [{ kind: 'planet', id: NO_SUCH_ID }] }))
      .toEqual({ status: 400, json: { error: 'Unknown target kind: planet' } })
    expect(await assign({ ruleId: markupId, targets: [{ kind: 'client' }] }))
      .toEqual({ status: 400, json: { error: 'Every target needs an id' } })
    const theirClient = await one<{ id: string }>(db, sql`
      insert into clients (tmc_id, name) values (${a.otherTmcAdmin!.tmc_id}, 'Theirs') returning id`)
    expect(await assign({ ruleId: markupId, targets: [{ kind: 'client', id: theirClient.id }] }))
      .toEqual({ status: 422, json: { error: 'That client was not found for this TMC' } })
  })

  it('assignments POST: assigns several at once; the same target again is a no-op', async () => {
    const [c1, c2] = await many<{ id: string }>(db, sql`
      select id from clients where tmc_id = ${a.tmcAdmin.tmc_id} order by id limit 2`)
    const group = await one<{ id: string }>(db, sql`
      select id from client_groups where tmc_id = ${a.tmcAdmin.tmc_id} order by id limit 1`)
    const targets = [{ kind: 'client', id: c1.id }, { kind: 'client', id: c2.id }, { kind: 'client_group', id: group.id }]
    const ruleId = (await one<{ id: string }>(db, sql`
      select id from commercial_rules where tmc_id = ${a.tmcAdmin.tmc_id} and airline_code = 'UK'`)).id
    expect(await assign({ ruleId, targets })).toEqual({ status: 200, json: { ok: true, assigned: 3 } })
    expect(await assign({ ruleId, targets })).toEqual({ status: 200, json: { ok: true, assigned: 0 } })
    expect((await one<{ n: number }>(db, sql`
      select count(*)::int as n from commercial_rule_assignments where rule_id = ${ruleId}`)).n).toBe(3)
  })

  it('assignments DELETE, and deleting a rule takes its assignments with it', async () => {
    expect(await call(assignmentsDelete, { as: a.tmcAdmin, method: 'DELETE', url: '/api/tmc/commercial-rule-assignments' }))
      .toEqual({ status: 400, json: { error: 'id is required' } })
    const ruleId = (await one<{ id: string }>(db, sql`
      select id from commercial_rules where tmc_id = ${a.tmcAdmin.tmc_id} and airline_code = 'UK'`)).id
    const one_ = await one<{ id: string }>(db, sql`
      select id from commercial_rule_assignments where rule_id = ${ruleId} order by id limit 1`)
    expect(await call(assignmentsDelete, { as: a.tmcAdmin, method: 'DELETE', url: `/api/tmc/commercial-rule-assignments?id=${one_.id}` }))
      .toEqual({ status: 200, json: { ok: true } })

    expect(await call(ruleDelete, { as: a.tmcAdmin, method: 'DELETE', ...at(ruleId) })).toEqual({ status: 200, json: { ok: true } })
    expect(await maybeOne(db, sql`select id from commercial_rules where id = ${ruleId}`)).toBeNull()
    expect((await one<{ n: number }>(db, sql`
      select count(*)::int as n from commercial_rule_assignments where rule_id = ${ruleId}`)).n).toBe(0)
  })
})
