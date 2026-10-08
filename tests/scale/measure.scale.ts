import { describe, it, beforeAll } from 'vitest'
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
import { db } from '@/app/lib/db'
import { sql, one } from '@/app/lib/db/sql'
import { call } from '../harness/call'
import { actors, type Actors } from '../harness/actors'
import { seedScale, sizesFromEnv } from './seed'

// ── npm run scale: measurements ──────────────────────────────────────────────
// Times what grows with a TMC's size: the admin lists and coverage reports,
// and the lookups every pricing request makes for one traveller's client.
// Each is run once to warm up, then RUNS times; the median is reported with
// the number of database queries one call makes.
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

interface Result { name: string; ms: number; queries: number; detail: string }
const results: Result[] = []

async function measure(name: string, run: () => Promise<string>) {
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
  results.push({ name, ms: Math.round(times[Math.floor(times.length / 2)]), queries: perCall, detail })
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
    const admin = (url: string, handler: unknown) => async () => {
      const res = await call(handler, { as: a.tmcAdmin, url })
      if (res.status !== 200) throw new Error(`${url} -> ${res.status} ${JSON.stringify(res.json).slice(0, 200)}`)
      const json = res.json as { total?: number; items?: unknown[] }
      return `total ${json.total ?? '?'}, ${JSON.stringify(json).length.toLocaleString('en-IN')} bytes`
    }

    await measure('Clients list (page 1)', admin('/api/tmc/clients?page=1', clientsGet))
    await measure('Buckets list (page 1)', admin('/api/tmc/buckets?page=1', bucketsGet))
    await measure('Deal codes list (page 1)', admin('/api/tmc/deal-codes?page=1', dealCodesGet))
    await measure('Deal code coverage (page 1)', admin('/api/tmc/deal-codes/effective?page=1', dealCoverageGet))
    await measure('Commercial coverage, markup (page 1)', admin('/api/tmc/commercial-rules/effective?page=1&kind=markup', ruleCoverageGet))
    await measure('Forms of payment list (page 1)', admin('/api/tmc/forms-of-payment?page=1', fopsGet))
    await measure('FOP mapping list (page 1)', admin('/api/tmc/fop-assignments?page=1', fopMappingGet))

    // What every pricing / add-passenger request does for the traveller's client.
    await measure('Booking: deal codes for one client', async () => `${(await stampDealCodes(db, clientId, null))?.length ?? 0} codes`)
    await measure('Booking: payment method for one client', async () => `${(await stampFop(db, clientId, null))?.label ?? 'none'}`)
    await measure('Booking: commercials for one client', async () => {
      const ctx = await loadCommercialContext(db, clientId)
      return `${ctx.rules.length} rules, ${ctx.assignments.length} assignments`
    })

    const lines = [
      `# Scale run ${new Date().toISOString()}`,
      '',
      'Volumes (this TMC): ' + Object.entries(volumes).map(([k, v]) => `${k} ${v.toLocaleString('en-IN')}`).join(' · '),
      '',
      `| What | Median ms (${RUNS} runs) | Queries | Result |`,
      '|---|---:|---:|---|',
      ...results.map(r => `| ${r.name} | ${r.ms} | ${r.queries} | ${r.detail} |`),
    ]
    writeFileSync('tests/scale/last-run.md', lines.join('\n') + '\n')
    console.info('\n' + lines.join('\n'))
  })
})
