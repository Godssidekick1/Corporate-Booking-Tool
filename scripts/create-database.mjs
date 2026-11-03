// ── npm run db:create ────────────────────────────────────────────────────────
// A new, EMPTY database from the repository alone: no dump needed.
//
//   1. creates the role cbt_app (no login) if the server lacks it: the
//      baseline's grants name it, and the app's login joins it later
//   2. creates the database named in the URL; refuses one that already exists
//   3. loads schema/baseline.sql into it, in one transaction (all or nothing)
//   4. applies any migration newer than the baseline (npm run migrate)
//
//   npm run db:create                    MIGRATE_DATABASE_URL, else DATABASE_URL
//   node scripts/create-database.mjs <url>
//
// The URL is the OWNER's, naming the database to create. Then
// `npm run db:app-login` gives the app its restricted login, and
// `node scripts/load-cities.mjs` fills the city list. The data a deployment
// starts with (clients, people, bookings) comes from a dump instead
// (docs/deploy-windows.md), never from here.
// ─────────────────────────────────────────────────────────────────────────────

import { spawnSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import pg from 'pg'
import { migrate, sslFor } from './migrate.mjs'
import { pgTool, connectionFor } from './pg-tools.mjs'

const BASELINE = join(process.cwd(), 'schema', 'baseline.sql')

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

const url = process.argv[2] ?? envValue('MIGRATE_DATABASE_URL') ?? envValue('DATABASE_URL')
if (!url) {
  console.error('[db:create] no database: pass the owner\'s URL or set MIGRATE_DATABASE_URL in .env.local')
  process.exit(1)
}
let target
try {
  target = new URL(url)
} catch {
  console.error('[db:create] the database URL is not a valid URL (special characters in the password must be percent-encoded).')
  process.exit(1)
}
const name = decodeURIComponent(target.pathname.slice(1))
if (!/^[a-z_][a-z0-9_]*$/.test(name)) {
  console.error(`[db:create] "${name}": use a lower-case database name (letters, digits, _).`)
  process.exit(1)
}
const where = `${target.hostname}/${name}`

const serverUrl = new URL(url)
serverUrl.pathname = '/postgres'
const admin = new pg.Client({ connectionString: serverUrl.toString(), ssl: sslFor(url) })
await admin.connect()
try {
  if ((await admin.query('select 1 from pg_database where datname = $1', [name])).rowCount > 0) {
    console.error(`[db:create] ${where} already exists. This only builds a new database; to bring an existing one up to date, run npm run migrate.`)
    process.exit(1)
  }
  if ((await admin.query(`select 1 from pg_roles where rolname = 'cbt_app'`)).rowCount === 0) {
    await admin.query('create role cbt_app nologin')
    console.info('[db:create] role cbt_app created (no login)')
  }
  await admin.query(`create database ${name}`)
  console.info(`[db:create] ${where} created`)
} finally {
  await admin.end()
}

const { args, env } = connectionFor(url)
const load = spawnSync(pgTool('psql'), [
  ...args, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '--single-transaction', '-f', BASELINE,
], { env, encoding: 'utf8' })
if (load.status !== 0) {
  console.error(`[db:create] loading the baseline failed; ${where} is left empty:\n${load.stderr}`)
  process.exit(1)
}
console.info('[db:create] schema/baseline.sql loaded')

await migrate(url, { log: line => console.info(`[db:create] ${line}`) })
console.info(`[db:create] done. Next: npm run db:app-login, then node scripts/load-cities.mjs.`)
