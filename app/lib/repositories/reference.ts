import { sql, empty, many, maybeOne, one, exec, type Queryable } from '@/app/lib/db/sql'
import { searchAcross, page } from '@/app/lib/db/fragments'
import type { Row } from '@/app/lib/db/types.generated'
import type { PageParams } from '@/app/lib/pagination'

// ── Reference data ───────────────────────────────────────────────────────────
// Owns: airlines, amadeus_session, countries, regions, cities.
//
// Global rather than tenant-scoped: which airlines exist is a fact about the
// world, and the Amadeus session belongs to the shared agency account.
// ─────────────────────────────────────────────────────────────────────────────

// ═══ airlines ═══════════════════════════════════════════════════════════════

export type Airline = Pick<Row<'airlines'>, 'code' | 'name' | 'last_seen_at'>

export interface AirlinePage {
  rows: Airline[]
  total: number
}

// A page of airlines for the pickers, searchable by code or name.
export async function listAirlines(
  db: Queryable,
  params: Pick<PageParams, 'from' | 'to' | 'search'>
): Promise<AirlinePage> {
  // People look up "6E" and "IndiGo" about equally, depending on whether they
  // are reading a GDS screen or talking to a colleague -- so both columns.
  const where = sql`where true ${searchAcross([sql`code`, sql`name`], params.search)}`

  const [rows, total] = await Promise.all([
    many<Airline>(db, sql`
      select code, name, last_seen_at from airlines
      ${where}
      order by code
      ${page(params)}`),
    one<{ n: number }>(db, sql`select count(*)::int as n from airlines ${where}`),
  ])
  return { rows, total: total.n }
}

// Specific airlines by code, for resolving a picker's labels. Codes are
// normalised to upper case, because the code IS the primary key and a
// free-typed "ai" should find "AI".
export async function airlinesByCode(db: Queryable, codes: readonly string[]): Promise<Airline[]> {
  const normalised = codes.map(c => c.trim().toUpperCase()).filter(Boolean)
  if (normalised.length === 0) return []
  return many<Airline>(db, sql`
    select code, name, last_seen_at from airlines
    where code = any(${normalised})
    order by code`)
}

// Carriers seen WITH a name: insert, or refresh name and last-seen.
//
// first_seen_at is never written: on insert it takes its now() default, and on
// conflict it is left alone -- it is history, and every search would otherwise
// reset it.
export async function upsertNamedAirlines(
  db: Queryable,
  airlines: readonly { code: string; name: string }[],
  seenAt: string
): Promise<void> {
  if (airlines.length === 0) return
  await exec(db, sql`
    insert into airlines (code, name, last_seen_at)
    select code, name, ${seenAt}::timestamptz
    from unnest(${airlines.map(a => a.code)}::text[], ${airlines.map(a => a.name)}::text[]) as t(code, name)
    on conflict (code) do update
      set name = excluded.name, last_seen_at = excluded.last_seen_at`)
}

// Carriers seen WITHOUT a name -- typically someone else's operating carrier.
// Inserted with the code as a placeholder name, and NEVER overwriting an
// existing row: a known airline appearing only as an operating carrier must
// keep the real name recorded earlier. last_seen_at is refreshed separately.
export async function recordUnnamedAirlines(
  db: Queryable,
  codes: readonly string[],
  seenAt: string
): Promise<void> {
  if (codes.length === 0) return
  await exec(db, sql`
    insert into airlines (code, name, last_seen_at)
    select code, code, ${seenAt}::timestamptz from unnest(${[...codes]}::text[]) as t(code)
    on conflict (code) do nothing`)
  await exec(db, sql`
    update airlines set last_seen_at = ${seenAt}::timestamptz
    where code = any(${[...codes]})`)
}

// ═══ amadeus_session ════════════════════════════════════════════════════════
// A singleton: one row, id = 1, shared by every request. See the open
// question in app/lib/amadeus/sessionStore.ts about whether that is right.

const SESSION_ROW_ID = 1

export type AmadeusSession = Pick<Row<'amadeus_session'>, 'session_id' | 'expires_at'>

// The current session, or null when there is none OR it has expired.
//
// The expiry filter is a FIX, not a translation. The previous read returned the
// row regardless, so a cold process could hand out a session Amadeus had
// already expired -- producing a "Session Expired" and the retry it costs.
export async function currentAmadeusSession(db: Queryable): Promise<AmadeusSession | null> {
  return maybeOne<AmadeusSession>(db, sql`
    select session_id, expires_at from amadeus_session
    where id = ${SESSION_ROW_ID} and expires_at > now()`)
}

// Stores the session, replacing any existing one.
//
// The ON CONFLICT … DO UPDATE is the fix for a defect in the shim: it
// translated supabase-js's `upsert(row)` -- which PostgREST performs as a merge
// on the primary key -- into ON CONFLICT DO NOTHING. So once a row existed,
// every new session was silently discarded, and a cold process read the stale
// one back.
export async function saveAmadeusSession(db: Queryable, sessionId: string, expiresAt: string): Promise<void> {
  await exec(db, sql`
    insert into amadeus_session (id, session_id, expires_at, updated_at)
    values (${SESSION_ROW_ID}, ${sessionId}, ${expiresAt}::timestamptz, now())
    on conflict (id) do update
      set session_id = excluded.session_id,
          expires_at = excluded.expires_at,
          updated_at = excluded.updated_at`)
}

export async function deleteAmadeusSession(db: Queryable): Promise<void> {
  await exec(db, sql`delete from amadeus_session where id = ${SESSION_ROW_ID}`)
}

// ═══ Places: countries, regions, cities ═════════════════════════════════════
// GeoNames reference data (CC BY 4.0). Countries and regions are inserted by
// 20261007000000_places; cities by scripts/load-cities.mjs.

export type Country = Pick<Row<'countries'>, 'code' | 'name'>
export type Region = Pick<Row<'regions'>, 'code' | 'name'>
export type City = Pick<Row<'cities'>, 'id' | 'name' | 'region_code'>

export async function listCountries(db: Queryable): Promise<Country[]> {
  return many<Country>(db, sql`select code, name from countries order by name`)
}

export async function listRegions(db: Queryable, countryCode: string): Promise<Region[]> {
  return many<Region>(db, sql`
    select code, name from regions where country_code = ${countryCode} order by name`)
}

// A country by its code, ISO3 code or English name, case-insensitively.
export async function findCountry(db: Queryable, value: string): Promise<Country | null> {
  return maybeOne<Country>(db, sql`
    select code, name from countries
    where upper(code) = upper(${value}) or upper(iso3) = upper(${value}) or lower(name) = lower(${value})
    limit 1`)
}

// A region of a country by its name or code, case-insensitively.
export async function findRegion(db: Queryable, countryCode: string, value: string): Promise<Region | null> {
  return maybeOne<Region>(db, sql`
    select code, name from regions
    where country_code = ${countryCode} and (lower(name) = lower(${value}) or lower(code) = lower(${value}))
    order by (lower(name) = lower(${value})) desc
    limit 1`)
}

export async function hasCities(db: Queryable, countryCode: string): Promise<boolean> {
  return (await one<{ yes: boolean }>(db, sql`
    select exists (select 1 from cities where country_code = ${countryCode}) as yes`)).yes
}

// Places in a country (optionally one region) whose name starts with the
// search, biggest first: "mum" finds Mumbai before Mumbra.
export async function searchCities(
  db: Queryable,
  countryCode: string,
  opts: { regionCode?: string | null; search?: string; limit?: number }
): Promise<City[]> {
  const prefix = (opts.search ?? '').trim().toLowerCase().replace(/[\\%_]/g, c => `\\${c}`)
  return many<City>(db, sql`
    select id, name, region_code from cities
    where country_code = ${countryCode}
      ${opts.regionCode ? sql`and region_code = ${opts.regionCode}` : empty}
      ${prefix ? sql`and (lower(ascii_name) like ${prefix + '%'} or lower(name) like ${prefix + '%'})` : empty}
    order by population desc, name, id
    limit ${opts.limit ?? 20}`)
}

// A place by name within a country (and region, when given), case-insensitive
// on the local or ASCII spelling. The biggest wins where names repeat.
export async function findCity(
  db: Queryable,
  countryCode: string,
  regionCode: string | null,
  value: string
): Promise<City | null> {
  return maybeOne<City>(db, sql`
    select id, name, region_code from cities
    where country_code = ${countryCode}
      ${regionCode ? sql`and region_code = ${regionCode}` : empty}
      and (lower(name) = lower(${value}) or lower(ascii_name) = lower(${value}))
    order by population desc, id
    limit 1`)
}

// ═══ Airports ════════════════════════════════════════════════════════════════
// OurAirports (public domain), inserted by 20261008000000_airports.

export interface Airport {
  code: string
  name: string
  city: string
  country_code: string
  country: string
}

// Lower-case ASCII, as the *_search columns hold it: "São" finds Sao Paulo.
function foldSearch(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim()
}

// Airports matching a code, city, airport name or country, best match first:
// the exact code, then a code starting with it, a city starting with it, a city
// containing it, an airport name starting with it, containing it, then a
// country starting with it. Within each, airports with airline service and
// bigger airports first. With no search, India's served airports.
export async function searchAirports(db: Queryable, search: string, limit = 40): Promise<Airport[]> {
  const q = foldSearch(search)
  const like = q.replace(/[\\%_]/g, c => `\\${c}`)
  const code = q.toUpperCase()
  const codePrefix = /^[a-z]{1,3}$/.test(q)
  return many<Airport>(db, sql`
    select a.code, a.name, a.city, a.country_code, c.name as country
    from airports a join countries c on c.code = a.country_code
    where ${q
      ? sql`(a.code = ${code}
          ${codePrefix ? sql`or a.code like ${code + '%'}` : empty}
          or a.city_search like ${'%' + like + '%'}
          or a.name_search like ${'%' + like + '%'}
          or lower(c.name) like ${like + '%'})`
      : sql`a.country_code = 'IN' and a.scheduled`}
    order by
      case
        when a.code = ${code} then 0
        when ${codePrefix} and a.code like ${code + '%'} then 1
        when a.city_search like ${like + '%'} then 2
        when a.city_search like ${'%' + like + '%'} then 3
        when a.name_search like ${like + '%'} then 4
        when a.name_search like ${'%' + like + '%'} then 5
        else 6
      end,
      a.scheduled desc,
      case a.kind when 'large_airport' then 0 when 'medium_airport' then 1 else 2 end,
      a.city, a.code
    limit ${limit}`)
}

export async function findAirport(db: Queryable, code: string): Promise<Airport | null> {
  return maybeOne<Airport>(db, sql`
    select a.code, a.name, a.city, a.country_code, c.name as country
    from airports a join countries c on c.code = a.country_code
    where a.code = ${code.trim().toUpperCase()}`)
}
