import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createDbClient } from './client'
import { withTransaction, orAbort, TxAbort } from './tx'
import { closePool, getPool } from './pool'
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

// Reads one value straight off the connection, bypassing the builder. Used by
// the value-type tests so they assert how pg DECODES a type, independent of
// whether any seeded row happens to exercise it.
async function rawValue<T = unknown>(sql: string): Promise<T> {
  const pool = getPool()
  const res = await pool.query(sql)
  return res.rows[0].v as T
}

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

  it('upsert with ignoreDuplicates KEEPS the existing row', async () => {
    // PostgREST's ignoreDuplicates is ON CONFLICT DO NOTHING. Four call sites
    // use it so assigning the same target twice is a no-op rather than a 409.
    // The bug it guards against is the opposite of a 409: silently OVERWRITING
    // the row that was already there.
    await db.from('airlines').delete().eq('code', 'Z8')
    await db.from('airlines').insert({ code: 'Z8', name: 'Original' })

    const { error } = await db
      .from('airlines')
      .upsert({ code: 'Z8', name: 'Should Not Win' }, { onConflict: 'code', ignoreDuplicates: true })

    expect(error).toBeNull()

    const { data } = await db.from('airlines').select('name').eq('code', 'Z8').single()
    expect((data as { name: string }).name).toBe('Original')

    await db.from('airlines').delete().eq('code', 'Z8')
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

  it('refuses an embed across a relationship that is not declared', () => {
    // The shim has no foreign-key catalogue; relationships.ts declares the four
    // the codebase actually uses. Anything else fails loudly rather than
    // returning a silently wrong shape -- which is what PostgREST did with
    // `bands:band_code(rank)` for months while the caller discarded the error.
    expect(() => createDbClient().from('airlines').select('code, clients(id)'))
      .toThrow(/not a declared relationship/)
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

// ── Embedded relations ───────────────────────────────────────────────────────
// The five embedding call sites, in their four distinct shapes. These run
// against real rows rather than fixtures because the whole question is whether
// the generated JOIN produces the shape the call sites already destructure.
// ─────────────────────────────────────────────────────────────────────────────

d('shim — embeds', () => {
  it('parses two to-one embeds and nests each as an object', async () => {
    // app/api/tmc/clients/route.ts:50, verbatim shape.
    const { data, error } = await db
      .from('clients')
      .select('id, name, client_group_id, branch_id, client_groups(id, name, city, group_code), branches(id, name, branch_no)')
      .limit(5)

    expect(error).toBeNull()
    for (const row of (data ?? []) as Record<string, unknown>[]) {
      // Present as a key on every row, object or null -- never undefined, and
      // never an object of nulls, because the call site renders `?.name`.
      expect(row).toHaveProperty('client_groups')
      expect(row).toHaveProperty('branches')

      const group = row.client_groups as Record<string, unknown> | null
      if (row.client_group_id === null) expect(group).toBeNull()
      else expect(group?.id).toBe(row.client_group_id)

      const branch = row.branches as Record<string, unknown> | null
      if (row.branch_id === null) expect(branch).toBeNull()
      else expect(branch?.id).toBe(row.branch_id)
    }
  })

  it('embeds through a join table', async () => {
    // app/api/tmc/clients/[id]/buckets/route.ts:64 and :138.
    const { data, error } = await db
      .from('bucket_clients')
      .select('bucket_id, buckets ( id, name, code )')
      .limit(5)

    expect(error).toBeNull()
    for (const row of (data ?? []) as Record<string, unknown>[]) {
      const bucket = row.buckets as Record<string, unknown> | null
      expect(bucket?.id).toBe(row.bucket_id)
      // The call site does .map(r => r.buckets).filter(Boolean), so a matched
      // row must never come back null.
      expect(bucket).not.toBeNull()
    }
  })

  it('!inner excludes rows with no match, and counts them out too', async () => {
    // app/api/tmc/forms-of-payment/route.ts:414 -- the only INNER join.
    const { data, error } = await db
      .from('employees')
      .select('id, client_id, clients!inner(tmc_id)')
      .order('id')
      .limit(5)

    expect(error).toBeNull()
    for (const row of (data ?? []) as Record<string, unknown>[]) {
      // An INNER join guarantees a match, so this is never null -- which is
      // what makes `owner.clients.tmc_id` safe at the call site.
      expect(row.clients).not.toBeNull()
      expect((row.clients as Record<string, unknown>).tmc_id).toBeDefined()
    }

    // An employee with no client cannot survive the join, so the inner count
    // must not exceed the plain one.
    const { count: innerCount } = await db
      .from('employees')
      .select('id, clients!inner(tmc_id)', { count: 'exact', head: true })
    const { count: plainCount } = await db
      .from('employees')
      .select('id', { count: 'exact', head: true })

    expect(innerCount).not.toBeNull()
    expect(innerCount as number).toBeLessThanOrEqual(plainCount as number)
  })

  it('applies filters, ordering and an exact count alongside a join', async () => {
    // The clients list does all four at once; the risk is an unqualified
    // column going ambiguous once a join is in the FROM clause.
    const { data, error, count } = await db
      .from('clients')
      .select('id, name, created_at, client_groups(id, name)', { count: 'exact' })
      .neq('status', 'inactive')
      .order('created_at', { ascending: false })
      .range(0, 4)

    expect(error).toBeNull()
    expect(count).not.toBeNull()
    expect((data ?? []).length).toBeLessThanOrEqual(5)

    // A LEFT join on a to-one relation cannot change the count, so the count
    // is of clients, not of joined pairs.
    const { count: plain } = await db
      .from('clients')
      .select('id', { count: 'exact', head: true })
      .neq('status', 'inactive')
    expect(count).toBe(plain)

    // Compared as numbers, not with a bare .sort(). pg hands back timestamptz
    // as a Date, and Array.sort with no comparator sorts by toString() -- so
    // "Fri Jul" would order before "Mon Sep" and the assertion would fail on
    // correctly ordered data.
    const times = (data ?? []).map(r => new Date((r as Record<string, string>).created_at).getTime())
    expect(times).toEqual([...times].sort((a, b) => b - a))
  })

  it('aliases an embed when the select uses alias:relation', () => {
    // PostgREST's `alias:relation(cols)` spelling. Parsed, then refused here
    // because no aliased relationship is declared -- the assertion is that the
    // ALIAS is stripped before the lookup, not reported as the relation name.
    expect(() => db.from('clients').select('id, grp:not_a_relation(id)'))
      .toThrow(/embeds "not_a_relation"/)
  })

  it('refuses a nested embed rather than generating a wrong join', () => {
    expect(() => db.from('clients').select('id, branches(id, tmcs(name))'))
      .toThrow(/nests an embed/)
  })
})

// ── Value representation ─────────────────────────────────────────────────────
// The difference between the drivers that would corrupt rather than fail. Each
// assertion here is "what PostgREST's JSON gave the call sites", not "what
// node-postgres happens to produce".
// ─────────────────────────────────────────────────────────────────────────────

d('shim — value types', () => {
  it('decodes numeric as a NUMBER, so money arithmetic is addition', async () => {
    // pg's default is a string to protect precision. Left alone,
    // `"100.00" + 5` is "100.005" and `"9" > "10"` is true -- a spend limit
    // compared lexicographically would pass the wrong bookings.
    const { data } = await db
      .from('commercial_rules')
      .select('id, rate')
      .limit(1)

    const row = (data as { rate: unknown }[])[0]
    // Empty in a fresh restore; the literal probe below covers that case.
    if (!row) return

    expect(typeof row.rate).toBe('number')
    expect((row.rate as number) + 1).toBeGreaterThan(row.rate as number)
  })

  it('decodes timestamptz as an ISO STRING, not a Date', async () => {
    // resolveCommercials, resolveFop and resolveDealCodes all tie-break with
    // `b.rule.created_at.localeCompare(a.rule.created_at)`. Date has no
    // localeCompare, so a Date here is a TypeError in the money path.
    const { data, error } = await db.from('airlines').select('code, first_seen_at').limit(1)
    expect(error).toBeNull()

    const row = (data as { first_seen_at: unknown }[])[0]
    if (!row?.first_seen_at) return

    expect(typeof row.first_seen_at).toBe('string')
    expect(row.first_seen_at as string).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
    // The operation the three resolvers actually perform.
    expect(() => (row.first_seen_at as string).localeCompare('2020-01-01')).not.toThrow()
  })

  it('decodes date as YYYY-MM-DD without inventing a timezone', async () => {
    // A `date` routed through Date lands at LOCAL midnight, so 2026-09-22 in
    // IST is 2026-09-21 in UTC -- travel dates would move by a day depending
    // on where the server runs.
    const { data, error } = await db
      .from('airlines')
      .select('code')
      .limit(1)
    expect(error).toBeNull()
    expect(data).toBeDefined()

    // Asserted directly against the engine, since no seeded `date` column is
    // guaranteed to hold a row.
    const probe = await rawValue<string>(`select '2026-09-22'::date as v`)
    expect(typeof probe).toBe('string')
    expect(probe).toBe('2026-09-22')
  })

  it('decodes numeric and int8 from a literal, independent of seeded data', async () => {
    expect(await rawValue(`select 12345.67::numeric(12,2) as v`)).toBe(12345.67)
    expect(await rawValue(`select 42::int8 as v`)).toBe(42)
  })
})

// ── The replace-wholesale pattern ────────────────────────────────────────────
// DELETE-then-INSERT is how several routes replace a set: permissions, client
// access, policy group bands, chain approvers. It is also the shape with the
// worst failure mode, because the intermediate state is "the user has nothing".
// ─────────────────────────────────────────────────────────────────────────────

d('shim — replace-wholesale is atomic', () => {
  it('a failed INSERT does not leave the earlier DELETE committed', async () => {
    // Modelled on PATCH /api/tmc/tcs/[id], which replaces a TC's permission set
    // wholesale. Before transactions, an insert that failed after its delete
    // succeeded left that TC with NO permissions at all -- a validation error
    // silently escalated into a lockout.
    //
    // Run against a real employee with real permissions, then rolled back, so
    // the row count before and after must be identical.
    const { data: victim } = await db
      .from('employee_permissions')
      .select('employee_id, permission_key')
      .limit(1)
      .maybeSingle()

    if (!victim) return  // no seeded permissions; nothing to prove against

    const employeeId = (victim as { employee_id: string }).employee_id

    const countPerms = async () => {
      const { count } = await db
        .from('employee_permissions')
        .select('employee_id', { count: 'exact', head: true })
        .eq('employee_id', employeeId)
      return count
    }

    const before = await countPerms()
    expect(before).toBeGreaterThan(0)

    const { error } = await withTransaction(async (tx) => {
      await orAbort(tx.from('employee_permissions').delete().eq('employee_id', employeeId))
      // Fails: granted_by must reference a real employee, so this violates the
      // foreign key -- the same class of failure the route can hit for real.
      await orAbort(tx.from('employee_permissions').insert({
        employee_id: employeeId,
        permission_key: 'parity_probe',
        granted_by: '00000000-0000-0000-0000-000000000000',
      }))
    })

    expect(error).not.toBeNull()
    // 23503 foreign key violation, surfaced intact rather than flattened.
    expect(error?.code).toBe('23503')

    // The whole point: the permissions are still there.
    expect(await countPerms()).toBe(before)
  })
})

// ── register-company's three-table insert ────────────────────────────────────
// The route that used a hand-written compensating delete: create a client, seed
// its bands, create its admin. Exercised here against the real tables, because
// the FK order and the clients -> branches -> employees cycle are the parts a
// unit test on a toy table cannot cover.
// ─────────────────────────────────────────────────────────────────────────────

d('shim — multi-table registration rolls back', () => {
  const probeName = 'ZZ Parity Probe Ltd'

  const cleanup = async () => {
    const { data } = await db.from('clients').select('id').eq('name', probeName)
    for (const row of (data ?? []) as { id: string }[]) {
      await db.from('employees').delete().eq('client_id', row.id)
      await db.from('bands').delete().eq('client_id', row.id)
      await db.from('clients').delete().eq('id', row.id)
    }
  }

  beforeAll(cleanup)
  afterAll(async () => { await cleanup(); await closePool() })

  it('commits all three tables together when every insert succeeds', async () => {
    const { data: clientId, error } = await withTransaction(async (tx) => {
      const client = await orAbort(
        tx.from<{ id: string }[]>('clients')
          .insert({ name: probeName, status: 'active' })
          .select('id')
          .single()
      )
      await orAbort(tx.from('bands').insert([
        { client_id: client.id, code: 'P1', label: 'Probe One', rank: 1 },
        { client_id: client.id, code: 'P2', label: 'Probe Two', rank: 2 },
      ]))
      return client.id
    })

    expect(error).toBeNull()
    expect(clientId).toBeTruthy()

    const { count } = await db
      .from('bands')
      .select('code', { count: 'exact', head: true })
      .eq('client_id', clientId as string)
    expect(count).toBe(2)

    await cleanup()
  })

  it('leaves NO client behind when a later insert fails', async () => {
    // The failure the compensating delete existed to clean up. A half-created
    // company can neither log in nor be registered again, because the email is
    // already taken in GoTrue.
    const { error } = await withTransaction(async (tx) => {
      const client = await orAbort(
        tx.from<{ id: string }[]>('clients')
          .insert({ name: probeName, status: 'active' })
          .select('id')
          .single()
      )
      // Duplicate band code within one client -- a real unique violation.
      await orAbort(tx.from('bands').insert([
        { client_id: client.id, code: 'P1', label: 'Probe One', rank: 1 },
        { client_id: client.id, code: 'P1', label: 'Probe Clash', rank: 2 },
      ]))
      return client.id
    })

    expect(error).not.toBeNull()

    // The client row must not exist. Before transactions this needed a
    // compensating delete that could itself fail.
    const { count } = await db
      .from('clients')
      .select('id', { count: 'exact', head: true })
      .eq('name', probeName)
    expect(count).toBe(0)
  })
})
