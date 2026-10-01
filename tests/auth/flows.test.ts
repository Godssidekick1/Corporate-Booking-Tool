import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import bcrypt from 'bcryptjs'
import { db } from '@/app/lib/db'
import { sql, one, many, exec, maybeOne } from '@/app/lib/db/sql'
import { transaction } from '@/app/lib/db/transaction'
import { closePool } from '@/app/lib/db/pool'
import * as flows from '@/app/lib/auth/flows'
import { principalForToken } from '@/app/lib/auth/session'
import { hashPassword } from '@/app/lib/auth/password'
import { resetDatabase } from '../harness/db'
import { actors, type Actor } from '../harness/actors'
import { outbox, linkIn, lastMailTo, failNextMailWith } from '../harness/mail'

// ── The authentication flows, against real rows ──────────────────────────────
// Every rule the auth layer promises, proven on cbt_test: who may sign in,
// when a session stops working, what a link may do once and only once, and
// that none of it leaks which addresses have accounts.
// ─────────────────────────────────────────────────────────────────────────────

const HAS_DB = Boolean(process.env.DATABASE_URL)
const d = HAS_DB ? describe : describe.skip

const PASSWORD = 'correct horse battery'
const meta = { ip: '203.0.113.7', userAgent: 'vitest' }

let person: Actor
let staff: Actor

async function setPassword(id: string, password: string, mustChange = false): Promise<void> {
  await exec(db, sql`
    update accounts set password_hash = ${await hashPassword(password)}, must_change_password = ${mustChange}
    where id = ${id}`)
}

// Every actor used here gets an account (the template has one only for people
// whose employees row carried an auth_user_id).
async function ensureAccount(a: Actor): Promise<void> {
  await exec(db, sql`
    insert into accounts (id, email) values (${a.id}, ${a.email!.toLowerCase()}) on conflict do nothing`)
}

async function signedIn(a: Actor): Promise<string> {
  const r = await flows.signIn(a.email, PASSWORD, meta)
  if (!r.ok) throw new Error(`[tests] sign-in failed: ${r.error}`)
  return r.token
}

d('auth flows', () => {
  beforeAll(async () => {
    await resetDatabase()
    const a = await actors()
    person = a.employee ?? a.corpAdmin
    staff = a.tmcAdmin
    for (const x of [person, staff]) {
      await ensureAccount(x)
      await setPassword(x.id, PASSWORD)
    }
  })
  afterAll(async () => { await closePool() })
  beforeEach(async () => { await exec(db, sql`delete from auth_attempts`) })

  // ── Signing in ─────────────────────────────────────────────────────────────

  it('signs in with the right password, and the session resolves to the person', async () => {
    const r = await flows.signIn(person.email!.toUpperCase(), PASSWORD, meta)
    expect(r).toMatchObject({ ok: true, accountId: person.id, mustChangePassword: false, destination: '/dashboard' })
    if (!r.ok) return
    expect(r.token).toMatch(/^[A-Za-z0-9_-]{43}$/)

    const me = await principalForToken(r.token)
    expect(me).toMatchObject({ id: person.id, employee: { role: person.role, clientId: person.client_id } })

    // Only the token's hash is stored.
    expect(await maybeOne(db, sql`select 1 from sessions where id = ${r.token}`)).toBeNull()
  })

  it('TMC staff land on the TMC dashboard', async () => {
    expect(await flows.signIn(staff.email, PASSWORD, meta)).toMatchObject({ ok: true, destination: '/tmc/dashboard' })
  })

  it('a wrong password and an unknown address get the same answer', async () => {
    const wrong = await flows.signIn(person.email, 'not the password', meta)
    const unknown = await flows.signIn('nobody@example.test', PASSWORD, meta)
    expect(wrong).toEqual({ ok: false, status: 401, error: flows.MESSAGES.badCredentials })
    expect(unknown).toEqual(wrong)
  })

  it('five failures lock the address, even against the right password, and an unknown address alike', async () => {
    for (let i = 0; i < 5; i++) await flows.signIn(person.email, `wrong ${i}`, meta)
    expect(await flows.signIn(person.email, PASSWORD, meta)).toMatchObject({ ok: false, status: 429 })

    for (let i = 0; i < 5; i++) await flows.signIn('ghost@example.test', `wrong ${i}`, meta)
    expect(await flows.signIn('ghost@example.test', PASSWORD, meta)).toMatchObject({ ok: false, status: 429 })
  })

  it('one IP is limited across addresses', async () => {
    const from = { ip: '198.51.100.1', userAgent: 'x' }
    for (let i = 0; i < 30; i++) await flows.signIn(`user${i}@example.test`, 'wrong password', from)
    expect(await flows.signIn(person.email, PASSWORD, from)).toMatchObject({ ok: false, status: 429 })
    // Another IP is unaffected.
    expect(await flows.signIn(person.email, PASSWORD, meta)).toMatchObject({ ok: true })
  })

  it('a success clears the address count', async () => {
    for (let i = 0; i < 4; i++) await flows.signIn(person.email, 'wrong password', meta)
    expect(await flows.signIn(person.email, PASSWORD, meta)).toMatchObject({ ok: true })
    for (let i = 0; i < 4; i++) await flows.signIn(person.email, 'wrong password', meta)
    expect(await flows.signIn(person.email, PASSWORD, meta)).toMatchObject({ ok: true })
  })

  it('an imported Supabase bcrypt hash signs in, and is replaced with argon2id', async () => {
    await exec(db, sql`update accounts set password_hash = ${bcrypt.hashSync(PASSWORD, 4)} where id = ${person.id}`)
    expect(await flows.signIn(person.email, 'not it', meta)).toMatchObject({ ok: false, status: 401 })
    expect(await flows.signIn(person.email, PASSWORD, meta)).toMatchObject({ ok: true })
    const { password_hash } = await one<{ password_hash: string }>(db, sql`select password_hash from accounts where id = ${person.id}`)
    expect(password_hash.startsWith('$argon2id$')).toBe(true)
    expect(await flows.signIn(person.email, PASSWORD, meta)).toMatchObject({ ok: true })
  })

  it('an account with no password yet (invite not accepted) cannot sign in', async () => {
    const { accountId } = await transaction(async tx => {
      const r = await flows.createAccount(tx, 'pending.invite@example.test', { createdBy: staff.id })
      await flows.sendInvite(tx, r.accountId, staff.id)
      return r
    })
    expect(await flows.signIn('pending.invite@example.test', '', meta)).toMatchObject({ status: 400 })
    expect(await flows.signIn('pending.invite@example.test', 'anything at all', meta))
      .toEqual({ ok: false, status: 401, error: flows.MESSAGES.badCredentials })
    await exec(db, sql`delete from accounts where id = ${accountId}`)
  })

  // ── Deactivation (finding 1) ───────────────────────────────────────────────

  it('a deactivated employee cannot sign in, and their live session stops working at once', async () => {
    const token = await signedIn(person)
    expect(await principalForToken(token)).not.toBeNull()

    await exec(db, sql`update employees set status = 'deactivated' where id = ${person.id}`)
    try {
      expect(await principalForToken(token)).toBeNull()
      expect(await flows.signIn(person.email, PASSWORD, meta)).toEqual({ ok: false, status: 403, error: flows.MESSAGES.inactive })
      // Revoked, not merely refused: reactivating does not bring it back.
      const s = await one<{ revoked_reason: string }>(db, sql`
        select revoked_reason from sessions where account_id = ${person.id} order by created_at desc limit 1`)
      expect(s.revoked_reason).toBe('employee_deactivated')
    } finally {
      await exec(db, sql`update employees set status = 'active' where id = ${person.id}`)
    }
    expect(await principalForToken(token)).toBeNull()
  })

  it("a deactivated client's people are refused", async () => {
    const token = await signedIn(person)
    await exec(db, sql`update clients set status = 'inactive' where id = ${person.client_id}`)
    try {
      expect(await principalForToken(token)).toBeNull()
      expect(await flows.signIn(person.email, PASSWORD, meta)).toMatchObject({ status: 403 })
    } finally {
      await exec(db, sql`update clients set status = 'active' where id = ${person.client_id}`)
    }
  })

  it("a deactivated TMC's staff are refused", async () => {
    const token = await signedIn(staff)
    await exec(db, sql`update tmcs set status = 'inactive' where id = ${staff.tmc_id}`)
    try {
      expect(await principalForToken(token)).toBeNull()
      expect(await flows.signIn(staff.email, PASSWORD, meta)).toMatchObject({ status: 403 })
    } finally {
      await exec(db, sql`update tmcs set status = 'active' where id = ${staff.tmc_id}`)
    }
  })

  // ── Session lifetime ───────────────────────────────────────────────────────

  it('sign-out ends the session', async () => {
    const token = await signedIn(person)
    const me = (await principalForToken(token))!
    await flows.signOut(me, meta)
    expect(await principalForToken(token)).toBeNull()
  })

  it('an idle or an absolutely expired session is refused', async () => {
    const idle = await signedIn(person)
    const old = await signedIn(person)
    const [idleMe, oldMe] = [(await principalForToken(idle))!, (await principalForToken(old))!]
    await exec(db, sql`update sessions set idle_expires_at = now() - interval '1 second' where id = ${idleMe.sessionId}`)
    await exec(db, sql`
      update sessions set idle_expires_at = now() - interval '2 seconds', absolute_expires_at = now() - interval '1 second'
      where id = ${oldMe.sessionId}`)
    expect(await principalForToken(idle)).toBeNull()
    expect(await principalForToken(old)).toBeNull()
  })

  it('a garbage or unknown cookie is simply no session', async () => {
    expect(await principalForToken(undefined)).toBeNull()
    expect(await principalForToken("' or 1=1 --")).toBeNull()
    expect(await principalForToken('A'.repeat(43))).toBeNull()
  })

  // ── Forgot password ────────────────────────────────────────────────────────

  it('a reset request answers the same for an unknown address, and sends nothing', async () => {
    expect(await flows.requestPasswordReset('nobody@example.test', meta)).toEqual({ ok: true })
    expect(outbox).toEqual([])
  })

  it('a reset link sets a new password once, signs in, and ends every other session', async () => {
    const before = await signedIn(person)
    expect(await flows.requestPasswordReset(person.email, meta)).toEqual({ ok: true })
    const mail = lastMailTo(person.email!.toLowerCase())!
    const { token, type, url } = linkIn(mail)
    expect(type).toBe('reset')
    expect(url).toContain('/auth/confirm#')
    // Nothing secret in the audit trail.
    const audited = await many<{ metadata: unknown }>(db, sql`select metadata from audit_log where entity_id = ${person.id}`)
    expect(JSON.stringify(audited)).not.toContain(token)

    expect(await flows.inspectLink(token, meta)).toEqual({ ok: true, email: person.email!.toLowerCase(), purpose: 'reset' })
    expect(await flows.completeLink(token, 'short', meta)).toMatchObject({ ok: false, status: 400 })
    expect(await flows.completeLink(token, 'password123', meta)).toMatchObject({ ok: false, status: 400 })

    const done = await flows.completeLink(token, 'a brand new passphrase', meta)
    expect(done).toMatchObject({ ok: true, accountId: person.id })
    expect(await principalForToken(before)).toBeNull()
    if (done.ok) expect(await principalForToken(done.token)).not.toBeNull()

    // Spent.
    expect(await flows.completeLink(token, 'another new passphrase', meta)).toEqual({ ok: false, status: 400, error: flows.MESSAGES.badLink })
    expect(await flows.inspectLink(token, meta)).toMatchObject({ ok: false, status: 400 })
    expect(await flows.signIn(person.email, 'a brand new passphrase', meta)).toMatchObject({ ok: true })
    await setPassword(person.id, PASSWORD)
  })

  it('a newer link retires the older one, and an expired link is dead', async () => {
    await flows.requestPasswordReset(person.email, meta)
    const first = linkIn(outbox.at(-1)!).token
    await flows.requestPasswordReset(person.email, meta)
    const second = linkIn(outbox.at(-1)!).token
    expect(await flows.inspectLink(first, meta)).toMatchObject({ ok: false })
    expect(await flows.inspectLink(second, meta)).toMatchObject({ ok: true })

    await exec(db, sql`update auth_tokens set expires_at = now() - interval '1 second' where account_id = ${person.id} and consumed_at is null`)
    expect(await flows.inspectLink(second, meta)).toMatchObject({ ok: false })
  })

  it('more than three resets for one address in the window are dropped silently', async () => {
    for (let i = 0; i < 5; i++) expect(await flows.requestPasswordReset(person.email, meta)).toEqual({ ok: true })
    expect(outbox.filter(m => m.to === person.email!.toLowerCase())).toHaveLength(3)
  })

  it('a deactivated person gets no reset email, and their open link cannot be used', async () => {
    await flows.requestPasswordReset(person.email, meta)
    const { token } = linkIn(outbox.at(-1)!)
    await exec(db, sql`update employees set status = 'deactivated' where id = ${person.id}`)
    try {
      await exec(db, sql`delete from auth_attempts`)
      expect(await flows.requestPasswordReset(person.email, meta)).toEqual({ ok: true })
      expect(outbox).toHaveLength(1)
      expect(await flows.completeLink(token, 'a brand new passphrase', meta)).toMatchObject({ ok: false, status: 403 })
    } finally {
      await exec(db, sql`update employees set status = 'active' where id = ${person.id}`)
    }
  })

  it('"Forgot password" never activates an account that has no password', async () => {
    // An invite nobody accepted, or someone never invited at all: whoever reads
    // that inbox must not be able to activate it without an admin.
    const { accountId } = await transaction(tx =>
      flows.createAccount(tx, 'never.activated@example.test', { createdBy: staff.id }))
    expect(await flows.requestPasswordReset('never.activated@example.test', meta)).toEqual({ ok: true })
    expect(outbox).toEqual([])

    // An admin helping them in sends a fresh invite, not a reset.
    const sent = await transaction(tx => flows.sendPasswordReset(tx, accountId, staff.id))
    expect(sent).toEqual({ email: 'never.activated@example.test', kind: 'invite' })
    const { token, type } = linkIn(outbox.at(-1)!)
    expect(type).toBe('invite')
    expect(await flows.inspectLink(token, meta)).toMatchObject({ ok: true, purpose: 'invite' })

    await exec(db, sql`delete from accounts where id = ${accountId}`)
  })

  it('a reset link stops working if the account has no password', async () => {
    await flows.requestPasswordReset(person.email, meta)
    const { token } = linkIn(outbox.at(-1)!)
    await exec(db, sql`update accounts set password_hash = null where id = ${person.id}`)
    try {
      expect(await flows.inspectLink(token, meta)).toMatchObject({ ok: false, status: 400 })
      expect(await flows.completeLink(token, 'a brand new passphrase', meta)).toMatchObject({ ok: false, status: 400 })
    } finally {
      await setPassword(person.id, PASSWORD)
    }
  })

  // ── Invites ────────────────────────────────────────────────────────────────

  it('an invite is accepted by choosing a password; the employee becomes active', async () => {
    const email = 'new.joiner@example.test'
    const { accountId } = await transaction(async tx => {
      const r = await flows.createAccount(tx, email, { createdBy: staff.id })
      await exec(tx, sql`
        insert into employees (id, auth_user_id, client_id, email, full_name, role, status, onboarding_method)
        values (${r.accountId}, ${r.accountId}, ${person.client_id}, ${email}, 'New Joiner', 'employee', 'invited', 'invite')`)
      await flows.sendInvite(tx, r.accountId, staff.id)
      return r
    })
    const { token, type } = linkIn(lastMailTo(email)!)
    expect(type).toBe('invite')
    const done = await flows.completeLink(token, 'my own passphrase', meta)
    expect(done).toMatchObject({ ok: true, accountId, destination: '/dashboard' })
    const row = await one<{ status: string; email_verified_at: string | null }>(db, sql`
      select e.status, a.email_verified_at from employees e join accounts a on a.id = e.id where e.id = ${accountId}`)
    expect(row.status).toBe('active')
    expect(row.email_verified_at).not.toBeNull()
  })

  it('an address that already has an account cannot be invited again', async () => {
    await expect(transaction(tx => flows.createAccount(tx, person.email!.toUpperCase(), { createdBy: staff.id })))
      .rejects.toBeInstanceOf(flows.AccountExists)
  })

  it('an invite whose email fails leaves nothing behind', async () => {
    failNextMailWith('SMTP 550 mailbox unavailable')
    await expect(transaction(async tx => {
      const r = await flows.createAccount(tx, 'bounced@example.test', { createdBy: staff.id })
      await flows.sendInvite(tx, r.accountId, staff.id)
    })).rejects.toBeInstanceOf(flows.MailFailed)
    expect(await maybeOne(db, sql`select 1 from accounts where email = 'bounced@example.test'`)).toBeNull()
  })

  // ── Changing a password ────────────────────────────────────────────────────

  it('a change needs the current password, then ends every session and issues a fresh one', async () => {
    const other = await signedIn(person)
    const token = await signedIn(person)
    const me = (await principalForToken(token))!

    expect(await flows.changePassword(me, 'wrong current', 'a new passphrase here', meta))
      .toEqual({ ok: false, status: 403, error: flows.MESSAGES.wrongCurrent })
    expect(await flows.changePassword(me, PASSWORD, PASSWORD, meta)).toMatchObject({ status: 400 })

    const r = await flows.changePassword(me, PASSWORD, 'a new passphrase here', meta)
    expect(r).toMatchObject({ ok: true })
    expect(await principalForToken(token)).toBeNull()
    expect(await principalForToken(other)).toBeNull()
    if (r.ok) expect(await principalForToken(r.token)).not.toBeNull()
    await setPassword(person.id, PASSWORD)
  })

  it('five wrong current passwords lock password changes for the account', async () => {
    const me = (await principalForToken(await signedIn(person)))!
    for (let i = 0; i < 5; i++) await flows.changePassword(me, `wrong ${i}`, 'a new passphrase here', meta)
    expect(await flows.changePassword(me, PASSWORD, 'a new passphrase here', meta)).toMatchObject({ status: 429 })
  })

  // ── Admin-set passwords ────────────────────────────────────────────────────

  it('an admin-set password must be changed, and the flag is server-owned', async () => {
    const email = 'direct.create@example.test'
    await transaction(tx => flows.createAccount(tx, email, { password: 'starting password 1', createdBy: staff.id }))
    const r = await flows.signIn(email, 'starting password 1', meta)
    expect(r).toMatchObject({ ok: true, mustChangePassword: true })
    if (!r.ok) return
    const me = (await principalForToken(r.token))!
    expect(me.mustChangePassword).toBe(true)
    const changed = await flows.changePassword(me, 'starting password 1', 'chosen by me at last', meta)
    if (!changed.ok) throw new Error(changed.error)
    expect((await principalForToken(changed.token))!.mustChangePassword).toBe(false)
  })

  // ── Deactivation, done eagerly ─────────────────────────────────────────────

  it('endAllSessions ends every session of an account, and audits it', async () => {
    const a = await signedIn(person)
    const b = await signedIn(person)
    await flows.endAllSessions(db, person.id, 'employee_deactivated', staff.id)
    expect(await principalForToken(a)).toBeNull()
    expect(await principalForToken(b)).toBeNull()
    const logged = await one<{ n: number }>(db, sql`
      select count(*)::int as n from audit_log where entity_id = ${person.id} and action = 'auth.sessions_revoked'`)
    expect(logged.n).toBe(1)
  })
})
