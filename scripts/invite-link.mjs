// ── invite-link.mjs ──────────────────────────────────────────────────────────
// Prints a one-time invite link for an EXISTING account, so its owner can set
// a password. For operators with database access, where no admin screen can
// send one: a platform admin seeded by hand, or a developer's local copy whose
// accounts were imported without passwords.
//
//   node scripts/invite-link.mjs someone@example.com            (DATABASE_URL)
//   node scripts/invite-link.mjs someone@example.com <url>
//
// The link is printed, not emailed: hand it over yourself. It works once,
// expires in 7 days, and retires any earlier link for the account, exactly as
// an emailed invite does (app/lib/auth/flows.ts). The token is stored only as
// its SHA-256.
// ─────────────────────────────────────────────────────────────────────────────

import { createHash, randomBytes } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import pg from 'pg'

function envValue(name) {
  if (process.env[name]) return process.env[name]
  const envPath = join(process.cwd(), '.env.local')
  if (!existsSync(envPath)) return undefined
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(new RegExp(`^\\s*${name}\\s*=\\s*(.*)\\s*$`))
    if (m) return m[1].replace(/^["']|["']$/g, '')
  }
  return undefined
}

const email = process.argv[2]?.trim().toLowerCase()
const url = process.argv[3] ?? envValue('DATABASE_URL')
if (!email || !url) {
  console.error('usage: node scripts/invite-link.mjs <email> [database url]   (or set DATABASE_URL)')
  process.exit(1)
}
const appUrl = (envValue('NEXT_PUBLIC_APP_URL') ?? 'http://localhost:3000').replace(/\/+$/, '')

let host
try {
  host = new URL(url).hostname
} catch {
  console.error('DATABASE_URL is not a valid URL (special characters in the password must be percent-encoded).')
  process.exit(1)
}

const client = new pg.Client({
  connectionString: url,
  ssl: host === 'localhost' || host === '127.0.0.1' ? undefined : { rejectUnauthorized: false },
})
await client.connect()
try {
  const { rows } = await client.query('select id from accounts where email = $1', [email])
  if (rows.length === 0) {
    console.error(`No account for ${email}.`)
    process.exit(1)
  }
  const accountId = rows[0].id
  const token = randomBytes(32).toString('base64url')
  const id = createHash('sha256').update(token).digest('hex')

  await client.query('begin')
  await client.query('update auth_tokens set consumed_at = now() where account_id = $1 and consumed_at is null', [accountId])
  await client.query(
    `insert into auth_tokens (id, account_id, purpose, expires_at) values ($1, $2, 'invite', now() + interval '7 days')`,
    [id, accountId]
  )
  await client.query(
    `insert into audit_log (user_id, action, entity_type, entity_id, metadata)
     values (null, 'auth.invite_sent', 'account', $1, '{"via": "invite-link script"}'::jsonb)`,
    [accountId]
  )
  await client.query('commit')

  console.log(`Invite link for ${email} (works once, expires in 7 days):\n\n  ${appUrl}/auth/confirm#type=invite&token=${token}\n`)
} catch (err) {
  await client.query('rollback').catch(() => {})
  console.error(`Failed: ${err.message}`)
  process.exit(1)
} finally {
  await client.end()
}
