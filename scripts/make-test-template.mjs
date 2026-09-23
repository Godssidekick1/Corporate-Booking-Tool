// ── make-test-template.mjs ───────────────────────────────────────────────────
// Builds cbt_template: an ANONYMISED copy of cbt_local that the test suite
// clones into a fresh cbt_test on every run.
//
//   node scripts/make-test-template.mjs
//
// WHY ANONYMISED: route tests snapshot real responses, and snapshot files are
// committed. cbt_local is a restore of production -- it holds live passport
// numbers in bookings.traveler_snapshot, real names, emails, phone numbers,
// PNRs, ticket numbers, a live Amadeus session id and the share tokens that
// grant access to real tickets on the public ticket page. None of that may end
// up in git. Scrubbing happens once, here, so no test has to remember to.
//
// WHY A SEPARATE TEMPLATE: CREATE DATABASE … TEMPLATE refuses to run while
// anything is connected to the source. Nothing ever connects to cbt_template,
// so cloning it for tests never collides with a running dev server on cbt_local.
//
// Requires cbt_local to have no open connections WHILE THIS RUNS (stop the dev
// server). Scrubbing is deterministic -- replacements are derived from row ids
// -- so re-running it produces identical data and snapshots stay stable.
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import pg from 'pg'

const SOURCE = 'cbt_local'
const TEMPLATE = 'cbt_template'

function baseUrl() {
  let url = process.env.DATABASE_URL
  const envPath = join(process.cwd(), '.env.local')
  if (!url && existsSync(envPath)) {
    for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*DATABASE_URL\s*=\s*(.*)\s*$/)
      if (m) url = m[1].replace(/^["']|["']$/g, '')
    }
  }
  if (!url) throw new Error('DATABASE_URL not set')
  return new URL(url)
}

function urlFor(database) {
  const u = baseUrl()
  u.pathname = `/${database}`
  return u.toString()
}

// ── jsonb scrubbing for traveller data ───────────────────────────────────────
// Personal keys are replaced with type-preserving fakes; structural values
// (PaxType, Title, Gender, CountryCode, seat and meal codes) are kept, because
// route logic branches on them and characterisation tests should exercise
// realistic shapes.
function fakeFor(key, value) {
  if (typeof value !== 'string' && typeof value !== 'number') return value
  const k = key.toLowerCase()
  const str = v => (typeof value === 'number' ? Number(v) : v)
  // DATES FIRST, so a key like passportExpiryDate keeps a date's shape. An
  // earlier version matched /passport/ before this and wrote "X0000000" into a
  // date field, which any passport-validity check would read as Invalid Date.
  const asDate = d => (typeof value === 'string' && value.includes('T') ? `${d}T00:00:00` : d)
  if (/dob|birth/.test(k)) return asDate('1990-01-01')
  if (/date|expir|valid/.test(k)) return asDate('2035-01-01')
  if (k.includes('email')) return 'traveller@example.test'
  if (/mobile|phone|contact/.test(k)) return str('9999999999')
  if (/passport|document|aadhaar|^pan/.test(k)) return 'X0000000'
  if (/^first|given/.test(k)) return 'Test'
  if (/^last|surname|family/.test(k)) return 'Traveller'
  if (/^middle/.test(k)) return ''
  if (/fullname|full_name|^name$/.test(k)) return 'Test Traveller'
  if (/address|street|zip|pincode|postal/.test(k)) return 'Test Address'
  if (/ticketnumber|ticket_number/.test(k)) return '000-0000000000'
  if (/frequent|ffn|loyalty/.test(k)) return 'FF000000'
  return value
}

function scrubJson(value, key = '') {
  if (Array.isArray(value)) return value.map(v => scrubJson(v, key))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubJson(v, k)]))
  }
  return key ? fakeFor(key, value) : value
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
function scrubEmailsDeep(value) {
  if (typeof value === 'string') return value.replace(EMAIL, 'someone@example.test')
  if (Array.isArray(value)) return value.map(scrubEmailsDeep)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubEmailsDeep(v)]))
  }
  return value
}

// ── 1. Clone ─────────────────────────────────────────────────────────────────
const admin = new pg.Client({ connectionString: urlFor('postgres') })
await admin.connect()

const busy = await admin.query(
  'select count(*)::int as n from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()',
  [SOURCE]
)
if (busy.rows[0].n > 0) {
  console.error(`${SOURCE} has ${busy.rows[0].n} open connection(s). Stop the dev server and re-run.`)
  process.exit(1)
}

await admin.query(
  'select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()',
  [TEMPLATE]
)
await admin.query(`drop database if exists ${TEMPLATE}`)
await admin.query(`create database ${TEMPLATE} template ${SOURCE}`)
await admin.end()
console.log(`cloned ${SOURCE} -> ${TEMPLATE}`)

// ── 2. Scrub ─────────────────────────────────────────────────────────────────
const db = new pg.Client({ connectionString: urlFor(TEMPLATE) })
await db.connect()
await db.query('begin')

// Deterministic per-row fakes for flat personal columns.
await db.query(`
  update employees set
    full_name = 'Employee ' || substr(md5(id::text), 1, 6),
    email     = 'employee.' || substr(md5(id::text), 1, 6) || '@example.test'
`)
await db.query(`
  update clients set
    email                 = case when email is null then null else 'client.' || substr(md5(id::text), 1, 6) || '@example.test' end,
    phone                 = case when phone is null then null else '9999999999' end,
    primary_contact_phone = case when primary_contact_phone is null then null else '9999999999' end,
    collections_name      = case when collections_name is null then null else 'Collections Contact' end,
    collections_email     = case when collections_email is null then null else 'collections@example.test' end,
    collections_mobile    = case when collections_mobile is null then null else '9999999999' end,
    registered_address    = case when registered_address is null then null else 'Test Address' end,
    address_1             = case when address_1 is null then null else 'Test Address' end,
    address_2             = case when address_2 is null then null else null end
`)
await db.query(`
  update client_groups set
    contact_first_name = case when contact_first_name is null then null else 'Test' end,
    contact_last_name  = case when contact_last_name is null then null else 'Contact' end,
    contact_email      = case when contact_email is null then null else 'group@example.test' end,
    contact_mobile     = case when contact_mobile is null then null else '9999999999' end,
    bill_to_address_1  = case when bill_to_address_1 is null then null else 'Test Address' end,
    bill_to_address_2  = null
`)
await db.query(`
  update branches set
    gst_email     = case when gst_email is null then null else 'branch@example.test' end,
    gst_contact   = case when gst_contact is null then null else '9999999999' end,
    gst_address_1 = case when gst_address_1 is null then null else 'Test Address' end,
    gst_address_2 = null
`)
await db.query(`
  update client_gst_registrations set
    email     = case when email is null then null else 'gst@example.test' end,
    contact   = case when contact is null then null else '9999999999' end,
    address_1 = case when address_1 is null then null else 'Test Address' end,
    address_2 = null
`)
await db.query(`update platform_admins set email = 'admin.' || substr(md5(user_id::text), 1, 6) || '@example.test'`)
await db.query(`update amadeus_session set session_id = 'test-session'`)
await db.query(`update forms_of_payment set last4 = case when last4 is null then null else '1111' end`)
await db.query(`update trip_expenses set receipt_url = null`)

// Access tokens and airline references: a real share_token opens a real
// ticket on the production public page; a real PNR plus a surname opens the
// booking at the airline.
await db.query(`
  update bookings set
    share_token    = case when share_token is null then null else md5('share' || id::text) end,
    pnr            = case when pnr is null then null else upper(substr(md5('pnr' || id::text), 1, 6)) end,
    ticket_numbers = case when ticket_numbers is null then null
                          else array(select '000-' || lpad(n::text, 10, '0') from generate_subscripts(ticket_numbers, 1) n) end
`)

// jsonb: walk traveller documents key by key.
for (const [table, column] of [['bookings', 'traveler_snapshot'], ['employees', 'traveler_profile']]) {
  const { rows } = await db.query(`select id, ${column} as v from ${table} where ${column} is not null`)
  for (const row of rows) {
    await db.query(`update ${table} set ${column} = $1::jsonb where id = $2`, [JSON.stringify(scrubJson(row.v)), row.id])
  }
  console.log(`scrubbed ${table}.${column}: ${rows.length} rows`)
}
{
  const { rows } = await db.query(`select id, metadata as v from audit_log where metadata is not null`)
  for (const row of rows) {
    await db.query(`update audit_log set metadata = $1::jsonb where id = $2`, [JSON.stringify(scrubEmailsDeep(row.v)), row.id])
  }
  console.log(`scrubbed audit_log.metadata: ${rows.length} rows`)
}

// ── 3. Verify ────────────────────────────────────────────────────────────────
// Every text and jsonb column, every row: no email that is not @example.test.
// This is the check that matters; the updates above are only how we get there.
const { rows: columns } = await db.query(`
  select table_name, column_name, udt_name
  from information_schema.columns c
  join information_schema.tables t using (table_schema, table_name)
  where c.table_schema = 'public' and t.table_type = 'BASE TABLE'
    and udt_name in ('text', 'varchar', 'bpchar', 'jsonb', 'json')
`)
const leaks = []
for (const c of columns) {
  const { rows } = await db.query(
    `select count(*)::int as n from ${c.table_name}
     where ${c.column_name}::text ~* '[a-z0-9._%+-]+@[a-z0-9.-]+\\.[a-z]{2,}'
       and ${c.column_name}::text !~* '^[^@]*(@example\\.test[^@]*)+$'`
  )
  if (rows[0].n > 0) leaks.push(`${c.table_name}.${c.column_name}: ${rows[0].n} row(s)`)
}

if (leaks.length > 0) {
  await db.query('rollback')
  await db.end()
  console.error('PII check FAILED -- real email addresses remain in:')
  leaks.forEach(l => console.error(`  ${l}`))
  process.exit(1)
}

await db.query('commit')
await db.end()
console.log(`${TEMPLATE} ready: ${columns.length} text/jsonb columns checked, no real emails remain.`)
