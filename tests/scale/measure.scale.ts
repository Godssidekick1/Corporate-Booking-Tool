import { describe, it, beforeAll, expect } from 'vitest'
import { writeFileSync } from 'node:fs'
import pg from 'pg'
import { GET as clientsGet } from '@/app/api/tmc/clients/route'
import { GET as bucketsGet } from '@/app/api/tmc/buckets/route'
import { GET as dealCodesGet } from '@/app/api/tmc/deal-codes/route'
import { GET as dealCoverageGet } from '@/app/api/tmc/deal-codes/effective/route'
import { GET as ruleCoverageGet } from '@/app/api/tmc/commercial-rules/effective/route'
import { GET as fopsGet } from '@/app/api/tmc/forms-of-payment/route'
import { GET as fopMappingGet } from '@/app/api/tmc/fop-assignments/route'
import { stampDealCodes } from '@/app/lib/deal-codes/stampBooking'
import { stampFop } from '@/app/lib/fop/stampFop'
import { loadCommercialContext } from '@/app/lib/commercials/stampCommercials'
import { db, transaction } from '@/app/lib/db'
import { computeDealCoverage } from '@/app/lib/coverage/dealCoverage'
import { todayIso } from '@/app/lib/coverage/freshness'
import * as coverage from '@/app/lib/repositories/coverage'
import { sql, one, exec } from '@/app/lib/db/sql'
import { call } from '../harness/call'
import { actors, type Actors } from '../harness/actors'
import { seedScale, sizesFromEnv } from './seed'

// ── npm run scale: measurements ──────────────────────────────────────────────
// Times what grows with a TMC's size: the admin lists and coverage reports,
// and the lookups every pricing request makes for one traveller's client.
// Each is run once to warm up, then RUNS times; the median is reported with
// the number of database queries one call makes.
//
// EACH HAS A BUDGET, AND THE RUN FAILS OVER IT. "It will cope at this size" is
// then a checked claim rather than a reading of a table: an endpoint that
// starts scanning a whole TMC again shows up as a failure, not a slow day.
//
// Results print as a table and are written to tests/scale/last-run.md
// (git-ignored) so a before/after can be compared.
// ─────────────────────────────────────────────────────────────────────────────

const RUNS = Number(process.env.SCALE_RUNS ?? 5)

// Every query the app makes goes through pg.Client#query (the pool lends
// clients), so counting there counts them all.
let queries = 0
const original = pg.Client.prototype.query
pg.Client.prototype.query = function (this: pg.Client, ...args: unknown[]) {
  queries++
  return (original as (...a: unknown[]) => unknown).apply(this, args)
} as typeof original

interface Result { name: string; ms: number; budget: number; queries: number; detail: string }
const results: Result[] = []

async function measure(name: string, budget: number, run: () => Promise<string>) {
  await run()
  const times: number[] = []
  let detail = ''
  let perCall = 0
  for (let i = 0; i < RUNS; i++) {
    queries = 0
    const t0 = performance.now()
    detail = await run()
    times.push(performance.now() - t0)
    perCall = queries
  }
  times.sort((a, b) => a - b)
  results.push({ name, ms: Math.round(times[Math.floor(times.length / 2)]), budget, queries: perCall, detail })
}

describe('scale', () => {
  let a: Actors
  let clientId: string
  let volumes: Record<string, number>

  beforeAll(async () => {
    a = await actors()
    const t0 = performance.now()
    volumes = await seedScale(process.env.DATABASE_URL!, a.tmcAdmin.tmc_id!, sizesFromEnv())
    console.info(`[scale] seeded in ${Math.round((performance.now() - t0) / 1000)} s`)
    // The scale client most deal codes reach directly: a realistic heavy case.
    clientId = (await one<{ id: string }>(db, sql`
      select c.id from clients c join deal_code_assignments d on d.client_id = c.id
      where c.name like 'Scale client %' group by c.id order by count(*) desc, c.id limit 1`)).id
  })

  it('measures', async () => {
    // The per-minute limits would refuse a measurement loop; this measures
    // the endpoint, not the limiter.
    const admin = (url: string, handler: unknown) => async () => {
      await exec(db, sql`delete from rate_limits`)
      const res = await call(handler, { as: a.tmcAdmin, url })
      if (res.status !== 200) throw new Error(`${url} -> ${res.status} ${JSON.stringify(res.json).slice(0, 200)}`)
      const json = res.json as { total?: number; items?: unknown[] }
      return `total ${json.total ?? '?'}, ${JSON.stringify(json).length.toLocaleString('en-IN')} bytes`
    }

    // Budgets: a list page a person waits on, 300 ms; a booking-time lookup,
    // which every pricing request makes, 50 ms; rebuilding a stored coverage
    // report, which only the first read after a change pays, 5 s.
    await measure('Clients list (page 1)', 300, admin('/api/tmc/clients?page=1', clientsGet))
    await measure('Buckets list (page 1)', 300, admin('/api/tmc/buckets?page=1', bucketsGet))
    await measure('Deal codes list (page 1)', 300, admin('/api/tmc/deal-codes?page=1', dealCodesGet))
    await measure('Deal code coverage (page 1)', 300, admin('/api/tmc/deal-codes/effective?page=1', dealCoverageGet))
    await measure('Deal code coverage, search', 300, admin('/api/tmc/deal-codes/effective?search=scale%20client%2099', dealCoverageGet))
    await measure('Deal code coverage, page 500', 300, admin('/api/tmc/deal-codes/effective?page=500', dealCoverageGet))
    await measure('Commercial coverage, markup (page 1)', 300, admin('/api/tmc/commercial-rules/effective?page=1&kind=markup', ruleCoverageGet))
    await measure('Commercial coverage, search', 300, admin('/api/tmc/commercial-rules/effective?search=scale%20client%2099', ruleCoverageGet))

    // The first read after a change rebuilds the report.
    const someDeal = (await one<{ id: string }>(db, sql`
      select id from deal_codes where tmc_id = ${a.tmcAdmin.tmc_id} order by id limit 1`)).id
    let bump = 0
    await measure('Deal code coverage, first read after a change', 5_000, async () => {
      await exec(db, sql`update deal_codes set notes = ${'scale ' + bump++} where id = ${someDeal}`)
      return admin('/api/tmc/deal-codes/effective?page=1', dealCoverageGet)()
    })
    const someRule = (await one<{ id: string }>(db, sql`
      select id from commercial_rules where tmc_id = ${a.tmcAdmin.tmc_id} order by id limit 1`)).id
    await measure('Commercial coverage, first read after a change', 5_000, async () => {
      await exec(db, sql`update commercial_rules set notes = ${'scale ' + bump++} where id = ${someRule}`)
      return admin('/api/tmc/commercial-rules/effective?page=1', ruleCoverageGet)()
    })

    // The deal code rebuild in its two halves, so a slow rebuild says which
    // half to look at. Stored against the current counter, so the report is
    // still current afterwards.
    const tmcId = a.tmcAdmin.tmc_id!
    let built: Awaited<ReturnType<typeof computeDealCoverage>> = []
    await measure('  rebuild part 1: resolve every client', 5_000, async () => {
      built = await computeDealCoverage(db, tmcId, todayIso())
      return `${built.length} rows, ${JSON.stringify(built).length.toLocaleString('en-IN')} bytes`
    })
    await measure('  rebuild part 2: store the rows', 5_000, async () => {
      const f = await coverage.freshness(db, tmcId, 'deal_codes')
      await transaction(tx => coverage.replaceDealCoverage(tx, tmcId, built, f.changes, todayIso()))
      return `${built.length} rows`
    })

    // Twenty people searching at once, against one pool: what a busy desk
    // does to the report, all requests in flight together.
    await measure('20 coverage searches at once (all done)', 1_500, async () => {
      await exec(db, sql`delete from rate_limits`)
      const all = await Promise.all(Array.from({ length: 20 }, (_, i) =>
        call(dealCoverageGet, { as: a.tmcAdmin, url: `/api/tmc/deal-codes/effective?search=scale%20client%20${i + 1}` })))
      const failed = all.filter(r => r.status !== 200)
      if (failed.length) throw new Error(`${failed.length} of 20 failed: ${failed[0].status}`)
      return '20 x 200'
    })

    await measure('Forms of payment list (page 1)', 300, admin('/api/tmc/forms-of-payment?page=1', fopsGet))
    await measure('FOP mapping list (page 1)', 300, admin('/api/tmc/fop-assignments?page=1', fopMappingGet))

    // What every pricing / add-passenger request does for the traveller's client.
    await measure('Booking: deal codes for one client', 50, async () => `${(await stampDealCodes(db, clientId, null))?.length ?? 0} codes`)
    await measure('Booking: payment method for one client', 50, async () => `${(await stampFop(db, clientId, null))?.label ?? 'none'}`)
    await measure('Booking: commercials for one client', 50, async () => {
      const ctx = await loadCommercialContext(db, clientId)
      return `${ctx.rules.length} rules, ${ctx.assignments.length} assignments`
    })

    const lines = [
      `# Scale run ${new Date().toISOString()}`,
      '',
      'Volumes (this TMC): ' + Object.entries(volumes).map(([k, v]) => `${k} ${v.toLocaleString('en-IN')}`).join(' · '),
      '',
      `| What | Median ms (${RUNS} runs) | Budget ms | Queries | Result |`,
      '|---|---:|---:|---:|---|',
      ...results.map(r => `| ${r.name} | ${r.ms}${r.ms > r.budget ? ' **OVER**' : ''} | ${r.budget} | ${r.queries} | ${r.detail} |`),
      '',
      // Peak resident memory of the whole process over the run: a server
      // holding a whole report in memory per request is what this would show.
      `Peak memory (RSS) over the run: ${Math.round(process.resourceUsage().maxRSS / 1024)} MB`,
    ]
    writeFileSync('tests/scale/last-run.md', lines.join('\n') + '\n')
    console.info('\n' + lines.join('\n'))
    expect(results.filter(r => r.ms > r.budget).map(r => `${r.name}: ${r.ms} ms > ${r.budget} ms`)).toEqual([])
  })
})
