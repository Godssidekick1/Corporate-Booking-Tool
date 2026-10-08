// ── migrate.mjs ──────────────────────────────────────────────────────────────
// Applies db/migrations/*.sql in filename order and records each one, so a
// database can say what has been applied to it.
//
//   node scripts/migrate.mjs              apply pending migrations
//   node scripts/migrate.mjs --status     list applied / pending, change nothing
//   node scripts/migrate.mjs <url> [...]  target a URL instead of DATABASE_URL
//   (MIGRATE_DATABASE_URL, when set, is used before DATABASE_URL)
//
// WHY: migrations used to be pasted into pgAdmin by hand, and nothing recorded
// which had run where. That is how two identical unique indexes ended up on
// policy_groups with no file creating the second one.
//
// RULES
//   - One transaction per file: it applies completely or not at all. Files must
//     not contain their own BEGIN/COMMIT.
//   - An applied file is never edited. Its SHA-256 is recorded, and a changed
//     file stops the run. Write a new migration instead.
//   - A session advisory lock stops two runs (two deploys, or a deploy and a
//     person) applying the same file at once.
//
// db/migrations/archive holds the Supabase-era files. They are already in every
// database and in schema/baseline.sql, and are never run.
// ─────────────────────────────────────────────────────────────────────────────

import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import pg from 'pg'

const DIR = join(process.cwd(), 'db', 'migrations')
// An arbitrary constant, shared by every run against the same database.
const LOCK_KEY = 7_302_025

// MIGRATE_DATABASE_URL first: once the app runs as the restricted cbt_app login
// (docs/database-roles.md), DATABASE_URL can no longer change the schema, and
// migrations need the owner's connection.
function envUrl() {
  const envPath = join(process.cwd(), '.env.local')
  const file = existsSync(envPath) ? readFileSync(envPath, 'utf8').split(/\r?\n/) : []
  for (const name of ['MIGRATE_DATABASE_URL', 'DATABASE_URL']) {
    if (process.env[name]) return process.env[name]
    for (const line of file) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/)
      if (m && m[1] === name) return m[2].replace(/^["']|["']$/g, '')
    }
  }
  throw new Error('DATABASE_URL not set. Pass a connection string or add it to .env.local.')
}

// Same rule as app/lib/db/pool.ts: plaintext on loopback, TLS elsewhere.
function sslFor(url) {
  return url.includes('localhost') || url.includes('127.0.0.1') ? undefined : { rejectUnauthorized: false }
}

function files() {
  return readdirSync(DIR)
    .filter(f => f.endsWith('.sql'))
    .sort()
    .map(filename => {
      const text = readFileSync(join(DIR, filename), 'utf8')
      // Hashed with LF line endings: a Windows checkout may have CRLF, and the
      // same file must hash the same on every machine that runs it.
      const sha256 = createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex')
      return { filename, text, sha256 }
    })
}

/**
 * Applies pending migrations to the database at `url`. Returns the filenames
 * applied (or, with `status`, the ones that would be).
 */
export async function migrate(url, { status = false, log = console.log } = {}) {
  const client = new pg.Client({ connectionString: url, ssl: sslFor(url) })
  await client.connect()
  try {
    await client.query('select pg_advisory_lock($1)', [LOCK_KEY])
    await client.query(`
      create table if not exists public.schema_migrations (
        filename   text primary key,
        sha256     text not null,
        applied_at timestamptz not null default now()
      )`)
    // Not for any API: this schema is also reachable through Supabase's Data
    // API while Supabase hosts it. See 20260925000000.
    await client.query('alter table public.schema_migrations enable row level security')

    const { rows } = await client.query('select filename, sha256 from public.schema_migrations')
    const applied = new Map(rows.map(r => [r.filename, r.sha256]))

    const all = files()
    const edited = all.filter(f => applied.has(f.filename) && applied.get(f.filename) !== f.sha256)
    if (edited.length > 0) {
      throw new Error(
        `applied migration(s) changed on disk: ${edited.map(f => f.filename).join(', ')}.\n` +
        '  An applied file must never be edited. Restore it and write a new migration.'
      )
    }

    const pending = all.filter(f => !applied.has(f.filename))
    if (status) {
      for (const f of all) log(`${applied.has(f.filename) ? 'applied' : 'PENDING'}  ${f.filename}`)
      return pending.map(f => f.filename)
    }

    for (const f of pending) {
      await client.query('begin')
      try {
        await client.query(f.text)
        await client.query(
          'insert into public.schema_migrations (filename, sha256) values ($1, $2)',
          [f.filename, f.sha256]
        )
        await client.query('commit')
      } catch (err) {
        await client.query('rollback')
        throw new Error(`${f.filename} failed and was rolled back: ${err.message}`, { cause: err })
      }
      log(`applied  ${f.filename}`)
    }
    return pending.map(f => f.filename)
  } finally {
    await client.end()
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2)
  const url = args.find(a => !a.startsWith('--')) ?? envUrl()
  // Never echo the connection string: it carries the password. Node's own
  // "Invalid URL" error prints its input in full, so parse failures are caught
  // here and reported without it.
  let target
  try {
    target = new URL(url)
  } catch {
    console.error(
      '[migrate] DATABASE_URL is not a valid URL. Characters such as / # ? @ : % in the\n' +
      '  password must be percent-encoded (/ -> %2F, # -> %23, ? -> %3F, @ -> %40, : -> %3A, % -> %25).'
    )
    process.exit(1)
  }
  console.log(`[migrate] ${target.hostname}:${target.port || 5432}${target.pathname}`)
  try {
    const done = await migrate(url, { status: args.includes('--status') })
    if (!args.includes('--status')) console.log(done.length ? `[migrate] ${done.length} applied` : '[migrate] up to date')
  } catch (err) {
    console.error(`[migrate] ${err.message}`)
    process.exit(1)
  }
}
