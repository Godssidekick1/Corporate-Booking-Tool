import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import pg from 'pg'
import { POST as signin } from '@/app/api/auth/signin/route'
import { POST as challenge } from '@/app/api/auth/signin/challenge/route'
import { sealSecret } from '@/app/lib/auth/sealClient'
import { fromBase64, type SealChallenge, type SealedSecret } from '@/app/lib/auth/sealProtocol'
import { hashPassword } from '@/app/lib/auth/password'
import { db } from '@/app/lib/db'
import { sql, exec } from '@/app/lib/db/sql'
import { actors, type Actor } from '../harness/actors'
import { resetDatabase } from '../harness/db'
import { testOwnerUrl } from '../harness/testDatabase'

// ── The sealed password (user, 2026-11-19; PCI DSS 8.3.2) ────────────────────
// The sign-in request carries the password encrypted to a one-off key the
// server issued moments earlier (app/lib/auth/sealed.ts). Proven here: it
// signs in; the request never holds the password; a captured request cannot
// be replayed; it opens only for its own email, unaltered, within two
// minutes; plain text is refused; the key endpoint is rate-limited.
// ─────────────────────────────────────────────────────────────────────────────

const HAS_DB = Boolean(process.env.DATABASE_URL)
const d = HAS_DB ? describe : describe.skip

const PASSWORD = 'correct horse battery'
let ipSeq = 0

function post(handler: (req: NextRequest, ctx: unknown) => Promise<Response>, url: string, body: unknown, ip = '198.51.100.7') {
  return handler(new NextRequest(new URL(url, 'http://localhost'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify(body),
  }), { params: Promise.resolve({}) })
}

// As the owner: the sign-in tables answer to the system scope only.
async function asOwner(text: string, values: unknown[] = []): Promise<pg.QueryResult> {
  const c = new pg.Client({ connectionString: testOwnerUrl() })
  await c.connect()
  try { return await c.query(text, values) } finally { await c.end() }
}

d('sealed sign-in', () => {
  let person: Actor

  async function fresh(): Promise<SealChallenge> {
    const res = await post(challenge, '/api/auth/signin/challenge', {}, `203.0.113.${++ipSeq}`)
    expect(res.status).toBe(200)
    return res.json() as Promise<SealChallenge>
  }
  const signInWith = (email: string, sealed: unknown) => post(signin, '/api/auth/signin', { email, sealed })

  beforeAll(async () => {
    await resetDatabase()
    const a = await actors()
    person = a.employee ?? a.corpAdmin
    await exec(db, sql`insert into accounts (id, email) values (${person.id}, ${person.email!.toLowerCase()}) on conflict do nothing`)
    await exec(db, sql`update accounts set password_hash = ${await hashPassword(PASSWORD)}, must_change_password = false where id = ${person.id}`)
  })
  beforeEach(async () => { await exec(db, sql`delete from auth_attempts`) })

  it('a challenge: a one-off P-256 public key, valid two minutes, never cached', async () => {
    const res = await post(challenge, '/api/auth/signin/challenge', {}, '203.0.113.200')
    expect(res.headers.get('cache-control')).toBe('no-store')
    const c = await res.json() as SealChallenge
    expect(c.challengeId).toMatch(/^[0-9a-f-]{36}$/)
    expect(c.expiresIn).toBe(120)
    expect(fromBase64(c.serverKey)).toHaveLength(65)   // an uncompressed P-256 point
    expect(c).not.toHaveProperty('privateKey')
  })

  it('signs in, and the request never holds the password', async () => {
    const sealed = await sealSecret(PASSWORD, person.email!, await fresh())
    const body = JSON.stringify({ email: person.email, sealed })
    expect(body).not.toContain(PASSWORD)
    expect(body).not.toContain(Buffer.from(PASSWORD).toString('base64'))
    const res = await signInWith(person.email!, sealed)
    expect(res.status).toBe(200)
    expect(res.headers.getSetCookie().join(';')).toContain('cbt_session')
  })

  it('a captured request cannot be replayed: the challenge opens once', async () => {
    const sealed = await sealSecret(PASSWORD, person.email!, await fresh())
    expect((await signInWith(person.email!, sealed)).status).toBe(200)
    const again = await signInWith(person.email!, sealed)
    expect(again.status).toBe(400)
    expect(await again.json()).toEqual({ error: 'The sign-in form expired. Please try again.', code: 'SIGNIN_EXPIRED' })
    expect(again.headers.getSetCookie().join(';')).not.toContain('cbt_session')
  })

  it('a wrong password is still the ordinary 401, and spends the challenge', async () => {
    const sealed = await sealSecret('not it', person.email!, await fresh())
    expect((await signInWith(person.email!, sealed)).status).toBe(401)
    expect((await signInWith(person.email!, sealed)).status).toBe(400)
  })

  it('it opens only for the email it was sealed with', async () => {
    const sealed = await sealSecret(PASSWORD, 'someone.else@example.test', await fresh())
    const res = await signInWith(person.email!, sealed)
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ code: 'SIGNIN_EXPIRED', error: 'Could not read the sign-in details. Please try again.' })
  })

  it('a changed byte is refused (AES-GCM), and so is a malformed seal', async () => {
    const sealed = await sealSecret(PASSWORD, person.email!, await fresh()) as SealedSecret
    const bytes = fromBase64(sealed.data)
    bytes[0] ^= 1
    const tampered = { ...sealed, data: Buffer.from(bytes).toString('base64') }
    expect((await signInWith(person.email!, tampered)).status).toBe(400)
    for (const bad of [{ v: 1 }, { ...sealed, challengeId: 'not-a-uuid' }, { ...sealed, v: 2 }, 'text']) {
      expect((await signInWith(person.email!, bad)).status).toBe(400)
    }
  })

  it('an expired challenge is refused', async () => {
    const c = await fresh()
    await asOwner(`update signin_challenges set expires_at = now() - interval '1 second' where id = $1`, [c.challengeId])
    const res = await signInWith(person.email!, await sealSecret(PASSWORD, person.email!, c))
    expect(await res.json()).toEqual({ error: 'The sign-in form expired. Please try again.', code: 'SIGNIN_EXPIRED' })
  })

  it('a plain-text password is refused', async () => {
    const res = await post(signin, '/api/auth/signin', { email: person.email, password: PASSWORD })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Please refresh the page and sign in again.', code: 'SIGNIN_NOT_SEALED' })
    expect(res.headers.getSetCookie().join(';')).not.toContain('cbt_session')
  })

  it('the private half stays on the server', async () => {
    const c = await fresh()
    const row = await asOwner(`select private_key from signin_challenges where id = $1`, [c.challengeId])
    expect(row.rows[0].private_key).toHaveProperty('d')        // the JWK's private scalar
    // No tenant query sees it: tests/security/rowLevelSecurity.test.ts (SIGN_IN).
  })

  it('the key endpoint is rate-limited per IP', async () => {
    const ip = '203.0.113.250'
    for (let i = 0; i < 30; i++) expect((await post(challenge, '/api/auth/signin/challenge', {}, ip)).status).toBe(200)
    const over = await post(challenge, '/api/auth/signin/challenge', {}, ip)
    expect(over.status).toBe(429)
    expect(over.headers.get('retry-after')).toBeTruthy()
  })
})
