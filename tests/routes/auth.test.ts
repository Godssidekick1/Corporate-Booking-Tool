import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { POST as signin } from '@/app/api/auth/signin/route'
import { POST as signout } from '@/app/api/auth/signout/route'
import { POST as verify } from '@/app/api/auth/verify/route'
import { POST as forgot } from '@/app/api/auth/password/forgot/route'
import { POST as setPassword } from '@/app/api/auth/password/set/route'
import { POST as changePassword } from '@/app/api/auth/password/change/route'
import { GET as me } from '@/app/api/me/route'
import { proxy } from '@/proxy'
import { SESSION_COOKIE, principalForToken } from '@/app/lib/auth/session'
import { hashPassword } from '@/app/lib/auth/password'
import { MESSAGES } from '@/app/lib/auth/flows'
import { db } from '@/app/lib/db'
import { sql, exec, one } from '@/app/lib/db/sql'
import { call } from '../harness/call'
import { actAs } from '../harness/session'
import { actors, type Actors, type Actor } from '../harness/actors'
import { resetDatabase } from '../harness/db'
import { outbox, linkIn } from '../harness/mail'

// ── The auth endpoints and the page gate, over HTTP shapes ───────────────────
// tests/auth/flows.test.ts proves the rules. This proves what a browser sees:
// status codes, bodies, the cookie and its attributes, and where proxy.ts
// sends each kind of person.
// ─────────────────────────────────────────────────────────────────────────────

const HAS_DB = Boolean(process.env.DATABASE_URL)
const d = HAS_DB ? describe : describe.skip

const PASSWORD = 'correct horse battery'

function post(handler: (req: NextRequest, ctx: unknown) => Promise<Response>, url: string, body: unknown, headers: Record<string, string> = {}) {
  return handler(new NextRequest(new URL(url, 'http://localhost'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '192.0.2.10', ...headers },
    body: JSON.stringify(body),
  }), { params: Promise.resolve({}) })
}

// The session token a response set, if any.
function cookieFrom(res: Response): { value: string; attributes: string } | null {
  const header = res.headers.getSetCookie().find(c => c.startsWith(`${SESSION_COOKIE}=`))
  if (!header) return null
  const [pair, ...rest] = header.split(';')
  return { value: pair.slice(SESSION_COOKIE.length + 1), attributes: rest.join(';').toLowerCase() }
}

// A page request as a browser would make it, with or without the cookie.
function page(path: string, token?: string) {
  return proxy(new NextRequest(new URL(path, 'http://localhost'), {
    headers: token ? { cookie: `${SESSION_COOKIE}=${token}` } : {},
  }))
}
const location = (res: Response) => {
  const to = res.headers.get('location')
  return to ? new URL(to).pathname + new URL(to).search : null
}

async function withPassword(a: Actor, password = PASSWORD, mustChange = false): Promise<void> {
  await exec(db, sql`
    insert into accounts (id, email) values (${a.id}, ${a.email!.toLowerCase()}) on conflict do nothing`)
  await exec(db, sql`
    update accounts set password_hash = ${await hashPassword(password)}, must_change_password = ${mustChange}
    where id = ${a.id}`)
}

async function signedIn(a: Actor): Promise<string> {
  const res = await post(signin, '/api/auth/signin', { email: a.email, password: PASSWORD })
  if (res.status !== 200) throw new Error(`[tests] sign-in failed: ${res.status}`)
  return cookieFrom(res)!.value
}

d('/api/auth and the page gate', () => {
  let a: Actors
  let person: Actor

  beforeAll(async () => {
    await resetDatabase()
    a = await actors()
    person = a.employee ?? a.corpAdmin
    for (const x of [person, a.tmcAdmin, a.corpAdmin]) await withPassword(x)
  })
  beforeEach(async () => { await exec(db, sql`delete from auth_attempts`) })

  // ── signin ─────────────────────────────────────────────────────────────────

  it('signin: 400 without credentials, 401 on a wrong password', async () => {
    expect((await post(signin, '/api/auth/signin', {})).status).toBe(400)
    const bad = await post(signin, '/api/auth/signin', { email: person.email, password: 'nope' })
    expect(bad.status).toBe(401)
    expect(await bad.json()).toEqual({ error: MESSAGES.badCredentials })
    expect(cookieFrom(bad)).toBeNull()
  })

  it('signin: sets an HttpOnly, SameSite=Lax, path-wide session cookie that expires', async () => {
    const res = await post(signin, '/api/auth/signin', { email: person.email, password: PASSWORD })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      ok: true, user: { id: person.id, email: person.email!.toLowerCase() }, mustChangePassword: false, destination: '/dashboard',
    })
    const cookie = cookieFrom(res)!
    expect(cookie.value).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(cookie.attributes).toContain('httponly')
    expect(cookie.attributes).toContain('samesite=lax')
    expect(cookie.attributes).toContain('path=/')
    expect(cookie.attributes).toContain('expires=')
  })

  it("signin: refuses an employee of a deactivated client, and sets no cookie", async () => {
    await exec(db, sql`update clients set status = 'inactive' where id = ${person.client_id}`)
    try {
      const res = await post(signin, '/api/auth/signin', { email: person.email, password: PASSWORD })
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ error: MESSAGES.inactive })
      expect(cookieFrom(res)).toBeNull()
    } finally {
      await exec(db, sql`update clients set status = 'active' where id = ${person.client_id}`)
    }
  })

  it('signin: an admin-set password sends the person to replace it', async () => {
    await withPassword(a.corpAdmin, PASSWORD, true)
    const res = await post(signin, '/api/auth/signin', { email: a.corpAdmin.email, password: PASSWORD })
    expect(await res.json()).toMatchObject({ mustChangePassword: true, destination: '/auth/set-password' })
    await withPassword(a.corpAdmin)
  })

  it('signin: too many failures is a 429', async () => {
    for (let i = 0; i < 5; i++) await post(signin, '/api/auth/signin', { email: person.email, password: 'nope' })
    expect((await post(signin, '/api/auth/signin', { email: person.email, password: PASSWORD })).status).toBe(429)
  })

  // ── CSRF ───────────────────────────────────────────────────────────────────

  it('a write from another site is refused before the handler runs', async () => {
    const res = await post(signin, '/api/auth/signin', { email: person.email, password: PASSWORD },
      { 'sec-fetch-site': 'cross-site' })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'Cross-site request refused' })
    const byOrigin = await post(signin, '/api/auth/signin', { email: person.email, password: PASSWORD },
      { origin: 'https://evil.example', host: 'localhost' })
    expect(byOrigin.status).toBe(403)
    // Same origin, and a request from no browser at all, both pass.
    expect((await post(signin, '/api/auth/signin', { email: person.email, password: PASSWORD },
      { 'sec-fetch-site': 'same-origin' })).status).toBe(200)
    expect((await post(signin, '/api/auth/signin', { email: person.email, password: PASSWORD },
      { origin: 'http://localhost', host: 'localhost' })).status).toBe(200)
  })

  // ── signout ────────────────────────────────────────────────────────────────

  it('signout: ends the session server-side, clears the cookie, 303 to /login', async () => {
    const token = await signedIn(person)
    const res = await post(signout, '/api/auth/signout', {}, { cookie: `${SESSION_COOKIE}=${token}` })
    // The route reads the session through cookies(), which the harness serves
    // for the acting user. Act as nobody and end the real token directly.
    expect(res.status).toBe(303)
    expect(location(res)).toBe('/login')
    expect(res.headers.getSetCookie().join(';')).toMatch(new RegExp(`${SESSION_COOKIE}=;`))

    actAs(person)
    const through = await post(signout, '/api/auth/signout', {})
    expect(through.status).toBe(303)
    const ended = await one<{ n: number }>(db, sql`
      select count(*)::int as n from sessions where account_id = ${person.id} and revoked_reason = 'signed_out'`)
    expect(ended.n).toBeGreaterThan(0)
  })

  // ── forgot / verify / set ──────────────────────────────────────────────────

  it('forgot: the same answer for any address; a real one gets a link', async () => {
    const unknown = await post(forgot, '/api/auth/password/forgot', { email: 'nobody@example.test' })
    const known = await post(forgot, '/api/auth/password/forgot', { email: person.email })
    expect(unknown.status).toBe(200)
    expect(await unknown.json()).toEqual(await known.json())
    expect(outbox.map(m => m.to)).toEqual([person.email!.toLowerCase()])
  })

  it('verify inspects a link without spending it; set spends it and signs in', async () => {
    await post(forgot, '/api/auth/password/forgot', { email: person.email })
    const { token } = linkIn(outbox.at(-1)!)

    expect(await (await post(verify, '/api/auth/verify', { token })).json())
      .toEqual({ ok: true, email: person.email!.toLowerCase(), purpose: 'reset' })
    // Still good after being looked at, as many times as a scanner likes.
    expect((await post(verify, '/api/auth/verify', { token })).status).toBe(200)

    const weak = await post(setPassword, '/api/auth/password/set', { token, password: 'password1' })
    expect(weak.status).toBe(400)

    const done = await post(setPassword, '/api/auth/password/set', { token, password: 'a brand new passphrase' })
    expect(done.status).toBe(200)
    expect(await done.json()).toEqual({ ok: true, destination: '/dashboard' })
    expect(await principalForToken(cookieFrom(done)!.value)).toMatchObject({ id: person.id })

    const again = await post(verify, '/api/auth/verify', { token })
    expect(again.status).toBe(400)
    expect(await again.json()).toEqual({ ok: false, error: MESSAGES.badLink })
    await withPassword(person)
  })

  it('verify: a malformed or unknown token is a 400, not an error', async () => {
    for (const token of [undefined, '', 'x', 'A'.repeat(43), { $ne: null }]) {
      expect((await post(verify, '/api/auth/verify', { token })).status).toBe(400)
    }
  })

  // ── change ─────────────────────────────────────────────────────────────────

  it('change: 401 signed out, 403 on a wrong current password, then a fresh cookie', async () => {
    expect((await call(changePassword, { method: 'POST', url: '/api/auth/password/change', body: {} })).status).toBe(401)
    expect(await call(changePassword, {
      as: person, method: 'POST', url: '/api/auth/password/change',
      body: { currentPassword: 'wrong', newPassword: 'a whole new passphrase' },
    })).toEqual({ status: 403, json: { error: MESSAGES.wrongCurrent } })

    actAs(person)
    const res = await post(changePassword, '/api/auth/password/change',
      { currentPassword: PASSWORD, newPassword: 'a whole new passphrase' })
    expect(res.status).toBe(200)
    expect(cookieFrom(res)!.value).toMatch(/^[A-Za-z0-9_-]{43}$/)
    await withPassword(person)
  })

  // ── Any route, deactivated mid-session (finding 1) ─────────────────────────

  it('a deactivated employee is signed out of every API route at their next request', async () => {
    expect((await call(me, { as: person, url: '/api/me' })).status).toBe(200)
    await exec(db, sql`update employees set status = 'deactivated' where id = ${person.id}`)
    try {
      expect(await call(me, { as: person, url: '/api/me' })).toEqual({ status: 401, json: { error: 'Not authenticated' } })
    } finally {
      await exec(db, sql`update employees set status = 'active' where id = ${person.id}`)
    }
  })

  // ── proxy.ts ───────────────────────────────────────────────────────────────

  it('proxy: signed out, a protected page goes to /login with where they were going', async () => {
    expect(location(await page('/dashboard'))).toBe('/login?next=%2Fdashboard')
    expect(location(await page('/login'))).toBeNull()
    expect(location(await page('/auth/confirm'))).toBeNull()
  })

  it('proxy: the role comes from the database, so a corporate employee cannot open /tmc', async () => {
    const token = await signedIn(person)
    expect(location(await page('/tmc/dashboard', token))).toBe('/dashboard')
    expect(location(await page('/login', token))).toBe('/dashboard')
    const staff = await signedIn(a.tmcAdmin)
    expect(location(await page('/tmc/dashboard', staff))).toBeNull()
    expect(location(await page('/login', staff))).toBe('/tmc/dashboard')
  })

  it('proxy: an admin-set password is replaced before anything else (finding 3)', async () => {
    await withPassword(a.corpAdmin, PASSWORD, true)
    const token = await signedIn(a.corpAdmin)
    expect(location(await page('/dashboard', token))).toBe('/auth/set-password')
    expect(location(await page('/auth/set-password', token))).toBeNull()
    await withPassword(a.corpAdmin)
  })

  it('proxy: an unfinished first-login profile comes first, for corporate people only', async () => {
    await exec(db, sql`update employees set first_login_completed = false where id = ${person.id}`)
    try {
      const token = await signedIn(person)
      expect(location(await page('/bookings', token))).toBe('/profile?first=1')
      expect(location(await page('/profile', token))).toBeNull()
    } finally {
      await exec(db, sql`update employees set first_login_completed = true where id = ${person.id}`)
    }
  })

  it('proxy: a deactivated person is treated as signed out', async () => {
    const token = await signedIn(person)
    await exec(db, sql`update employees set status = 'deactivated' where id = ${person.id}`)
    try {
      expect(location(await page('/dashboard', token))).toBe('/login?next=%2Fdashboard')
    } finally {
      await exec(db, sql`update employees set status = 'active' where id = ${person.id}`)
    }
  })
})
