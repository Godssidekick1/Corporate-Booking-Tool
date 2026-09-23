import { sql, many, maybeOne, one, exec, type Queryable } from '@/app/lib/db/sql'
import { searchAcross, page } from '@/app/lib/db/fragments'
import type { Row } from '@/app/lib/db/types.generated'
import type { PageParams } from '@/app/lib/pagination'

// ── Reference data ───────────────────────────────────────────────────────────
// Owns: airlines, amadeus_session.
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
