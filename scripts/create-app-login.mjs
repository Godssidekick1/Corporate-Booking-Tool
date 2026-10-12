// ── npm run db:app-login ─────────────────────────────────────────────────────
// Points this machine's app at the restricted database login instead of the
// owner (docs/database-roles.md), in one step:
//
//   1. as the owner, creates (or re-passwords) cbt_app_login, a login in the
//      cbt_app role, with the statement / idle-in-transaction timeouts;
//   2. rewrites .env.local: DATABASE_URL becomes that login, and the owner's
//      URL moves to MIGRATE_DATABASE_URL (migrations, tests and the dev
//      scripts use it);
//   3. connects as the new login and checks what it can and cannot do.
//
// The password is generated here, written only to .env.local, and never
// printed. Run it again at any time to rotate it. To undo: set DATABASE_URL
// back to the MIGRATE_DATABASE_URL value.
//
//   npm run db:app-login            uses .env.local
// Then restart `npm run dev`.
// ─────────────────────────────────────────────────────────────────────────────

import pg from 'pg'
import { randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const LOGIN = 'cbt_app_login'
// --env <file>: another env file than ./.env.local (used to test this script).
const envAt = process.argv.indexOf('--env')
const envPath = envAt > 0 ? process.argv[envAt + 1] : join(process.cwd(), '.env.local')
if (!existsSync(envPath)) {
  console.error('[app-login] .env.local not found; run this from the project root.')
  process.exit(1)
}

const text = readFileSync(envPath, 'utf8')
const eol = text.includes('\r\n') ? '\r\n' : '\n'
const lines = text.split(/\r?\n/)
const valueOf = name => {
  for (const line of lines) {
    const m = line.match(new RegExp(`^\\s*${name}\\s*=\\s*(.*)\\s*$`))
    if (m) return m[1].replace(/^["']|["']$/g, '')
  }
  return undefined
}

// The owner: MIGRATE_DATABASE_URL if this has run before, else DATABASE_URL.
const ownerUrl = valueOf('MIGRATE_DATABASE_URL') ?? valueOf('DATABASE_URL')
if (!ownerUrl) {
  console.error('[app-login] DATABASE_URL is not set in .env.local.')
  process.exit(1)
}
let owner
try {
  owner = new URL(ownerUrl)
} catch {
  console.error('[app-login] The database URL in .env.local is not a valid URL.')
  process.exit(1)
}
if (owner.username === LOGIN) {
  console.error(`[app-login] DATABASE_URL already uses ${LOGIN} and no MIGRATE_DATABASE_URL names the owner.\n` +
    '  Add MIGRATE_DATABASE_URL=<the owner\'s URL> to .env.local, then run this again.')
  process.exit(1)
}

const password = randomBytes(24).toString('base64url')

const admin = new pg.Client({ connectionString: ownerUrl })
await admin.connect()
try {
  const role = await admin.query(`select 1 from pg_roles where rolname = 'cbt_app'`)
  if (role.rowCount === 0) {
    console.error('[app-login] The cbt_app role does not exist yet: run `npm run migrate` first.')
    process.exit(1)
  }
  // A password is a literal in CREATE/ALTER ROLE (no bind parameters there):
  // quoted by the server's own quote_literal.
  const literal = (await admin.query('select quote_literal($1) as q', [password])).rows[0].q
  const exists = (await admin.query('select 1 from pg_roles where rolname = $1', [LOGIN])).rowCount
  // INHERIT: the login uses cbt_app's grants directly, without SET ROLE.
  await admin.query(exists
    ? `alter role ${LOGIN} login inherit password ${literal}`
    : `create role ${LOGIN} login inherit password ${literal} in role cbt_app`)
  await admin.query(`grant cbt_app to ${LOGIN}`)
  await admin.query(`alter role ${LOGIN} set statement_timeout = '15s'`)
  await admin.query(`alter role ${LOGIN} set idle_in_transaction_session_timeout = '30s'`)
} finally {
  await admin.end()
}

const appUrl = new URL(ownerUrl)
appUrl.username = LOGIN
appUrl.password = password

// Check before touching .env.local: the new login connects, is restricted,
// and cannot change the schema.
const check = new pg.Client({ connectionString: appUrl.toString() })
await check.connect()
try {
  const me = (await check.query('select current_user as u, current_setting(\'statement_timeout\') as t')).rows[0]
  if (me.u !== LOGIN) throw new Error(`connected as ${me.u}`)
  let denied = false
  try { await check.query('create table app_login_check (x int)') } catch { denied = true }
  if (!denied) {
    await check.query('drop table if exists app_login_check')
    throw new Error(`${LOGIN} could create a table; it must not`)
  }
  console.info(`[app-login] ${LOGIN} connects (statement timeout ${me.t}) and cannot change the schema.`)
} finally {
  await check.end()
}

// Rewrite .env.local: replace or add the two lines, keep everything else.
const set = (all, name, value) => {
  const i = all.findIndex(l => new RegExp(`^\\s*${name}\\s*=`).test(l))
  if (i >= 0) all[i] = `${name}=${value}`
  else all.push(`${name}=${value}`)
  return all
}
let next = [...lines]
if (next.length && next[next.length - 1] === '') next.pop()
next = set(next, 'MIGRATE_DATABASE_URL', ownerUrl)
next = set(next, 'DATABASE_URL', appUrl.toString())
const tmp = `${envPath}.tmp`
writeFileSync(tmp, next.join(eol) + eol)
renameSync(tmp, envPath)

console.info('[app-login] .env.local updated: DATABASE_URL is now the restricted login; the owner is MIGRATE_DATABASE_URL.')
console.info('[app-login] Restart `npm run dev` to use it. Undo: set DATABASE_URL back to the MIGRATE_DATABASE_URL value.')
