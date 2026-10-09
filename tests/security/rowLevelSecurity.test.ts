import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { actors, type Actors } from '../harness/actors'
import { resetDatabase } from '../harness/db'
import { mirrorTenant } from '../harness/mirrorTenant'
import { db, runAsRequest, enterContext, transaction, type DbContext } from '@/app/lib/db'

// ── The database enforces tenant isolation ───────────────────────────────────
// The leak sweep (tenantLeaks.test.ts) proves the ROUTES filter by tenant.
// This proves the DATABASE does, whatever the code asks: queries written with
// no tenant filter at all -- the bug row-level security exists to contain --
// run through the app's own data path (app/lib/db) under each context, as the
// restricted role the suite connects as.
//
//   no scope        sees no tenant rows
//   a TMC           sees nothing of another TMC
//   a corporate     sees only its own client, and its TMC's shared rows
//   any tenant      cannot write a row into another tenant
//   the pool        a reused connection never carries one tenant into the next
// ─────────────────────────────────────────────────────────────────────────────

const HAS_DB = Boolean(process.env.DATABASE_URL)
const d = HAS_DB ? describe : describe.skip

// Every table the tenant policies cover, and how a row names its tenant.
const BY_TMC = ['branches', 'buckets', 'client_groups', 'commercial_rules', 'coverage_state', 'deal_codes',
  'deal_code_categories', 'fop_gds_entries', 'fop_payment_types', 'forms_of_payment', 'policy_groups']
const BY_CLIENT = ['approval_tier_approvers', 'approvals', 'band_approval_templates', 'bands', 'bookings',
  'bucket_clients', 'client_default_approval_templates', 'client_gst_registrations', 'client_mandatory_info',
  'client_policy_groups', 'cost_centres', 'employee_client_access', 'price_quotes', 'trip_expenses', 'trips']
const BY_EITHER = ['approval_chain_templates', 'audit_log', 'commercial_coverage', 'commercial_rule_assignments',
  'deal_code_assignments', 'deal_code_coverage', 'employees', 'fop_assignments', 'policy_rules']

d('row-level security', () => {
  let a: Actors
  let tmcA: string
  let tmcB: string
  let clientsA: string[]
  let clientsB: string[]
  let corp: { client: string; tmc: string }

  beforeAll(async () => {
    await resetDatabase()
    a = await actors()
    tmcA = a.tmcAdmin.tmc_id!
    tmcB = a.otherTmcAdmin!.tmc_id!
    // Both TMCs stocked, so "sees none of B" is a claim about real rows.
    await mirrorTenant(tmcA, tmcB)
    const ids = async (tmc: string) =>
      (await db.query('select id from clients where tmc_id = $1 order by id', [tmc])).rows.map(r => r.id as string)
    clientsA = await ids(tmcA)
    clientsB = await ids(tmcB)
    corp = { client: a.corpAdmin.client_id!, tmc: tmcA }
    expect(clientsB.length).toBeGreaterThan(0)
  })
  afterEach(() => { delete process.env.DB_POOL_MODE })

  const as = <T>(ctx: DbContext, fn: () => Promise<T>) => runAsRequest(async () => { enterContext(ctx); return fn() })
  const tenantA: DbContext = { scope: 'tenant', tmcId: '', clientId: null }
  const count = async (sql: string, params: unknown[] = []) => Number((await db.query(sql, params)).rows[0].n)

  // Rows of `table` that belong to the given TMC's tenant, counted with NO
  // filter but the one being asserted -- the query a buggy route might make.
  async function rowsOf(table: string, tmc: string, clients: string[]): Promise<number> {
    if (BY_TMC.includes(table)) return count(`select count(*) n from ${table} where tmc_id = $1`, [tmc])
    if (BY_CLIENT.includes(table)) return count(`select count(*) n from ${table} where client_id = any($1)`, [clients])
    return count(`select count(*) n from ${table} where tmc_id = $1 or client_id = any($2)`, [tmc, clients])
  }

  it('no scope: no tenant rows at all', async () => {
    for (const t of [...BY_TMC, ...BY_CLIENT, ...BY_EITHER, 'clients', 'tmcs']) {
      expect([t, await as({ scope: 'none', tmcId: null, clientId: null }, () => count(`select count(*) n from ${t}`))]).toEqual([t, 0])
    }
  })

  it('a TMC sees every row of its own, and none of another TMC, in every tenant table', async () => {
    for (const t of [...BY_TMC, ...BY_CLIENT, ...BY_EITHER]) {
      const own = await rowsOf(t, tmcA, clientsA)                      // outside a request: everything
      const ctx = { ...tenantA, tmcId: tmcA }
      expect([t, await as(ctx, () => rowsOf(t, tmcA, clientsA))]).toEqual([t, own])
      expect([t, await as(ctx, () => rowsOf(t, tmcB, clientsB))]).toEqual([t, 0])
    }
    // The tenants themselves.
    const ctx = { ...tenantA, tmcId: tmcA }
    expect(await as(ctx, () => count('select count(*) n from clients where tmc_id <> $1', [tmcA]))).toBe(0)
    expect(await as(ctx, () => count('select count(*) n from tmcs where id <> $1', [tmcA]))).toBe(0)
  })

  it('an unfiltered query returns only the caller\'s tenant', async () => {
    const ownCount: Record<string, () => Promise<number>> = {
      deal_codes: () => rowsOf('deal_codes', tmcA, clientsA),
      employees: () => rowsOf('employees', tmcA, clientsA),
      clients: () => count('select count(*) n from clients where tmc_id = $1', [tmcA]),
    }
    for (const t of Object.keys(ownCount)) {
      const all = await count(`select count(*) n from ${t}`)
      const ofA = await ownCount[t]()
      expect([t, all > ofA]).toEqual([t, true])                         // B has rows too
      expect([t, await as({ ...tenantA, tmcId: tmcA }, () => count(`select count(*) n from ${t}`))]).toEqual([t, ofA])
    }
  })

  it('a corporate user sees only their own client, and their TMC\'s shared rows', async () => {
    const ctx: DbContext = { scope: 'tenant', tmcId: corp.tmc, clientId: corp.client }
    expect(await as(ctx, () => count('select count(*) n from clients'))).toBe(1)
    for (const t of BY_CLIENT) {
      expect([t, await as(ctx, () => count(`select count(*) n from ${t} where client_id <> $1`, [corp.client]))]).toEqual([t, 0])
    }
    // Employees: their colleagues, and their TMC's staff (who book for them);
    // nobody from another client.
    expect(await as(ctx, () => count('select count(*) n from employees where client_id is not null and client_id <> $1', [corp.client]))).toBe(0)
    // The TMC's masters a booking is priced and stamped with.
    expect(await as(ctx, () => count('select count(*) n from deal_codes'))).toBe(await count('select count(*) n from deal_codes where tmc_id = $1', [corp.tmc]))
  })

  it('cannot write a row into another tenant', async () => {
    const ctx = { ...tenantA, tmcId: tmcA }
    await expect(as(ctx, () => db.query(
      `insert into buckets (tmc_id, name) values ($1, 'rls test')`, [tmcB]))).rejects.toThrow(/row-level security/)
    await expect(as(ctx, () => db.query(
      `insert into trips (client_id, created_by, name, status) values ($1, $2, 'rls test', 'open')`,
      [clientsB[0], a.otherTmcAdmin!.id]))).rejects.toThrow(/row-level security/)
    // An update that tries to move a row out of the tenant is refused too.
    const own = (await db.query('select id from buckets where tmc_id = $1 limit 1', [tmcA])).rows[0].id
    await expect(as(ctx, () => db.query('update buckets set tmc_id = $1 where id = $2', [tmcB, own]))).rejects.toThrow(/row-level security/)
    // And another tenant's rows cannot even be touched: nothing matches.
    expect((await as(ctx, () => db.query('update buckets set name = name where tmc_id = $1', [tmcB]))).rowCount).toBe(0)
    expect((await as(ctx, () => db.query('delete from bookings where client_id = any($1)', [clientsB]))).rowCount).toBe(0)
  })

  it('the pool never carries one request\'s tenant into another\'s query', async () => {
    // Far more requests than connections, alternating tenants and no tenant,
    // all in flight together: every query must see exactly its own.
    const ofA = await count('select count(*) n from clients where tmc_id = $1', [tmcA])
    const ofB = await count('select count(*) n from clients where tmc_id = $1', [tmcB])
    const contexts: [DbContext, number][] = [
      [{ ...tenantA, tmcId: tmcA }, ofA],
      [{ ...tenantA, tmcId: tmcB }, ofB],
      [{ scope: 'none', tmcId: null, clientId: null }, 0],
      [{ scope: 'tenant', tmcId: corp.tmc, clientId: corp.client }, 1],
    ]
    const runs = Array.from({ length: 80 }, (_, i) => contexts[i % contexts.length])
    const seen = await Promise.all(runs.map(([ctx]) => as(ctx, () => count('select count(*) n from clients'))))
    expect(seen).toEqual(runs.map(([, n]) => n))
  })

  it('a transaction runs as the request\'s tenant too', async () => {
    const n = await as({ ...tenantA, tmcId: tmcB }, () => transaction(tx => tx.query('select count(*) n from clients')))
    expect(Number(n.rows[0].n)).toBe(await count('select count(*) n from clients where tmc_id = $1', [tmcB]))
  })

  it('behind a transaction pooler, the same isolation holds', async () => {
    process.env.DB_POOL_MODE = 'transaction'
    expect(await as({ ...tenantA, tmcId: tmcA }, () => rowsOf('bookings', tmcB, clientsB))).toBe(0)
    expect(await as({ scope: 'none', tmcId: null, clientId: null }, () => count('select count(*) n from bookings'))).toBe(0)
    const ofA = await count('select count(*) n from clients where tmc_id = $1', [tmcA])
    expect(await as({ ...tenantA, tmcId: tmcA }, () => count('select count(*) n from clients'))).toBe(ofA)
  })
})
