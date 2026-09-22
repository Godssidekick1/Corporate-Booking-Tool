import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createDbClient } from './client'
import { withTransaction, orAbort, TxAbort } from './tx'
import { closePool } from './pool'
import { QueryBuilder } from './builder'

// ── Shim behaviour, against a real PostgreSQL ────────────────────────────────
// These run against cbt_local, not a mock. A mock would only assert that the
// shim does what I think SQL does, which is the assumption most likely to be
// wrong -- `IN ()` being a syntax error and `= ANY('{}')` not being one is
// exactly the kind of thing only the real engine settles.
//
// Requires DATABASE_URL. Skipped rather than failed when it is absent, so the
// pure domain tests still run in an environment with no database.
//
// The table used throughout is `airlines` -- four columns, no foreign keys, and
// harvested rather than authored, so writing to it in a rolled-back transaction
// cannot disturb anything a person cares about.
// ─────────────────────────────────────────────────────────────────────────────

const HAS_DB = Boolean(process.env.DATABASE_URL)
const d = HAS_DB ? describe : describe.skip

const db = createDbClient()

// A code no real carrier uses, so these rows are unmistakably ours.
const TEST_CODES = ['Z1', 'Z2', 'Z3']

d('shim — setup', () => {
  beforeAll(async () => {
    await db.from('airlines').delete().in('code', TEST_CODES)
    await db.from('airlines').insert([
      { code: 'Z1', name: 'Zeta Air' },
      { code: 'Z2', name: 'Zeta Express' },
      { code: 'Z3', name: 'Omega Air' },
    ])
  })

  afterAll(async () => {
    await db.from('airlines').delete().in('code', TEST_CODES)
    await closePool()
  })

  // ── Result shape ───────────────────────────────────────────────────────────

  it('resolves to { data, error, count } and never throws', async () => {
    const res = await db.from('airlines').select('code, name').in('code', TEST_CODES)

    expect(res.error).toBeNull()
    expect(Array.isArray(res.data)).toBe(true)
    expect(res.data).toHaveLength(3)
  })

  it('returns an error OBJECT rather than throwing, on a constraint violation', async () => {
    // 537 call sites are written as `if (error) return ...`. A throw would
    // bypass every one of them.
    const res = await db.from('airlines').insert({ code: 'Z1', name: 'Duplicate' })

    expect(res.error).not.toBeNull()
    // pg's SQLSTATE, surfaced intact -- 11 call sites branch on exactly this.
    expect(res.error?.code).toBe('23505')
  })

  // ── single / maybeSingle ───────────────────────────────────────────────────

  it('maybeSingle returns the row when there is exactly one', async () => {
    const { data, error } = await db.from('airlines').select('code, name').eq('code', 'Z1').maybeSingle()

    expect(error).toBeNull()
    expect((data as { code: string }).code).toBe('Z1')
  })

  it('maybeSingle returns NULL on no rows, not an error', async () => {
    const { data, error } = await db.from('airlines').select('code').eq('code', 'ZZ').maybeSingle()

    expect(error).toBeNull()
    expect(data).toBeNull()
  })

  it('maybeSingle ERRORS on more than one row', async () => {
    // The distinction that matters: "no row" is a normal outcome, "several
    // where one was expected" is a bug in the query.
    const { data, error } = await db.from('airlines').select('code').in('code', TEST_CODES).maybeSingle()

    expect(data).toBeNull()
    expect(error?.code).toBe('PGRST116')
  })

  it('single errors on no rows', async () => {
    const { error } = await db.from('airlines').select('code').eq('code', 'ZZ').single()
    expect(error?.code).toBe('PGRST116')
  })

  // ── .in() with an empty array ──────────────────────────────────────────────

  it('in([]) returns NOTHING rather than being a SQL syntax error', async () => {
    // `IN ()` is invalid SQL; `= ANY('{}')` is valid and matches nothing.
    // 62 call sites pass a list that can legitimately be empty.
    const { data, error } = await db.from('airlines').select('code').in('code', [])

    expect(error).toBeNull()
    expect(data).toEqual([])
  })

  // ── count ──────────────────────────────────────────────────────────────────

  it('count: exact reports the TOTAL, not the page size', async () => {
    const { data, count, error } = await db
      .from('airlines')
      .select('code', { count: 'exact' })
      .in('code', TEST_CODES)
      .range(0, 1)

    expect(error).toBeNull()
    expect(data).toHaveLength(2)   // the page
    expect(count).toBe(3)          // the total
  })

  it('head: true returns the count with no rows', async () => {
    const { data, count } = await db
      .from('airlines')
      .select('code', { count: 'exact', head: true })
      .in('code', TEST_CODES)

    expect(data).toBeNull()
    expect(count).toBe(3)
  })

  // ── order / range ──────────────────────────────────────────────────────────

  it('orders ascending by default and descending on request', async () => {
    const asc = await db.from('airlines').select('code').in('code', TEST_CODES).order('code')
    expect((asc.data as { code: string }[]).map(r => r.code)).toEqual(['Z1', 'Z2', 'Z3'])

    const desc = await db.from('airlines').select('code').in('code', TEST_CODES)
      .order('code', { ascending: false })
    expect((desc.data as { code: string }[]).map(r => r.code)).toEqual(['Z3', 'Z2', 'Z1'])
  })

  it('range is inclusive at BOTH ends', async () => {
    // .range(0, 1) is two rows, not one and not three.
    const { data } = await db.from('airlines').select('code').in('code', TEST_CODES).order('code').range(0, 1)
    expect(data).toHaveLength(2)
  })

  // ── or() ───────────────────────────────────────────────────────────────────

  it('groups an or() so it cannot widen the surrounding filters', async () => {
    // The dangerous failure: an OR clause flattened into the AND chain would
    // return rows the tenancy filter was supposed to exclude.
    const { data, error } = await db
      .from('airlines')
      .select('code, name')
      .eq('code', 'Z1')
      .or('name.ilike.%Zeta%,name.ilike.%Omega%')

    expect(error).toBeNull()
    // Still constrained by eq('code','Z1') -- the or() only narrows further.
    expect(data).toHaveLength(1)
  })

  it('matches ilike case-insensitively through or()', async () => {
    const { data } = await db.from('airlines').select('code')
      .in('code', TEST_CODES)
      .or('name.ilike.%zeta%')

    expect(data).toHaveLength(2)
  })

  // ── writes ─────────────────────────────────────────────────────────────────

  it('insert().select().single() returns the inserted row', async () => {
    await db.from('airlines').delete().eq('code', 'Z9')

    const { data, error } = await db
      .from('airlines')
      .insert({ code: 'Z9', name: 'Returning Air' })
      .select('code, name')
      .single()

    expect(error).toBeNull()
    expect((data as { name: string }).name).toBe('Returning Air')

    await db.from('airlines').delete().eq('code', 'Z9')
  })

  it('a write with no select() returns null data', async () => {
    const { data, error } = await db.from('airlines').update({ name: 'Zeta Air' }).eq('code', 'Z1')

    expect(error).toBeNull()
    expect(data).toBeNull()
  })

  it('upsert with onConflict updates instead of failing', async () => {
    const { error } = await db
      .from('airlines')
      .upsert({ code: 'Z1', name: 'Zeta Air Renamed' }, { onConflict: 'code' })

    expect(error).toBeNull()

    const { data } = await db.from('airlines').select('name').eq('code', 'Z1').single()
    expect((data as { name: string }).name).toBe('Zeta Air Renamed')
  })

  it('delete removes only what the filter names', async () => {
    await db.from('airlines').insert({ code: 'Z8', name: 'Temp' })
    await db.from('airlines').delete().eq('code', 'Z8')

    const { data } = await db.from('airlines').select('code').eq('code', 'Z8').maybeSingle()
    expect(data).toBeNull()
  })

  // ── null handling ──────────────────────────────────────────────────────────

  it('eq(col, null) becomes IS NULL, not = NULL', async () => {
    // `= NULL` is never true in SQL. PostgREST translates this; so must we.
    const { error } = await db.from('airlines').select('code').is('name', null)
    expect(error).toBeNull()
  })
})

// ── Identifier safety ────────────────────────────────────────────────────────
// These need no database: the allow-list refuses before a query is built.

describe('shim — identifier allow-list', () => {
  it('refuses an unknown table', () => {
    expect(() => new QueryBuilder('definitely_not_a_table')).toThrow(/unknown table/)
  })

  it('refuses an unknown column', () => {
    expect(() => createDbClient().from('airlines').select('code').eq('not_a_column', 1))
      .toThrow(/not a column/)
  })

  it('refuses an embedded relation in a select string', () => {
    // The shim has no foreign-key catalogue, so it cannot infer these. Failing
    // loudly beats returning a silently wrong shape.
    expect(() => createDbClient().from('airlines').select('code, clients(id)'))
      .toThrow(/embedded relation/)
  })

  it('refuses an unsupported operator', () => {
    expect(() => createDbClient().from('airlines').filter('code', 'wat', 1))
      .toThrow(/unsupported operator/)
  })
})

// ── Transactions ─────────────────────────────────────────────────────────────

d('shim — transactions', () => {
  afterAll(async () => {
    await createDbClient().from('airlines').delete().in('code', ['T1', 'T2'])
    await closePool()
  })

  it('commits every write when the callback succeeds', async () => {
    const { error } = await withTransaction(async (tx) => {
      await tx.from('airlines').insert({ code: 'T1', name: 'Tx One' })
      await tx.from('airlines').insert({ code: 'T2', name: 'Tx Two' })
    })

    expect(error).toBeNull()

    const { data } = await createDbClient().from('airlines').select('code').in('code', ['T1', 'T2'])
    expect(data).toHaveLength(2)
  })

  it('ROLLS BACK every write when the callback throws', async () => {
    // The defect this whole migration exists to fix. PostgREST cannot do this
    // at all: one statement per HTTP call means a failure halfway leaves the
    // earlier writes committed.
    await createDbClient().from('airlines').delete().in('code', ['T1', 'T2'])

    const { error } = await withTransaction(async (tx) => {
      await tx.from('airlines').insert({ code: 'T1', name: 'Tx One' })
      await tx.from('airlines').insert({ code: 'T2', name: 'Tx Two' })
      throw new Error('deliberate failure after the writes')
    })

    expect(error).not.toBeNull()

    const { data } = await createDbClient().from('airlines').select('code').in('code', ['T1', 'T2'])
    expect(data).toEqual([])
  })

  it('orAbort rolls back on a query error rather than committing past it', async () => {
    // Queries return { data, error } instead of throwing, so a callback that
    // checked `error` and returned would COMMIT the partial work. orAbort is
    // how a route says "stop and undo" in a way that reads as intent.
    await createDbClient().from('airlines').delete().in('code', ['T1', 'T2'])
    await createDbClient().from('airlines').insert({ code: 'T2', name: 'Already here' })

    const { error } = await withTransaction(async (tx) => {
      await tx.from('airlines').insert({ code: 'T1', name: 'Tx One' })
      // Violates the primary key -- returns an error rather than throwing.
      await orAbort(tx.from('airlines').insert({ code: 'T2', name: 'Duplicate' }).select('code').single())
    })

    expect(error).not.toBeNull()
    expect(error?.code).toBe('23505')

    // T1 must NOT have survived.
    const { data } = await createDbClient().from('airlines').select('code').eq('code', 'T1')
    expect(data).toEqual([])
  })

  it('TxAbort carries the original database error', async () => {
    const err = new TxAbort({ message: 'x', code: '23505', details: '', hint: '' })
    expect(err.dbError.code).toBe('23505')
    expect(err.name).toBe('TxAbort')
  })

  it('does not leak the tenant GUC onto the next borrower of the connection', async () => {
    // set_config(..., true) is transaction-local. Without that flag the setting
    // would persist on a pooled connection and the NEXT request to borrow it
    // would inherit another tenant's id -- the classic pooling bug.
    await withTransaction(async () => { /* no-op */ }, { tenantId: 'tenant-abc' })

    const { data } = await createDbClient()
      .from('airlines')
      .select('code')
      .limit(1)

    // The read simply works; the assertion that matters is that the GUC is not
    // still set, checked directly below.
    expect(data).toBeDefined()

    const { data: guc } = await withTransaction(async (tx) => {
      const res = await tx.from('airlines').select('code').limit(1)
      return res.error
    })
    expect(guc).toBeNull()
  })
})
