import { describe, it, expect, beforeAll } from 'vitest'
import { POST as dealCodesPost } from '@/app/api/tmc/deal-codes/route'
import { POST as fopsPost } from '@/app/api/tmc/forms-of-payment/route'
import { POST as tripsPost } from '@/app/api/trips/route'
import { call } from '../harness/call'
import { actors, type Actors } from '../harness/actors'
import { resetDatabase } from '../harness/db'
import { db } from '@/app/lib/db'
import { sql, one } from '@/app/lib/db/sql'

// ── Bad input is the caller's mistake, not the server's ──────────────────────
// Found by the write leak sweep (tests/security): these answered a request
// missing a required field, or from someone who cannot make one, with a 500
// -- a crash on `undefined.trim()`, a NOT NULL violation -- instead of saying
// what was wrong.
// ─────────────────────────────────────────────────────────────────────────────

const HAS_DB = Boolean(process.env.DATABASE_URL)
const d = HAS_DB ? describe : describe.skip

d('bad input gets a 4xx, not a 500', () => {
  let a: Actors
  let category: string
  beforeAll(async () => {
    await resetDatabase()
    a = await actors()
    category = (await one<{ id: string }>(db, sql`
      select id from deal_code_categories where tmc_id = ${a.tmcAdmin.tmc_id} and code = 'DOMAIRBSP'`)).id
  })

  const post = (handler: unknown, url: string, body: unknown, as = a.tmcAdmin) =>
    call(handler, { as, method: 'POST', url, body })

  it('deal code: each required field missing, or not text', async () => {
    const base = { category_id: category, airline_code: 'AI', code: 'TC123', code_type: 'TC' }
    for (const field of ['airline_code', 'code', 'code_type'] as const) {
      const missing: Record<string, unknown> = { ...base }
      delete missing[field]
      const res = await post(dealCodesPost, '/api/tmc/deal-codes', missing)
      expect([field, res.status]).toEqual([field, 400])
      const wrongType = await post(dealCodesPost, '/api/tmc/deal-codes', { ...base, [field]: 42 })
      expect([field, wrongType.status]).toEqual([field, 400])
    }
  })

  it('payment method: no label, or no payer', async () => {
    const type = await one<{ id: string }>(db, sql`
      select id from fop_payment_types where tmc_id = ${a.tmcAdmin.tmc_id} order by id limit 1`)
    const base = { label: 'Bad input test', payer: 'agency', payment_type_id: type.id }
    expect((await post(fopsPost, '/api/tmc/forms-of-payment', { ...base, label: undefined })).status).toBe(400)
    expect((await post(fopsPost, '/api/tmc/forms-of-payment', { ...base, label: 7 })).status).toBe(400)
    expect((await post(fopsPost, '/api/tmc/forms-of-payment', { ...base, payer: undefined })).status).toBe(400)
  })

  it('trip: TMC staff belong to no company, so cannot hold one', async () => {
    const res = await post(tripsPost, '/api/trips', { name: 'A trip' })
    expect(res.status).toBe(403)
    expect((await post(tripsPost, '/api/trips', { name: 7 }, a.corpAdmin)).status).toBe(400)
  })
})
