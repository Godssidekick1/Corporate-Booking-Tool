// ── build-airports.mjs ──────────────────────────────────────────────────────
// Turns OurAirports' airports.csv into the two things the app reads:
//
//   db/migrations/<stamp>_airports.sql            the `airports` table and its rows
//   app/lib/data/indianAirports.generated.ts     India's IATA codes, for the
//                                                 domestic / international split
//
//   node scripts/build-airports.mjs <airports.csv> [migration stamp]
//
// The CSV is https://davidmegginson.github.io/ourairports-data/airports.csv
// (OurAirports, public domain). It is not committed. A refresh later is a new
// migration (a new stamp): an applied migration is never edited.
//
// Kept: every airport with an IATA code that has scheduled service, every
// large or medium airport, and every Indian one. Dropped: unscheduled small
// airstrips, heliports and seaplane bases -- no airline flies there, and they
// would bury the real answers in the picker.
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, writeFileSync } from 'node:fs'

const [csvPath, stamp = '20261008000000'] = process.argv.slice(2)
if (!csvPath) throw new Error('usage: node scripts/build-airports.mjs <airports.csv> [migration stamp]')

function parseCsv(text) {
  const rows = []
  let row = [], field = '', quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++ } else quoted = false }
      else field += c
    } else if (c === '"') quoted = true
    else if (c === ',') { row.push(field); field = '' }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = '' }
    else if (c !== '\r') field += c
  }
  if (field || row.length) { row.push(field); rows.push(row) }
  return rows
}

// Lower-case ASCII, so "sao paulo" finds São Paulo.
const fold = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim()
const lit = s => `'${s.replace(/'/g, "''")}'`

const [header, ...data] = parseCsv(readFileSync(csvPath, 'utf8'))
const col = Object.fromEntries(header.map((k, i) => [k, i]))
const all = data
  .filter(r => r.length === header.length)
  .map(r => ({
    code: r[col.iata_code].trim().toUpperCase(),
    name: r[col.name].trim(),
    city: r[col.municipality].trim(),
    country: r[col.iso_country].trim(),
    kind: r[col.type],
    scheduled: r[col.scheduled_service] === 'yes',
  }))
  .filter(a => /^[A-Z]{3}$/.test(a.code) && a.kind !== 'closed')

const kept = all
  .filter(a => a.scheduled || a.kind === 'large_airport' || a.kind === 'medium_airport' || a.country === 'IN')
  .sort((a, b) => a.code.localeCompare(b.code))

const codes = new Set()
for (const a of kept) {
  if (codes.has(a.code)) throw new Error(`duplicate IATA code ${a.code}`)
  codes.add(a.code)
}

// Every country must exist in `countries` (20261007000000_places.sql).
const placesSql = readFileSync('db/migrations/20261007000000_places.sql', 'utf8')
const countries = new Set([...placesSql.matchAll(/\('([A-Z]{2})', '[A-Z]{3}'/g)].map(m => m[1]))
if (countries.size < 240) throw new Error('could not read the country codes from the places migration')
const unknown = [...new Set(kept.filter(a => !countries.has(a.country)).map(a => a.country))]
if (unknown.length) throw new Error(`countries missing from the places migration: ${unknown.join(', ')}`)

const values = kept.map(a => {
  const city = a.city || a.name
  return `(${lit(a.code)}, ${lit(a.name)}, ${lit(city)}, ${lit(a.country)}, ${lit(a.kind)}, ${a.scheduled}, ${lit(fold(city))}, ${lit(fold(a.name))})`
})
const chunks = []
for (let i = 0; i < values.length; i += 500) chunks.push(values.slice(i, i + 500))

const migration = `-- ── Airports ───────────────────────────────────────────────────────────────
-- Problem: flight search offered about 150 hand-listed airports, so many real
-- ones could not be searched at all, and domestic vs international (which
-- decides the policy fare cap, passports, deal codes and commercials) was
-- decided from that same short list -- an Indian airport missing from it read
-- as international.
--
-- Change: an \`airports\` table of ${kept.length} airports with IATA codes, searched by
-- the flight search pickers (/api/reference/airports). India's codes are also
-- generated into app/lib/data/indianAirports.generated.ts for the domestic
-- check, which runs in the browser as well as on the server.
--   city        the municipality; the airport's own name when there is none
--   kind        large_airport | medium_airport | small_airport | seaplane_base | heliport
--   scheduled   has scheduled airline service (OurAirports' flag)
--   *_search    lower-case ASCII of city and name, for searching
--
-- Data: OurAirports (https://ourairports.com/data/), public domain. Built by
-- scripts/build-airports.mjs: every IATA-coded airport with scheduled service,
-- every large or medium one, and every Indian one.
--
-- Row-level security on, no policies, like every other table. Safe to apply
-- twice (if not exists / on conflict do nothing).
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.airports (
  code         char(3) primary key,
  name         text not null,
  city         text not null,
  country_code char(2) not null references public.countries (code),
  kind         text not null,
  scheduled    boolean not null,
  city_search  text not null,
  name_search  text not null
);
alter table public.airports enable row level security;

${chunks.map(c => `insert into public.airports (code, name, city, country_code, kind, scheduled, city_search, name_search) values\n${c.join(',\n')}\non conflict (code) do nothing;`).join('\n\n')}
`

const indian = kept.filter(a => a.country === 'IN').map(a => a.code)
const generated = `// GENERATED by scripts/build-airports.mjs from OurAirports (public domain).
// Do not edit by hand: rebuild, and add a migration with the same data.
//
// Every Indian airport with an IATA code (${indian.length}). A trip is domestic only
// when every leg is between two of these; see app/lib/rule-engine/classifyTrip.ts.

export const INDIAN_AIRPORT_CODES: readonly string[] = [
${indian.map((c, i) => (i % 12 === 0 ? '  ' : '') + `'${c}',` + ((i % 12 === 11 || i === indian.length - 1) ? '\n' : ' ')).join('')}]
`

writeFileSync(`db/migrations/${stamp}_airports.sql`, migration)
writeFileSync('app/lib/data/indianAirports.generated.ts', generated)
console.log(`airports: ${kept.length} of ${all.length} with IATA codes (India ${indian.length}) -> db/migrations/${stamp}_airports.sql`)
