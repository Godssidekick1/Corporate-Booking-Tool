import { describe, it, expect, beforeAll, vi } from 'vitest'
import { POST as activate } from '@/app/api/auth/activate/route'
import { POST as signin } from '@/app/api/auth/signin/route'
import { POST as verify } from '@/app/api/auth/verify/route'
import { call } from '../harness/call'
import { actors, type Actors } from '../harness/actors'
import { acceptSignInAs, signOutCount, actAs } from '../harness/session'
import { resetDatabase } from '../harness/db'
import { db } from '@/app/lib/db'
import { sql, exec, maybeOne } from '@/app/lib/db/sql'

// ── /api/auth/* ──────────────────────────────────────────────────────────────
// The database side of authentication: flipping invited -> active, refusing a
// sign-in for a deactivated client, and routing a verified user.
//
// /api/auth/verify builds its own Supabase client from @supabase/ssr (it has to
// set cookies during verifyOtp), so that one module is faked here too. The
// fake's getUser answers with whoever actAs() last set.
// ─────────────────────────────────────────────────────────────────────────────

vi.mock('next/headers', () => ({
  cookies: async () => ({ getAll: () => [], set: () => undefined }),
}))

vi.mock('@supabase/ssr', async () => {
  const s = await import('../harness/session')
  return {
    createServerClient: () => ({
      auth: {
        verifyOtp: async () => ({ error: null }),
        exchangeCodeForSession: async () => ({ error: null }),
        getUser: async () => s.currentSession(),
      },
    }),
  }
})

const HAS_DB = Boolean(process.env.DATABASE_URL)
const d = HAS_DB ? describe : describe.skip

const statusOf = async (id: string) =>
  (await maybeOne<{ status: string }>(db, sql`select status from employees where id = ${id}`))?.status

d('/api/auth', () => {
  let a: Actors

  beforeAll(async () => {
    await resetDatabase()
    a = await actors()
  })

  // ── activate ───────────────────────────────────────────────────────────────

  it('activate: 401 when signed out', async () => {
    const res = await call(activate, { method: 'POST', url: '/api/auth/activate' })
    expect(res.status).toBe(401)
  })

  it('activate: flips an invited employee to active', async () => {
    await exec(db, sql`update employees set status = 'invited' where id = ${a.employee!.id}`)
    const res = await call(activate, { as: a.employee, method: 'POST', url: '/api/auth/activate' })
    expect(res).toEqual({ status: 200, json: { ok: true } })
    expect(await statusOf(a.employee!.id)).toBe('active')
  })

  it('activate: leaves an already-active employee alone', async () => {
    const res = await call(activate, { as: a.employee, method: 'POST', url: '/api/auth/activate' })
    expect(res.status).toBe(200)
    expect(await statusOf(a.employee!.id)).toBe('active')
  })

  // ── signin ─────────────────────────────────────────────────────────────────

  it('signin: 400 without credentials', async () => {
    const res = await call(signin, { method: 'POST', url: '/api/auth/signin', body: {} })
    expect(res).toEqual({ status: 400, json: { error: 'email and password are required' } })
  })

  it('signin: 401 with the provider message on bad credentials', async () => {
    acceptSignInAs(null)
    const res = await call(signin, { method: 'POST', url: '/api/auth/signin', body: { email: 'x@example.test', password: 'no' } })
    expect(res).toEqual({ status: 401, json: { error: 'Invalid login credentials' } })
  })

  it('signin: TMC staff sign in (no client to check)', async () => {
    acceptSignInAs(a.tmcAdmin)
    const res = await call(signin, { method: 'POST', url: '/api/auth/signin', body: { email: 'x@example.test', password: 'p' } })
    expect(res.status).toBe(200)
    expect((res.json as { user: { id: string } }).user.id).toBe(a.tmcAdmin.id)
  })

  it('signin: refuses an employee of a DEACTIVATED client, and signs them back out', async () => {
    await exec(db, sql`update clients set status = 'inactive' where id = ${a.corpAdmin.client_id}`)
    acceptSignInAs(a.corpAdmin)
    const before = signOutCount()

    const res = await call(signin, { method: 'POST', url: '/api/auth/signin', body: { email: 'x@example.test', password: 'p' } })

    expect(res).toEqual({ status: 403, json: { error: 'This account is no longer active. Please contact your travel desk.' } })
    // The session GoTrue just issued must not survive the refusal.
    expect(signOutCount()).toBe(before + 1)
    await exec(db, sql`update clients set status = 'active' where id = ${a.corpAdmin.client_id}`)
  })

  it('signin: an employee of an active client signs in', async () => {
    acceptSignInAs(a.corpAdmin)
    const res = await call(signin, { method: 'POST', url: '/api/auth/signin', body: { email: 'x@example.test', password: 'p' } })
    expect(res.status).toBe(200)
  })

  // ── verify ─────────────────────────────────────────────────────────────────

  it('verify: 400 without a token or code', async () => {
    const res = await call(verify, { method: 'POST', url: '/api/auth/verify', body: { next: '/' } })
    expect(res).toEqual({ status: 400, json: { ok: false, error: 'Invalid confirmation link.' } })
  })

  it('verify: activates an invited employee and routes them to the dashboard', async () => {
    await exec(db, sql`update employees set status = 'invited' where id = ${a.employee!.id}`)
    actAs(a.employee)
    const res = await call(verify, {
      as: a.employee, method: 'POST', url: '/api/auth/verify',
      body: { tokenHash: 't', type: 'invite', next: '/' },
    })
    expect(res).toEqual({ status: 200, json: { ok: true, destination: '/dashboard' } })
    expect(await statusOf(a.employee!.id)).toBe('active')
  })

  it('verify: routes TMC staff to the TMC dashboard', async () => {
    const res = await call(verify, {
      as: a.tmcAdmin, method: 'POST', url: '/api/auth/verify',
      body: { code: 'c', next: '/' },
    })
    expect(res.json).toEqual({ ok: true, destination: '/tmc/dashboard' })
  })

  it('verify: honours an explicit next', async () => {
    const res = await call(verify, {
      as: a.tmcAdmin, method: 'POST', url: '/api/auth/verify',
      body: { code: 'c', next: '/tmc/clients' },
    })
    expect(res.json).toEqual({ ok: true, destination: '/tmc/clients' })
  })

  it('verify: a verified user with no employee profile goes to login with an error', async () => {
    const res = await call(verify, {
      as: { id: '00000000-0000-0000-0000-000000000009' }, method: 'POST', url: '/api/auth/verify',
      body: { code: 'c', next: '/' },
    })
    expect(res.json).toEqual({ ok: true, destination: '/login?error=no_profile' })
  })
})
