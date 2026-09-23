import { describe, it, expect, beforeAll } from 'vitest'
import { GET } from '@/app/api/reference/airlines/route'
import { call } from '../harness/call'
import { actors, type Actors } from '../harness/actors'
import { resetDatabase } from '../harness/db'

// ── GET /api/reference/airlines ──────────────────────────────────────────────
// Characterisation: recorded while the route ran on the shim, and required to
// pass unchanged once it runs on the reference repository.
// ─────────────────────────────────────────────────────────────────────────────

const HAS_DB = Boolean(process.env.DATABASE_URL)
const d = HAS_DB ? describe : describe.skip

d('GET /api/reference/airlines', () => {
  let a: Actors

  beforeAll(async () => {
    await resetDatabase()
    a = await actors()
  })

  it('401 when signed out', async () => {
    const res = await call(GET, { url: '/api/reference/airlines' })
    expect(res.status).toBe(401)
    expect(res.json).toEqual({ error: 'Not authenticated' })
  })

  it('first page, any signed-in user', async () => {
    const res = await call(GET, { as: a.employee ?? a.corpAdmin, url: '/api/reference/airlines' })
    expect(res.status).toBe(200)
    expect(res.json).toMatchSnapshot()
  })

  it('second page', async () => {
    const res = await call(GET, { as: a.tmcAdmin, url: '/api/reference/airlines?page=2' })
    expect(res.status).toBe(200)
    expect(res.json).toMatchSnapshot()
  })

  it('search matches code or name, case-insensitively', async () => {
    const res = await call(GET, { as: a.tmcAdmin, url: '/api/reference/airlines?search=ai' })
    expect(res.status).toBe(200)
    expect(res.json).toMatchSnapshot()
  })

  it('search strips the characters PostgREST could not escape', async () => {
    // "air, (india)" must behave as "air india" rather than change the filter.
    const res = await call(GET, { as: a.tmcAdmin, url: '/api/reference/airlines?search=' + encodeURIComponent('air, (india)') })
    expect(res.status).toBe(200)
    expect(res.json).toMatchSnapshot()
  })

  it('?ids= resolves specific codes, upper-cased, unpaged', async () => {
    const res = await call(GET, { as: a.tmcAdmin, url: '/api/reference/airlines?ids=ai,6E,ZZ' })
    expect(res.status).toBe(200)
    expect(res.json).toMatchSnapshot()
  })

  it('a page past the end is empty, not an error', async () => {
    const res = await call(GET, { as: a.tmcAdmin, url: '/api/reference/airlines?page=99' })
    expect(res.status).toBe(200)
    expect(res.json).toMatchSnapshot()
  })
})
