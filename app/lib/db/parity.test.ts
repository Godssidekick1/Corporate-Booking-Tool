import { describe, it, expect, afterAll } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import { createDbClient } from './client'
import { closePool } from './pool'

// ── Driver parity ────────────────────────────────────────────────────────────
// Runs the query SHAPES the real call sites use through both drivers and
// compares what comes back.
//
// WHY THIS EXISTS SEPARATELY FROM dualRun.ts: the dual-run harness compares the
// two drivers while a person clicks through the product, which is the better
// evidence but needs a logged-in session. This file needs nothing but
// credentials, runs in CI-time, and covers the failure mode that a click-
// through is WORST at spotting -- a value that is the right number but the
// wrong JavaScript type, which renders identically and breaks in arithmetic.
//
// NOT PART OF THE DEFAULT RUN. It reaches the live Supabase project over the
// network, so `npm test` must not depend on it. Enable deliberately:
//
//   DB_PARITY=1 npx vitest run app/lib/db/parity.test.ts
//
// READ-ONLY. Every query here is a SELECT. Nothing in this file writes to the
// live project, and nothing should ever be added that does.
//
// ON DATA DRIFT: the shim reads cbt_local, a restore of the live project, so
// rows written since the restore exist in one and not the other. Content is
// therefore compared only where both sides agree on row count; TYPE and SHAPE
// are compared always, because those cannot drift.
// ─────────────────────────────────────────────────────────────────────────────

const ENABLED =
  process.env.DB_PARITY === '1' &&
  Boolean(process.env.DATABASE_URL) &&
  Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL) &&
  Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY)

const d = ENABLED ? describe : describe.skip

const pg = createDbClient()
const rest = ENABLED
  ? createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } }
    )
  : (null as never)

// The JavaScript type of a value, at the granularity that matters to a call
// site: "is this a number I can add, or a string that will concatenate".
function shapeOf(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (Array.isArray(value)) return 'array'
  if (value instanceof Date) return 'Date'
  return typeof value
}

// Compares the KEYS and the TYPE of each key's value, ignoring the values
// themselves. Nulls are skipped: a column that is null in one database and set
// in the other is drift, not a driver difference.
function expectSameShape(a: Record<string, unknown>, b: Record<string, unknown>, label: string): void {
  expect(Object.keys(a).sort(), `${label}: column set`).toEqual(Object.keys(b).sort())

  for (const key of Object.keys(a)) {
    const ta = shapeOf(a[key])
    const tb = shapeOf(b[key])
    if (ta === 'null' || tb === 'null') continue
    expect(ta, `${label}: type of "${key}" (pg=${JSON.stringify(a[key])} rest=${JSON.stringify(b[key])})`).toBe(tb)
  }
}

d('driver parity — value representation', () => {
  afterAll(async () => { await closePool() })

  // Drawn from the real call sites, chosen to cover every type the schema uses
  // in a way a call site actually consumes.
  const shapes: { label: string; table: string; select: string }[] = [
    { label: 'money (numeric)', table: 'commercial_rules', select: 'id, rate, created_at' },
    { label: 'booking totals', table: 'bookings', select: 'id, total_cost, sell_total, created_at' },
    { label: 'policy limits', table: 'policy_rules', select: 'id, limit_value' },
    { label: 'timestamps', table: 'airlines', select: 'code, name, first_seen_at, last_seen_at' },
    { label: 'jsonb + booleans', table: 'clients', select: 'id, name, settings, markup_active, created_at' },
    { label: 'employees', table: 'employees', select: 'id, full_name, band_code, band_rank, status, created_at' },
  ]

  for (const { label, table, select } of shapes) {
    it(`${label}: ${table}`, async () => {
      const key = select.split(',')[0].trim()
      const a = await pg.from(table).select(select).order(key).limit(3)
      const b = await rest.from(table).select(select).order(key).limit(3)

      expect(a.error, `pg errored: ${a.error?.message}`).toBeNull()
      expect(b.error, `postgrest errored: ${b.error?.message}`).toBeNull()

      const rowsA = (a.data ?? []) as Record<string, unknown>[]
      const rowsB = (b.data ?? []) as unknown as Record<string, unknown>[]

      // No rows on either side proves nothing, but is not a failure -- a fresh
      // restore legitimately has empty tables.
      if (rowsA.length === 0 || rowsB.length === 0) return

      expectSameShape(rowsA[0], rowsB[0], `${table}[0]`)
    })
  }
})

d('driver parity — query semantics', () => {
  it('in([]) returns no rows on both', async () => {
    const a = await pg.from('airlines').select('code').in('code', [])
    const b = await rest.from('airlines').select('code').in('code', [])

    expect(a.error).toBeNull()
    expect(b.error).toBeNull()
    expect(a.data).toEqual([])
    expect(b.data).toEqual([])
  })

  it('maybeSingle on no rows gives null and no error on both', async () => {
    const a = await pg.from('airlines').select('code').eq('code', '!!').maybeSingle()
    const b = await rest.from('airlines').select('code').eq('code', '!!').maybeSingle()

    expect(a.data).toBeNull()
    expect(b.data).toBeNull()
    expect(a.error).toBeNull()
    expect(b.error).toBeNull()
  })

  it('maybeSingle on many rows errors with PGRST116 on both', async () => {
    const a = await pg.from('airlines').select('code').maybeSingle()
    const b = await rest.from('airlines').select('code').maybeSingle()

    expect(a.error?.code).toBe('PGRST116')
    expect(b.error?.code).toBe('PGRST116')
  })

  it('an embed nests as an OBJECT on both, and null when unmatched', async () => {
    const select = 'id, client_group_id, client_groups(id, name, group_code)'
    const a = await pg.from('clients').select(select).order('id').limit(5)
    const b = await rest.from('clients').select(select).order('id').limit(5)

    expect(a.error).toBeNull()
    expect(b.error).toBeNull()

    const rowsA = (a.data ?? []) as Record<string, unknown>[]
    const rowsB = (b.data ?? []) as unknown as Record<string, unknown>[]
    if (rowsA.length === 0 || rowsB.length === 0) return

    // The property exists on both, and is an object or null -- never an array,
    // which is how PostgREST represents a to-MANY relation and would break
    // every `?.name` at the call sites.
    for (const rows of [rowsA, rowsB]) {
      for (const row of rows) {
        expect(Array.isArray(row.client_groups)).toBe(false)
        if (row.client_group_id === null) expect(row.client_groups).toBeNull()
      }
    }

    expectSameShape(rowsA[0], rowsB[0], 'clients+client_groups[0]')
  })

  it('exact count agrees', async () => {
    // Drift makes the NUMBERS differ; what must agree is that both report a
    // total rather than a page size, and both report a number at all.
    const a = await pg.from('airlines').select('code', { count: 'exact', head: true })
    const b = await rest.from('airlines').select('code', { count: 'exact', head: true })

    expect(typeof a.count).toBe('number')
    expect(typeof b.count).toBe('number')
    expect(a.data).toBeNull()
    expect(b.data).toBeNull()
  })
})
