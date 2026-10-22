import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { GET as me } from '@/app/api/me/route'
import { GET as stats } from '@/app/api/tmc/stats/route'
import { call } from '../harness/call'
import { actors, type Actors } from '../harness/actors'
import { resetDatabase } from '../harness/db'

// ── GET /api/me and GET /api/tmc/stats ───────────────────────────────────────
// /api/me decides where the login page sends someone -- it is the route whose
// database failure once read as "Employee profile not found" and stranded every
// user on Vercel. /api/tmc/stats is the TMC dashboard's numbers.
// ─────────────────────────────────────────────────────────────────────────────

const HAS_DB = Boolean(process.env.DATABASE_URL)
const d = HAS_DB ? describe : describe.skip

interface StatsBody {
  clients: { clientId: string; bookings: number }[]
}

// Clients are sorted by booking count; ties came back in whatever order the
// database happened to return rows, which is arbitrary. Normalised so the
// snapshot records the real ordering rule, not an accident of heap layout.
function normaliseTies(body: StatsBody): StatsBody {
  return {
    ...body,
    clients: [...body.clients].sort((a, b) => b.bookings - a.bookings || a.clientId.localeCompare(b.clientId)),
  }
}

d('GET /api/me', () => {
  let a: Actors
  beforeAll(async () => {
    await resetDatabase()
    a = await actors()
  })

  it('401 when signed out', async () => {
    expect((await call(me, { url: '/api/me' })).status).toBe(401)
  })

  it('a corporate admin: profile and client', async () => {
    const res = await call(me, { as: a.corpAdmin, url: '/api/me' })
    expect(res.status).toBe(200)
    expect(res.json).toMatchSnapshot()
  })

  it('a tmc_admin: no client', async () => {
    const res = await call(me, { as: a.tmcAdmin, url: '/api/me' })
    expect(res.status).toBe(200)
    expect(res.json).toMatchSnapshot()
  })

  it('a tc: permissions and client access for the restricted view', async () => {
    const res = await call(me, { as: a.tc, url: '/api/me' })
    expect(res.status).toBe(200)
    // Both are SETS -- the frontend only ever asks .includes(). They used to
    // come back in physical row order (no ORDER BY), which is arbitrary, so
    // the snapshot records them sorted: the set is the behaviour, not the
    // order the heap happened to hold them in.
    const body = res.json as { permissions: string[]; clientAccess: string[] }
    expect({ ...body, permissions: [...body.permissions].sort(), clientAccess: [...body.clientAccess].sort() })
      .toMatchSnapshot()
  })

  it('a platform admin with no employees row is answered, not refused', async () => {
    const res = await call(me, { as: { id: a.platformAdmin!.id }, url: '/api/me' })
    expect(res.status).toBe(200)
    expect(res.json).toMatchSnapshot()
  })

  it('an ordinary user with no employees row is a real 404', async () => {
    const res = await call(me, { as: { id: '00000000-0000-0000-0000-00000000dead' }, url: '/api/me' })
    expect(res).toEqual({ status: 404, json: { error: 'Employee profile not found' } })
  })
})

d('GET /api/tmc/stats', () => {
  let a: Actors
  beforeAll(async () => {
    // "Last 30 days" and the weekly trend are relative to now; frozen so the
    // numbers are the same every day this test runs. Only Date is faked --
    // the connection pool's timers keep running.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-23T12:00:00Z'))
    a = await actors()
  })
  afterAll(() => { vi.useRealTimers() })

  it('401 when signed out', async () => {
    expect((await call(stats, { url: '/api/tmc/stats' })).status).toBe(401)
  })

  it('a corporate admin is refused', async () => {
    expect((await call(stats, { as: a.corpAdmin, url: '/api/tmc/stats' })).status).toBe(403)
  })

  // The snapshots were recorded when every number was counted in the server
  // from every booking row, and every client was sent. Counting moved into the
  // database and the client table is paged, so: every page is fetched and
  // joined, the fields paging added are checked against what the old code
  // derived from the full list, and what remains must match the old snapshot.
  type Full = StatsBody & {
    clients: { clientId: string; name: string; bookings: number }[]
    totals: Record<string, unknown> & { clients: number; maxBookings: number }
    page?: number; pageSize?: number; total?: number; totalPages?: number
  }
  async function wholePortfolio(as: { id: string }): Promise<StatsBody> {
    const first = (await call(stats, { as, url: '/api/tmc/stats' })).json as Full
    const clients = [...first.clients]
    for (let p = 2; p <= (first.totalPages ?? 1); p++) {
      clients.push(...((await call(stats, { as, url: `/api/tmc/stats?page=${p}` })).json as Full).clients)
    }
    expect(clients).toHaveLength(first.totals.clients)
    expect(first.total).toBe(first.totals.clients)
    const { busiest, quietest, dormant, ...totals } = first.totals
    const active = clients.filter(c => c.bookings > 0)
    expect(busiest).toEqual(clients[0] ? { name: clients[0].name, bookings: clients[0].bookings } : null)
    expect(quietest).toEqual(active.length ? { name: active[active.length - 1].name, bookings: active[active.length - 1].bookings } : null)
    expect(dormant).toBe(clients.length - active.length)
    const rest: Record<string, unknown> = { ...first, clients, totals }
    for (const added of ['page', 'pageSize', 'total', 'totalPages']) delete rest[added]
    return normaliseTies(rest as unknown as StatsBody)
  }

  it('a tmc_admin sees their whole portfolio', async () => {
    expect((await call(stats, { as: a.tmcAdmin, url: '/api/tmc/stats' })).status).toBe(200)
    expect(await wholePortfolio(a.tmcAdmin)).toMatchSnapshot()
  })

  it('a tc sees only the clients they were granted', async () => {
    expect((await call(stats, { as: a.tc!, url: '/api/tmc/stats' })).status).toBe(200)
    expect(await wholePortfolio(a.tc!)).toMatchSnapshot()
  })
})
