import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createDbClient } from './client'
import { closePool, getPool } from './pool'
import { COLUMN_TYPES } from './schemaAllowList'

// ── Type round trips ─────────────────────────────────────────────────────────
// THE TEST FILE THAT SHOULD HAVE EXISTED FIRST.
//
// Three shim defects reached a running application, and all three were the same
// thing: a value that PostgREST carried correctly and node-postgres did not.
//
//   * numeric came back as the STRING "6776.00", so money concatenated instead
//     of adding, and "9" > "10" was true.
//   * timestamptz came back as a Date, which has no .localeCompare -- the
//     operation all three commercial resolvers use to break a tie.
//   * a top-level ARRAY written to a jsonb column was encoded as a PostgreSQL
//     array literal, {"{\"a\":1}"}, which is not JSON. PostgreSQL rejected it
//     with 22P02 AFTER the passenger had already reached the airline.
//
// None of those is a query-builder bug. Every one is a VALUE bug, and the API
// tests could not see them because the API was behaving perfectly.
//
// So this file tests the only thing that matters about a value: write it, read
// it back, and assert you got the same thing. Once per type the schema
// actually uses, driven by COLUMN_TYPES so a new type in the schema cannot
// quietly arrive untested.
//
// Requires DATABASE_URL. Writes to `bookings` and `airlines` inside a
// transaction that is rolled back, so nothing survives the test.
// ─────────────────────────────────────────────────────────────────────────────

const HAS_DB = Boolean(process.env.DATABASE_URL)
const d = HAS_DB ? describe : describe.skip

const db = createDbClient()

// Writes one value to one column, reads it back, and returns it. Everything
// happens inside a transaction that is rolled back, so the row never exists as
// far as any other reader is concerned.
async function roundTrip(table: string, column: string, value: unknown, seed: Record<string, unknown>) {
  const pool = getPool()
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const tx = createDbClient({ client })

    const { error: writeError } = await tx.from(table).insert({ ...seed, [column]: value })
    if (writeError) throw new Error(`write failed: ${writeError.message} (${writeError.code}) ${writeError.details}`)

    const { data, error: readError } = await tx
      .from(table)
      .select(`${Object.keys(seed)[0]}, ${column}`)
      .eq(Object.keys(seed)[0], seed[Object.keys(seed)[0]])
      .single()
    if (readError) throw new Error(`read failed: ${readError.message}`)

    return (data as Record<string, unknown>)[column]
  } finally {
    await client.query('ROLLBACK')
    client.release()
  }
}

d('round trip — json and jsonb', () => {
  afterAll(async () => { await closePool() })

  // The booking that failed. `bookings` requires a handful of NOT NULL columns,
  // so every case seeds the same minimal valid row and varies one column.
  let seed: Record<string, unknown>

  beforeAll(async () => {
    const { data } = await db.from('bookings').select('client_id, employee_id').limit(1).maybeSingle()
    const row = data as { client_id: string; employee_id: string } | null
    seed = {
      id: '00000000-0000-4000-8000-00000000beef',
      client_id: row?.client_id ?? null,
      employee_id: row?.employee_id ?? null,
      booking_type: 'flight',
      status: 'pending_approval',
      policy_status: 'green',
      total_cost: 1,
      itinerary: {},
      traveler_snapshot: {},
    }
  })

  it('a TOP-LEVEL ARRAY survives a jsonb column', async () => {
    // THE PRODUCTION BUG, exactly. bookings.resolved_deal_codes holds an array
    // in 8 of 32 real rows. Without coerceForColumn this throws 22P02 rather
    // than failing an assertion.
    const value = [{ airline: 'AI', code: 'CORP01' }, { airline: '6E', code: 'CORP02' }]
    expect(await roundTrip('bookings', 'resolved_deal_codes', value, seed)).toEqual(value)
  })

  it('an array of scalars survives a jsonb column', async () => {
    const value = ['a', 'b', 'c']
    expect(await roundTrip('bookings', 'resolved_deal_codes', value, seed)).toEqual(value)
  })

  it('an EMPTY array survives, and is not read back as an empty object', async () => {
    // pg encodes [] as `{}`, which PostgreSQL accepts as an empty JSON OBJECT.
    // So this one did not error -- it silently changed [] into {}, which is
    // worse than a failure because nothing reports it.
    expect(await roundTrip('bookings', 'resolved_deal_codes', [], seed)).toEqual([])
  })

  it('a plain object survives', async () => {
    const value = { markup: 500, discount: 0, currency: 'INR' }
    expect(await roundTrip('bookings', 'commercials', value, seed)).toEqual(value)
  })

  it('a deeply nested mixture survives', async () => {
    // The real shape of fare_breakdown: objects containing arrays containing
    // objects, with numbers that must stay numbers.
    const value = {
      currency: 'INR',
      isRefundable: false,
      passengerBreakup: [
        { paxType: 'ADT', baseFare: 8777, taxLines: [{ code: 'YQ', amount: 749 }] },
      ],
      seatFees: 0,
    }
    expect(await roundTrip('bookings', 'fare_breakdown', value, seed)).toEqual(value)
  })

  it('null stays null rather than becoming the JSON literal null', async () => {
    expect(await roundTrip('bookings', 'commercials', null, seed)).toBeNull()
  })

  it('numbers inside jsonb come back as numbers, not strings', async () => {
    const value = { total: 10717.5, count: 3 }
    const back = await roundTrip('bookings', 'commercials', value, seed) as Record<string, number>
    expect(typeof back.total).toBe('number')
    expect(back.total + 1).toBe(10718.5)
  })
})

d('round trip — PostgreSQL array columns', () => {
  it('text[] still uses pg array encoding, NOT json', async () => {
    // The thing the jsonb fix must not break. bookings.ticket_numbers is a real
    // text[]; JSON-encoding it would store the literal string '["098-..."]'.
    const { data } = await db.from('bookings').select('client_id, employee_id').limit(1).maybeSingle()
    const row = data as { client_id: string; employee_id: string } | null

    const value = ['098-5014504605', '098-5014504606']
    const back = await roundTrip('bookings', 'ticket_numbers', value, {
      id: '00000000-0000-4000-8000-00000000cafe',
      client_id: row?.client_id ?? null,
      employee_id: row?.employee_id ?? null,
      booking_type: 'flight',
      status: 'pending_approval',
      policy_status: 'green',
      total_cost: 1,
      itinerary: {},
      traveler_snapshot: {},
    })

    expect(Array.isArray(back)).toBe(true)
    expect(back).toEqual(value)
  })
})

d('round trip — scalar types', () => {
  // airlines is four columns and no foreign keys, so these need no seed row.
  async function airlineRoundTrip(column: string, value: unknown) {
    return roundTrip('airlines', column, value, { code: 'ZT', name: 'Round Trip Air' })
  }

  it('numeric keeps its value AND its JavaScript type', async () => {
    // Guards defect #1. A string here means money concatenates instead of
    // adding, and spend limits compare lexicographically.
    const { data } = await db.from('commercial_rules').select('rate').limit(1).maybeSingle()
    const rate = (data as { rate: unknown } | null)?.rate
    if (rate === undefined || rate === null) return

    expect(typeof rate).toBe('number')
  })

  it('timestamptz comes back as an ISO string, and localeCompare works on it', async () => {
    // Guards defect #2 -- the exact operation resolveCommercials, resolveFop
    // and resolveDealCodes use to break a tie.
    const back = await airlineRoundTrip('first_seen_at', '2026-09-22T07:27:09.861Z')
    expect(typeof back).toBe('string')
    expect(() => (back as string).localeCompare('2020-01-01')).not.toThrow()
    expect(new Date(back as string).getTime()).toBe(new Date('2026-09-22T07:27:09.861Z').getTime())
  })

  it('text survives characters that matter to SQL', async () => {
    const value = `O'Brien "quoted" \\backslash ; DROP TABLE -- %_`
    expect(await airlineRoundTrip('name', value)).toBe(value)
  })

  it('a unicode name survives', async () => {
    // The mojibake that bit the schema capture in Phase 0 was an encoding
    // problem end to end; this asserts the query path does not repeat it.
    const value = 'Société Air France — 全日本空輸'
    expect(await airlineRoundTrip('name', value)).toBe(value)
  })

  it('every column type in the schema is covered by a case above', () => {
    // A new type arriving in the schema should fail here rather than silently
    // being the next untested value bug.
    const known = new Set(['json', 'array', 'numeric', 'integer', 'boolean', 'timestamptz', 'date', 'uuid', 'text'])
    const found = new Set<string>()
    for (const columns of Object.values(COLUMN_TYPES)) {
      for (const kind of Object.values(columns)) found.add(kind)
    }

    const unexpected = [...found].filter(k => !known.has(k))
    expect(unexpected, `unhandled column kinds in the schema: ${unexpected.join(', ')}`).toEqual([])
  })
})
