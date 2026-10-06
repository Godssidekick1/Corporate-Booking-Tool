// ── load-cities.mjs ─────────────────────────────────────────────────────────
// Fills the `cities` reference table (db/migrations/20261007000000_places.sql)
// from GeoNames' cities500: every populated place with 500+ people, about
// 225,000 of them. Run once per database, after `npm run migrate`, and again
// whenever the data should be refreshed -- it replaces the table's contents in
// one transaction, so a failed run leaves the old list in place.
//
//   node scripts/load-cities.mjs                    (DATABASE_URL, downloads)
//   node scripts/load-cities.mjs <url>
//   node scripts/load-cities.mjs --file cities500.zip   (or the unzipped .txt)
//
// Data: GeoNames (https://www.geonames.org), CC BY 4.0.
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import pg from 'pg'

const SOURCE = 'https://download.geonames.org/export/dump/cities500.zip'
// Not places a traveller lives in: sections of a city, and abandoned,
// historical or destroyed places.
const SKIP = new Set(['PPLX', 'PPLQ', 'PPLH', 'PPLW', 'PPLCH'])
const BATCH = 1000

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

// The one file inside a single-entry zip, via its central directory (sizes in
// the local header may be zero when the archive was streamed).
function unzipSingle(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  if (eocd < 0) throw new Error('not a zip file')
  const cd = buf.readUInt32LE(eocd + 16)
  const method = buf.readUInt16LE(cd + 10)
  const size = buf.readUInt32LE(cd + 20)
  const local = buf.readUInt32LE(cd + 42)
  const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28)
  const data = buf.subarray(start, start + size)
  if (method === 0) return data
  if (method === 8) return inflateRawSync(data)
  throw new Error(`unsupported zip compression method ${method}`)
}

const args = process.argv.slice(2)
const fileAt = args.indexOf('--file')
const file = fileAt >= 0 ? args[fileAt + 1] : null
// The database address is the one argument that is neither a flag nor the
// value after --file. (Testing `i !== fileAt + 1` alone skipped the FIRST
// argument whenever --file was absent, since fileAt is then -1.)
const url = args.find((a, i) => !a.startsWith('--') && (fileAt < 0 || i !== fileAt + 1)) ?? envValue('DATABASE_URL')
if (!url) {
  console.error('usage: node scripts/load-cities.mjs [database url] [--file cities500.zip]   (or set DATABASE_URL)')
  process.exit(1)
}

let host
try {
  host = new URL(url).hostname
} catch {
  console.error('DATABASE_URL is not a valid URL (special characters in the password must be percent-encoded).')
  process.exit(1)
}

// Connect (and check the tables exist) BEFORE the 14 MB download, so a wrong
// address or an unmigrated database fails in a second, not after a minute.
const client = new pg.Client({
  connectionString: url,
  ssl: host === 'localhost' || host === '127.0.0.1' ? undefined : { rejectUnauthorized: false },
})
try {
  await client.connect()
} catch (err) {
  console.error(`[cities] cannot reach the database at ${host}: ${err.code ?? err.message}`)
  if (host === 'localhost' || host === '127.0.0.1') {
    console.error('[cities] Is PostgreSQL running? From WSL, "localhost" is WSL itself, not Windows: run this from PowerShell instead.')
  }
  process.exit(1)
}
try {
  const known = new Set((await client.query('select code from countries')).rows.map(r => r.code))
  if (known.size === 0) throw new Error('countries is empty -- run `npm run migrate` first')

  let raw
  if (file) {
    raw = readFileSync(file)
  } else {
    console.log(`downloading ${SOURCE}`)
    const res = await fetch(SOURCE)
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`)
    raw = Buffer.from(await res.arrayBuffer())
  }
  const text = (raw[0] === 0x50 && raw[1] === 0x4b ? unzipSingle(raw) : raw).toString('utf8')

  // geonameid, name, asciiname, ..., feature code [7], country [8], admin1 [10], population [14]
  const rows = []
  for (const line of text.split('\n')) {
    const f = line.split('\t')
    if (f.length < 15 || SKIP.has(f[7]) || !known.has(f[8])) continue
    rows.push([Number(f[0]), f[8], f[10] || null, f[1], f[2] || f[1], Number(f[14]) || 0])
  }

  await client.query('begin')
  await client.query('delete from cities')
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH)
    const values = chunk.map((_, j) => `($${j * 6 + 1}, $${j * 6 + 2}, $${j * 6 + 3}, $${j * 6 + 4}, $${j * 6 + 5}, $${j * 6 + 6})`)
    await client.query(
      `insert into cities (id, country_code, region_code, name, ascii_name, population) values ${values.join(', ')}`,
      chunk.flat()
    )
  }
  await client.query('commit')
  console.log(`[cities] ${rows.length} places loaded into ${host}`)
} catch (err) {
  await client.query('rollback').catch(() => {})
  console.error(`[cities] failed: ${err.message}`)
  process.exit(1)
} finally {
  await client.end()
}
