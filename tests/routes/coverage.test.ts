import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { GET as dealCoverageGet } from '@/app/api/tmc/deal-codes/effective/route'
import { GET as ruleCoverageGet } from '@/app/api/tmc/commercial-rules/effective/route'
import { call } from '../harness/call'
import { actors, type Actors } from '../harness/actors'
import { resetDatabase } from '../harness/db'
import { db } from '@/app/lib/db'
import { sql, one, exec } from '@/app/lib/db/sql'

// ── Stored coverage reports stay current ─────────────────────────────────────
// The coverage screens read a stored report that is rebuilt when it is out of
// date (app/lib/coverage). The risk in storing anything derived is that it
// goes stale, so this file writes to every table the reports are computed
// from, the way the app would, and checks the very next read reflects it --
// plus the one change with no write at all (the date), concurrent first
// reads, and that one TMC's writes leave another's report alone.
// ─────────────────────────────────────────────────────────────────────────────

const HAS_DB = Boolean(process.env.DATABASE_URL)
const d = HAS_DB ? describe : describe.skip

interface DealRow { clientId: string; clientName: string; airline: string; codeType: string; code: string; via: string }
interface Paged<T> { items: T[]; total: number; totalPages: number }

d('stored coverage reports', () => {
  let a: Actors
  let tmcId: string
  let clientId: string
  let category: string
  let deal: string

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-23T12:00:00Z'))
    await resetDatabase()
    a = await actors()
    tmcId = a.tmcAdmin.tmc_id!
    clientId = (await one<{ id: string }>(db, sql`
      select id from clients where tmc_id = ${tmcId} order by name, id limit 1`)).id
    category = (await one<{ id: string }>(db, sql`
      select id from deal_code_categories where tmc_id = ${tmcId} and code = 'DOMAIRBSP'`)).id
    // A code no template row uses, so searching for it finds only this test's rows.
    deal = (await one<{ id: string }>(db, sql`
      insert into deal_codes (tmc_id, category_id, airline_code, code, code_type, active)
      values (${tmcId}, ${category}, 'ZZ', 'COVTEST1', 'TC', true) returning id`)).id
  })
  afterAll(() => { vi.useRealTimers() })

  const deals = async (query: string, as = a.tmcAdmin) => {
    const res = await call(dealCoverageGet, { as, url: `/api/tmc/deal-codes/effective${query}` })
    expect(res.status).toBe(200)
    return res.json as Paged<DealRow>
  }
  const ours = async () => (await deals('?search=COVTEST1')).items

  it('an assignment shows on the next read, and its removal too', async () => {
    expect(await ours()).toEqual([])
    const assignment = (await one<{ id: string }>(db, sql`
      insert into deal_code_assignments (tmc_id, deal_code_id, kind, client_id)
      values (${tmcId}, ${deal}, 'client', ${clientId}) returning id`)).id
    expect((await ours()).map(r => [r.clientId, r.via])).toEqual([[clientId, 'Direct assignment']])
    await exec(db, sql`delete from deal_code_assignments where id = ${assignment}`)
    expect(await ours()).toEqual([])
  })

  it('through a bucket: joining, renaming the bucket and leaving it all show', async () => {
    const bucket = (await one<{ id: string }>(db, sql`
      insert into buckets (tmc_id, name) values (${tmcId}, 'Coverage test bucket') returning id`)).id
    await exec(db, sql`
      insert into deal_code_assignments (tmc_id, deal_code_id, kind, bucket_id)
      values (${tmcId}, ${deal}, 'bucket', ${bucket})`)
    expect(await ours()).toEqual([])                       // the bucket is empty

    await exec(db, sql`insert into bucket_clients (bucket_id, client_id) values (${bucket}, ${clientId})`)
    expect((await ours()).map(r => r.via)).toEqual(['Bucket · Coverage test bucket'])

    await exec(db, sql`update buckets set name = 'Renamed bucket' where id = ${bucket}`)
    expect((await ours()).map(r => r.via)).toEqual(['Bucket · Renamed bucket'])
    // Searching by the route finds what the bucket hands out.
    expect((await deals('?search=renamed bucket')).items.map(r => r.code)).toEqual(['COVTEST1'])

    await exec(db, sql`delete from bucket_clients where bucket_id = ${bucket} and client_id = ${clientId}`)
    expect(await ours()).toEqual([])
    await exec(db, sql`insert into bucket_clients (bucket_id, client_id) values (${bucket}, ${clientId})`)
  })

  it('renaming the client and switching the deal off both show', async () => {
    const before = (await one<{ name: string }>(db, sql`select name from clients where id = ${clientId}`)).name
    await exec(db, sql`update clients set name = 'Zz Coverage Renamed' where id = ${clientId}`)
    expect((await ours()).map(r => r.clientName)).toEqual(['Zz Coverage Renamed'])
    await exec(db, sql`update clients set name = ${before} where id = ${clientId}`)

    await exec(db, sql`update deal_codes set active = false where id = ${deal}`)
    expect(await ours()).toEqual([])
    await exec(db, sql`update deal_codes set active = true where id = ${deal}`)
    expect(await ours()).toHaveLength(1)
  })

  it('a deal whose sales window closed drops off the next day, with nothing written', async () => {
    await exec(db, sql`update deal_codes set sales_to = '2026-09-23' where id = ${deal}`)
    expect(await ours()).toHaveLength(1)
    vi.setSystemTime(new Date('2026-09-24T12:00:00Z'))
    try {
      expect(await ours()).toEqual([])
    } finally {
      vi.setSystemTime(new Date('2026-09-23T12:00:00Z'))
    }
    await exec(db, sql`update deal_codes set sales_to = null where id = ${deal}`)
  })

  it('concurrent reads of a stale report build it once and agree', async () => {
    await exec(db, sql`update deal_codes set notes = 'bump' where id = ${deal}`)
    // Without the build lock, two builders insert the same (tmc_id, ord) and
    // one fails on the primary key.
    const results = await Promise.all(Array.from({ length: 6 }, () => deals('?page=2')))
    for (const r of results) expect(r).toEqual(results[0])
    const state = await one<{ changes: number; built: number }>(db, sql`
      select deal_codes_changes as changes, deal_codes_built_from as built from coverage_state where tmc_id = ${tmcId}`)
    expect(state.built).toBe(state.changes)
  })

  it('keeps the five closest losers and counts the rest', async () => {
    // Seven deals for one airline and type, all assigned to the client: one
    // winner (the newest), six losers.
    for (let i = 1; i <= 7; i++) {
      const id = (await one<{ id: string }>(db, sql`
        insert into deal_codes (tmc_id, category_id, airline_code, code, code_type, active, created_at)
        values (${tmcId}, ${category}, 'ZY', ${'COVLOSE' + i}, 'TC', true, ${`2026-01-0${i}T00:00:00Z`})
        returning id`)).id
      await exec(db, sql`
        insert into deal_code_assignments (tmc_id, deal_code_id, kind, client_id)
        values (${tmcId}, ${id}, 'client', ${clientId})`)
    }
    const [row] = (await deals('?search=COVLOSE7')).items as (DealRow & { beat: { code: string }[]; beatMore: number })[]
    expect(row.code).toBe('COVLOSE7')
    expect(row.beat.map(b => b.code)).toEqual(['COVLOSE6', 'COVLOSE5', 'COVLOSE4', 'COVLOSE3', 'COVLOSE2'])
    expect(row.beatMore).toBe(1)
  })

  it('search is literal and paging is in SQL', async () => {
    expect((await deals('?search=%25')).items).toEqual([])     // "%" is not a wildcard
    const all = await deals('')
    const second = await deals('?page=2')
    expect(second.total).toBe(all.total)
    if (all.total > 10) expect(second.items[0]).not.toEqual(all.items[0])
  })

  it('another TMC\'s writes leave this TMC\'s report alone', async () => {
    const theirs = a.otherTmcAdmin!.tmc_id!
    const counter = async () => (await one<{ n: number }>(db, sql`
      select deal_codes_changes as n from coverage_state where tmc_id = ${tmcId}`)).n
    const before = await counter()
    const theirCategory = (await one<{ id: string }>(db, sql`
      select id from deal_code_categories where tmc_id = ${theirs} and code = 'DOMAIRBSP'`)).id
    await exec(db, sql`
      insert into deal_codes (tmc_id, category_id, airline_code, code, code_type, active)
      values (${theirs}, ${theirCategory}, 'ZZ', 'THEIRS1', 'TC', true)`)
    expect(await counter()).toBe(before)
    // And their report never contains this TMC's rows.
    const res = await call(dealCoverageGet, { as: a.otherTmcAdmin!, url: '/api/tmc/deal-codes/effective?search=COVTEST1' })
    expect((res.json as Paged<DealRow>).items).toEqual([])
  })

  it('a counsellor sees only the clients they are assigned', async () => {
    if (!a.tc) return
    const tcId = a.tc.id
    await exec(db, sql`
      insert into employee_permissions (employee_id, permission_key) values (${tcId}, 'manage_deal_codes')
      on conflict do nothing`)
    const other = (await one<{ id: string }>(db, sql`
      select id from clients where tmc_id = ${tmcId} and id <> ${clientId} order by name, id limit 1`)).id
    await exec(db, sql`delete from employee_client_access where employee_id = ${tcId}`)
    await exec(db, sql`insert into employee_client_access (employee_id, client_id) values (${tcId}, ${other})`)
    const seen = await deals('', a.tc)
    expect(seen.items.every(r => r.clientId === other)).toBe(true)
    expect((await deals('?search=COVTEST1', a.tc)).items).toEqual([])   // assigned to clientId only
  })

  // ── Commercials ────────────────────────────────────────────────────────────

  interface RuleRow { clientId: string; switchedOff: string[]; markup: string | null }
  const ruleRows = async (query = '') => {
    const res = await call(ruleCoverageGet, { as: a.tmcAdmin, url: `/api/tmc/commercial-rules/effective${query}` })
    expect(res.status).toBe(200)
    return res.json as Paged<RuleRow> & { lossMakingCount: number }
  }

  it('commercials: the client\'s switches and the rules\' rates show on the next read', async () => {
    const name = (await one<{ name: string }>(db, sql`select name from clients where id = ${clientId}`)).name
    const mine = async () =>
      (await ruleRows(`?search=${encodeURIComponent(name)}`)).items.find(r => r.clientId === clientId)!

    expect((await mine()).switchedOff).toEqual([])
    await exec(db, sql`update clients set markup_active = false where id = ${clientId}`)
    expect((await mine()).switchedOff).toEqual(['markup'])
    await exec(db, sql`update clients set markup_active = true where id = ${clientId}`)
    expect((await mine()).switchedOff).toEqual([])

    const before = JSON.stringify(await ruleRows('?kind=markup'))
    await exec(db, sql`update commercial_rules set rate = rate + 1 where tmc_id = ${tmcId} and kind = 'markup'`)
    expect(JSON.stringify(await ruleRows('?kind=markup'))).not.toEqual(before)
  })
})
