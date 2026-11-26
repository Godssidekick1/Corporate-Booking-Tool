import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest'
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { GET, PUT } from '@/app/api/platform/provider/route'
import { POST as testConnection } from '@/app/api/platform/provider/test/route'
import { providerCredentials, forgetProviderCredentials } from '@/app/lib/amadeus/credentials'
import { call } from '../harness/call'
import { actors, type Actors } from '../harness/actors'
import { resetDatabase } from '../harness/db'
import { testOwnerUrl } from '../harness/testDatabase'

// ── Flight provider credentials in the database (user, 2026-11-26) ──────────
// One row, set by a platform admin; the password sealed with a key kept
// outside the database, and never returned. Proven here: only a platform
// admin reaches it; bad input is refused with what to fix; the password is
// stored encrypted and never comes back; the client then uses the saved
// account (and only falls back to the environment while none is saved); the
// save is audited without the secret; "test the connection" signs in with
// what was typed and saves nothing.
// ─────────────────────────────────────────────────────────────────────────────

const HAS_DB = Boolean(process.env.DATABASE_URL)
const d = HAS_DB ? describe : describe.skip

async function asOwner(text: string, values: unknown[] = []): Promise<pg.QueryResult> {
  const c = new pg.Client({ connectionString: testOwnerUrl() })
  await c.connect()
  try { return await c.query(text, values) } finally { await c.end() }
}

const GOOD = { baseUrl: 'https://provider.example.test/api', clientCode: 'ARR001', username: 'desk-user', password: 'Pr0vider-Secret!' }

d('flight provider credentials', () => {
  let a: Actors
  let admin: { id: string }

  beforeAll(async () => {
    await resetDatabase()
    a = await actors()
    admin = { id: a.platformAdmin!.id }
    process.env.PROVIDER_CREDENTIALS_KEY = randomBytes(32).toString('base64')
  })
  afterEach(() => { vi.unstubAllGlobals(); forgetProviderCredentials() })

  it('only a platform admin reaches it: signed out 401, a TMC admin 404', async () => {
    expect((await call(GET, { url: '/api/platform/provider' })).status).toBe(401)
    expect((await call(GET, { as: a.tmcAdmin, url: '/api/platform/provider' })).status).toBe(404)
    expect((await call(PUT, { as: a.tmcAdmin, method: 'PUT', url: '/api/platform/provider', body: GOOD })).status).toBe(404)
  })

  it('before anything is saved it says the environment is in use', async () => {
    const res = await call(GET, { as: admin, url: '/api/platform/provider' })
    expect(res.status).toBe(200)
    expect((res.json as { provider: { source: string } }).provider.source).toBe('environment')
  })

  it('refuses bad input with what to fix, and a first save without a password', async () => {
    const put = (body: object) => call(PUT, { as: admin, method: 'PUT', url: '/api/platform/provider', body })
    expect(await put({ ...GOOD, baseUrl: 'ftp://x' })).toMatchObject({ status: 400 })
    expect(await put({ ...GOOD, baseUrl: 'http://provider.example.test' })).toMatchObject({ status: 400, json: { error: expect.stringMatching(/https/) } })
    expect(await put({ ...GOOD, clientCode: '' })).toMatchObject({ status: 400 })
    expect(await put({ ...GOOD, password: undefined })).toMatchObject({ status: 400, json: { error: expect.stringMatching(/password/i) } })
  })

  it('saves; the password is sealed at rest and never returned; the client then uses the saved account', async () => {
    const res = await call(PUT, { as: admin, method: 'PUT', url: '/api/platform/provider', body: GOOD })
    expect(res.status).toBe(200)
    expect(JSON.stringify(res.json)).not.toContain(GOOD.password)
    expect(res.json).toMatchObject({ provider: { source: 'database', baseUrl: GOOD.baseUrl, clientCode: 'ARR001', username: 'desk-user', passwordSet: true } })

    const row = (await asOwner('select password_sealed from provider_credentials')).rows[0]
    expect(row.password_sealed).toMatch(/^v1\.[0-9a-f]{8}\./)
    expect(row.password_sealed).not.toContain(GOOD.password)

    const got = await call(GET, { as: admin, url: '/api/platform/provider' })
    expect(JSON.stringify(got.json)).not.toContain(GOOD.password)
    expect(JSON.stringify(got.json)).not.toContain(row.password_sealed)

    expect(await providerCredentials()).toEqual({ ...GOOD, source: 'database' })
  })

  it('a later save may keep the saved password, and is audited without any secret', async () => {
    const res = await call(PUT, { as: admin, method: 'PUT', url: '/api/platform/provider', body: { ...GOOD, username: 'desk-user-2', password: '' } })
    expect(res.status).toBe(200)
    const creds = await providerCredentials()
    expect(creds).toMatchObject({ username: 'desk-user-2', password: GOOD.password })

    const audit = (await asOwner(`select metadata from audit_log where action = 'platform.provider_credentials_saved' order by created_at desc limit 1`)).rows[0]
    expect(audit.metadata).toMatchObject({ username_changed: true, password_changed: false })
    expect(JSON.stringify(audit.metadata)).not.toContain(GOOD.password)
  })

  it('a wrong key is reported as such, not as a broken password', async () => {
    const keep = process.env.PROVIDER_CREDENTIALS_KEY
    process.env.PROVIDER_CREDENTIALS_KEY = randomBytes(32).toString('base64')
    try {
      await expect(providerCredentials()).rejects.toThrow(/different PROVIDER_CREDENTIALS_KEY/)
    } finally { process.env.PROVIDER_CREDENTIALS_KEY = keep }
  })

  it('test the connection: signs in with what was typed (saved password when none typed), saves nothing', async () => {
    const seen: { url: string; body: { UserName: string; Password: string } }[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body))
      seen.push({ url, body })
      const ok = body.Password === GOOD.password
      return new Response(JSON.stringify(ok ? { status: 'Success', sessionID: 'S1' } : { status: 'Failure', error: { description: 'Invalid credentials' } }), { status: 200 })
    }))
    const typed = await call(testConnection, { as: admin, method: 'POST', url: '/api/platform/provider/test', body: { ...GOOD, baseUrl: 'https://other.example.test/' } })
    expect(typed.json).toMatchObject({ ok: true })
    expect(seen[0].url).toBe('https://other.example.test/flight/Authenticate')

    const wrong = await call(testConnection, { as: admin, method: 'POST', url: '/api/platform/provider/test', body: { ...GOOD, password: 'nope' } })
    expect(wrong.json).toEqual({ ok: false, message: 'The provider refused the sign-in: Invalid credentials' })

    const saved = await call(testConnection, { as: admin, method: 'POST', url: '/api/platform/provider/test', body: { ...GOOD, password: '' } })
    expect(saved.json).toMatchObject({ ok: true })
    expect(seen.at(-1)!.body.Password).toBe(GOOD.password)
    // Nothing saved by testing.
    expect((await asOwner('select base_url from provider_credentials')).rows[0].base_url).toBe(GOOD.baseUrl)
    expect((await call(testConnection, { as: a.tmcAdmin, method: 'POST', url: '/api/platform/provider/test', body: GOOD })).status).toBe(404)
  })
})
