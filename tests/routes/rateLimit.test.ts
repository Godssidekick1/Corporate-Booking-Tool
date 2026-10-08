import { describe, it, expect, beforeAll } from 'vitest'
import { GET as ticketGet } from '@/app/api/public/ticket/[token]/route'
import { rateLimited, PER_MINUTE } from '@/app/lib/http/rateLimit'
import { call } from '../harness/call'
import { resetDatabase } from '../harness/db'
import { db } from '@/app/lib/db'
import { sql, exec } from '@/app/lib/db/sql'

// ── Rate limits ──────────────────────────────────────────────────────────────
// Expensive and public endpoints are limited per minute; the limit is shared
// across a key, separate between keys, and answered with 429 + Retry-After.
// ─────────────────────────────────────────────────────────────────────────────

const HAS_DB = Boolean(process.env.DATABASE_URL)
const d = HAS_DB ? describe : describe.skip

d('rate limits', () => {
  beforeAll(async () => {
    await resetDatabase()
  })

  it('allows up to the limit in a minute, then answers 429 with Retry-After', async () => {
    await exec(db, sql`delete from rate_limits`)
    for (let i = 0; i < PER_MINUTE.csv; i++) expect(await rateLimited('csv', 'user-a')).toBeNull()
    const refused = await rateLimited('csv', 'user-a')
    expect(refused?.status).toBe(429)
    expect(Number(refused?.headers.get('Retry-After'))).toBeGreaterThan(0)
    expect(await refused?.json()).toEqual({ error: 'Too many requests. Please wait a moment and try again.' })
    // Someone else, or another kind of limit, is counted separately.
    expect(await rateLimited('csv', 'user-b')).toBeNull()
    expect(await rateLimited('search', 'user-a')).toBeNull()
  })

  it('an unidentified caller is not lumped into one shared bucket', async () => {
    for (let i = 0; i < PER_MINUTE.csv + 5; i++) expect(await rateLimited('csv', null)).toBeNull()
  })

  it('the public ticket link is limited per IP', async () => {
    await exec(db, sql`delete from rate_limits`)
    const get = (ip: string) => call(ticketGet, {
      url: '/api/public/ticket/00000000000000000000000000000000',
      params: { token: '00000000000000000000000000000000' },
      headers: { 'x-forwarded-for': ip },
    })
    for (let i = 0; i < PER_MINUTE.ticket; i++) expect((await get('203.0.113.7')).status).toBe(404)
    expect((await get('203.0.113.7')).status).toBe(429)
    expect((await get('203.0.113.8')).status).toBe(404)
  })
})
