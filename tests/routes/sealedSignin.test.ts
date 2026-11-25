import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import pg from 'pg'
import { POST as signin } from '@/app/api/auth/signin/route'
import { POST as challenge } from '@/app/api/auth/signin/challenge/route'
import { sealCredentials } from '@/app/lib/auth/sealClient'
import { fromBase64, type SealChallenge, type SealedSecret } from '@/app/lib/auth/sealProtocol'
import { hashPassword } from '@/app/lib/auth/password'
import { db } from '@/app/lib/db'
import { sql, exec } from '@/app/lib/db/sql'
import { actors, type Actor } from '../harness/actors'
import { resetDatabase } from '../harness/db'
import { testOwnerUrl } from '../harness/testDatabase'

// ── The sealed sign-in (user, 2026-11-19/20; PCI DSS 8.3.2) ──────────────────
// The request carries one blob: the email and password, padded to a fixed
// size and encrypted to a one-off key the server issued moments earlier
// (app/lib/auth/sealed.ts). Proven here: it signs in; the request holds
// nothing readable and is the same size whatever the password; a captured
// request cannot be replayed, and its key is gone from the database the moment
// it is used; it opens only with its own challenge, unaltered, within two
// minutes; plain text is refused; bad seals and the key endpoint are throttled.
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
const challengeRows = async (id: string) => (await asOwner(`select count(*)::int as n from signin_challenges where id = $1`, [id])).rows[0].n as number

d('sealed sign-in', () => {
  let person: Actor
  let email: string

  async function fresh(): Promise<SealChallenge> {
    const res = await post(challenge, '/api/auth/signin/challenge', {}, `203.0.113.${++ipSeq}`)
    expect(res.status).toBe(200)
    return res.json() as Promise<SealChallenge>
  }
  const seal = async (password = PASSWORD, who = email, c?: SealChallenge) => sealCredentials({ email: who, password }, c ?? await fresh())
  const signInWith = (sealed: unknown, ip?: string) => post(signin, '/api/auth/signin', { sealed }, ip)

  beforeAll(async () => {
    await resetDatabase()
    const a = await actors()
    person = a.employee ?? a.corpAdmin
    email = person.email!
    await exec(db, sql`insert into accounts (id, email) values (${person.id}, ${email.toLowerCase()}) on conflict do nothing`)
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
    expect(Object.keys(c).sort()).toEqual(['challengeId', 'expiresIn', 'serverKey'])
  })

  it('signs in; the request holds nothing readable, neither the password nor the email', async () => {
    const sealed = await seal()
    const body = JSON.stringify({ sealed })
    for (const secret of [PASSWORD, email, email.toLowerCase()]) {
      expect(body).not.toContain(secret)
      expect(body).not.toContain(Buffer.from(secret).toString('base64'))
    }
    const res = await signInWith(sealed)
    expect(res.status).toBe(200)
    expect(res.headers.getSetCookie().join(';')).toContain('cbt_session')
  })

  it('every seal is the same size, whatever the password or email', async () => {
    const short = await seal('a1b2c3d4e5', 'a@b.co')
    const long = await seal('ॐ'.repeat(256), `${'x'.repeat(240)}@example.test`)   // the longest allowed, 3 bytes a character
    expect(short.data.length).toBe(long.data.length)
    // One size for every form since v3 (2026-11-25): room for two longest passwords.
    expect(fromBase64(short.data)).toHaveLength(2048 + 16)
  })

  it('a captured request cannot be replayed, and its key is gone from the database once used', async () => {
    const sealed = await seal() as SealedSecret
    expect(await challengeRows(sealed.challengeId)).toBe(1)
    expect((await signInWith(sealed)).status).toBe(200)
    expect(await challengeRows(sealed.challengeId)).toBe(0)        // deleted, private key and all
    const again = await signInWith(sealed)
    expect(again.status).toBe(400)
    expect(await again.json()).toEqual({ error: 'The sign-in form expired. Please try again.', code: 'SIGNIN_EXPIRED' })
    expect(again.headers.getSetCookie().join(';')).not.toContain('cbt_session')
  })

  it('a wrong password is still the ordinary 401, and spends the challenge', async () => {
    const sealed = await seal('not it') as SealedSecret
    expect((await signInWith(sealed)).status).toBe(401)
    expect(await challengeRows(sealed.challengeId)).toBe(0)
    expect((await signInWith(sealed)).status).toBe(400)
  })

  it('a seal opens only with its own challenge: moved to another, it is refused (and both are spent)', async () => {
    const mine = await seal() as SealedSecret
    const other = await fresh()
    const moved = { ...mine, challengeId: other.challengeId }
    const res = await signInWith(moved)
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ code: 'SIGNIN_EXPIRED', error: 'Could not read the sign-in details. Please try again.' })
    expect(await challengeRows(other.challengeId)).toBe(0)
  })

  it('a changed byte is refused, and so is anything malformed or of the old version', async () => {
    const sealed = await seal() as SealedSecret
    const bytes = fromBase64(sealed.data)
    bytes[100] ^= 1
    expect((await signInWith({ ...sealed, data: Buffer.from(bytes).toString('base64') })).status).toBe(400)
    const fresh2 = await seal() as SealedSecret
    for (const bad of [
      { v: 2 }, 'text', { ...fresh2, v: 1 }, { ...fresh2, challengeId: 'not-a-uuid' },
      { ...fresh2, data: fresh2.data.slice(4) }, { ...fresh2, iv: 'AAAA' },
    ]) {
      expect((await signInWith(bad)).status, JSON.stringify(bad).slice(0, 40)).toBe(400)
    }
  })

  it('an expired challenge is refused, and expired keys are cleared when the next challenge is made', async () => {
    const c = await fresh()
    const sealed = await seal(PASSWORD, email, c)
    await asOwner(`update signin_challenges set expires_at = now() - interval '1 second' where id = $1`, [c.challengeId])
    expect(await (await signInWith(sealed)).json()).toEqual({ error: 'The sign-in form expired. Please try again.', code: 'SIGNIN_EXPIRED' })

    const stale = await fresh()
    await asOwner(`update signin_challenges set expires_at = now() - interval '1 second' where id = $1`, [stale.challengeId])
    await fresh()
    expect(await challengeRows(stale.challengeId)).toBe(0)
    expect((await asOwner(`select count(*)::int as n from signin_challenges where expires_at <= now()`)).rows[0].n).toBe(0)
  })

  it('a plain-text password is refused, and an empty body asks for the details', async () => {
    const res = await post(signin, '/api/auth/signin', { email, password: PASSWORD })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Please refresh the page and sign in again.', code: 'SIGNIN_NOT_SEALED' })
    expect(res.headers.getSetCookie().join(';')).not.toContain('cbt_session')
    expect(await (await post(signin, '/api/auth/signin', {})).json()).toMatchObject({ code: 'SIGNIN_MISSING' })
  })

  it('the private half stays on the server while the challenge is live', async () => {
    const c = await fresh()
    const row = await asOwner(`select private_key from signin_challenges where id = $1`, [c.challengeId])
    expect(row.rows[0].private_key).toHaveProperty('d')        // the JWK's private scalar
    // No tenant query sees it: tests/security/rowLevelSecurity.test.ts (SIGN_IN).
  })

  it('seals that cannot be opened count against the IP, like wrong passwords', async () => {
    const ip = '203.0.113.240'
    const junk = { v: 2, challengeId: '00000000-0000-4000-8000-000000000000', clientKey: 'AAAA', iv: 'AAAAAAAAAAAAAAAA', data: 'A'.repeat(1732) }
    for (let i = 0; i < 30; i++) expect((await signInWith(junk, ip)).status).toBe(400)
    const blocked = await signInWith(await seal(), ip)
    expect(blocked.status).toBe(429)
  })

  it('the key endpoint is rate-limited per IP', async () => {
    const ip = '203.0.113.250'
    for (let i = 0; i < 30; i++) expect((await post(challenge, '/api/auth/signin/challenge', {}, ip)).status).toBe(200)
    const over = await post(challenge, '/api/auth/signin/challenge', {}, ip)
    expect(over.status).toBe(429)
    expect(over.headers.get('retry-after')).toBeTruthy()
  })
})
