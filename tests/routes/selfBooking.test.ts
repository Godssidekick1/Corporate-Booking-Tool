import { describe, it, expect, beforeAll, vi } from 'vitest'
import { POST as searchPost } from '@/app/api/book/search/route'
import { POST as pricePost } from '@/app/api/book/price/route'
import { POST as addPassengerPost } from '@/app/api/book/add-passenger/route'
import { POST as seatmapPost } from '@/app/api/book/seatmap/route'
import { POST as policyPreviewPost } from '@/app/api/book/policy-preview/route'
import { POST as bookPost } from '@/app/api/book/booking/route'
import { POST as ticketPost } from '@/app/api/book/ticket/route'
import { GET as tripsGet, POST as tripsPost } from '@/app/api/trips/route'
import { GET as bookingsGet } from '@/app/api/bookings/route'
import { GET as meGet } from '@/app/api/me/route'
import { SELF_BOOKING_OFF } from '@/app/lib/clients/clientGates'
import { call } from '../harness/call'
import { actors, type Actors } from '../harness/actors'
import { resetDatabase } from '../harness/db'
import { db } from '@/app/lib/db'
import { sql, one, exec } from '@/app/lib/db/sql'

// ── Who may book for themselves ──────────────────────────────────────────────
// Everyone has a login, but at a CBT-only client the travel desk books on the
// employees' behalf: they sign in to see their trips, bookings and approvals,
// and every step that would book something is refused (clientGates.selfBooking).
//
// The airline client is replaced by one that fails the test if touched: a
// refusal must come before any provider call.
// ─────────────────────────────────────────────────────────────────────────────

const amadeusCalls = vi.fn()

vi.mock('@/app/lib/amadeus/client', async orig => {
  const actual = await orig<typeof import('@/app/lib/amadeus/client')>()
  return {
    ...actual,
    amadeus: new Proxy({}, {
      get: (_t, name) => (...args: unknown[]) => {
        amadeusCalls(name, ...args)
        throw new Error(`Amadeus.${String(name)} must not be called`)
      },
    }),
  }
})

const HAS_DB = Boolean(process.env.DATABASE_URL)
const d = HAS_DB ? describe : describe.skip

d('self-booking', () => {
  let a: Actors
  let clientId: string
  let owner: { id: string }
  let bookingId: string

  const setMode = (mode: string) => exec(db, sql`update clients set booking_mode = ${mode} where id = ${clientId}`)
  const post = (handler: Parameters<typeof call>[0], url: string, body: unknown) =>
    call(handler, { as: owner, method: 'POST', url, body })

  beforeAll(async () => {
    await resetDatabase()
    a = await actors()
    clientId = a.corpAdmin.client_id!
    owner = { id: a.corpAdmin.id }
    bookingId = (await one<{ id: string }>(db, sql`
      select id from bookings where employee_id = ${owner.id} and status = 'held' order by created_at, id limit 1`)).id
  })

  it('a CBT-only client: every booking step and starting a trip are refused, before the airline', async () => {
    await setMode('cbt')
    const refused = { status: 403, json: { error: SELF_BOOKING_OFF } }

    expect(await post(searchPost, '/api/book/search',
      { origin: 'DEL', destination: 'BOM', departDate: '10/11/2030', tripType: 'oneway' })).toEqual(refused)
    expect(await post(pricePost, '/api/book/price', { key: 'K', pricingKey: 'PK', provider: 'p', resultIndex: '1' })).toEqual(refused)
    expect(await post(seatmapPost, '/api/book/seatmap', { key: 'K', referenceNo: '1', provider: 'p' })).toEqual(refused)
    expect(await post(policyPreviewPost, '/api/book/policy-preview', {})).toEqual(refused)
    expect(await post(addPassengerPost, '/api/book/add-passenger', {})).toEqual(refused)
    expect(await post(bookPost, '/api/book/booking', { bookingId })).toEqual(refused)
    expect(await post(ticketPost, '/api/book/ticket', { bookingId })).toEqual(refused)
    expect(await post(tripsPost, '/api/trips', { name: 'Offsite' })).toEqual(refused)

    expect(amadeusCalls).not.toHaveBeenCalled()
  })

  it('a CBT-only client: what they already have still loads', async () => {
    await setMode('cbt')
    expect((await call(tripsGet, { as: owner, url: '/api/trips' })).status).toBe(200)
    expect((await call(bookingsGet, { as: owner, url: '/api/bookings' })).status).toBe(200)
    const me = await call(meGet, { as: owner, url: '/api/me' })
    expect((me.json as { canSelfBook: boolean }).canSelfBook).toBe(false)
  })

  it('self-booking and hybrid clients book for themselves', async () => {
    for (const mode of ['sbt', 'both']) {
      await setMode(mode)
      const me = await call(meGet, { as: owner, url: '/api/me' })
      expect((me.json as { canSelfBook: boolean }).canSelfBook).toBe(true)
      expect((await post(tripsPost, '/api/trips', { name: `Offsite ${mode}` })).status).toBe(200)
    }
  })

  it('TMC staff are never told they may self-book', async () => {
    const me = await call(meGet, { as: a.tmcAdmin, url: '/api/me' })
    expect((me.json as { canSelfBook: boolean }).canSelfBook).toBe(false)
  })
})
