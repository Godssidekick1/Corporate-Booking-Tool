import { describe, it, expect, afterAll } from 'vitest'
import { sql, json, one, exec } from './sql'
import { transaction } from './transaction'
import { closePool } from './pool'

// ── The value contract ───────────────────────────────────────────────────────
// Write a value, read it back, assert it is unchanged -- once per PostgreSQL
// type this schema uses. This is the contract domain code depends on:
// money is a number you can add, a timestamp is a string you can
// localeCompare, a date does not move by a day, and a jsonb array stays an
// array.
//
// Three of the shim's defects were VALUE bugs of exactly this kind, and a
// query-builder test could not see any of them because the API was behaving
// perfectly. Ported from the shim's roundTrip.test.ts, which dies with it.
//
// Every case runs in a transaction that is rolled back.
// ─────────────────────────────────────────────────────────────────────────────

const HAS_DB = Boolean(process.env.DATABASE_URL)
const d = HAS_DB ? describe : describe.skip

// A scratch table with one column per type under test, created and dropped
// inside the same transaction.
async function roundTrip<T>(column: string, type: string, value: unknown, asJson = false): Promise<T> {
  let back: T | undefined
  await transaction(async tx => {
    await exec(tx, sql`create temp table v (x int) on commit drop`)
    await tx.query(`alter table v add column ${column} ${type}`)
    await exec(tx, sql`insert into v (x) values (1)`)
    await tx.query(`update v set ${column} = $1${asJson ? '::jsonb' : ''}`, [
      asJson ? (value === null ? null : JSON.stringify(value)) : value,
    ])
    const row = await one<Record<string, T>>(tx, sql`select * from v`)
    back = row[column]
    throw new Error('rollback')
  }).catch(e => { if (e.message !== 'rollback') throw e })
  return back as T
}

d('value contract', () => {
  afterAll(async () => { await closePool() })

  it('numeric is a NUMBER, so money is addition, not concatenation', async () => {
    const back = await roundTrip<number>('money', 'numeric(12,2)', '6776.00')
    expect(typeof back).toBe('number')
    expect(back + 5).toBe(6781)
  })

  it('bigint is a number', async () => {
    expect(await roundTrip('n', 'int8', '42')).toBe(42)
  })

  it('timestamptz is an ISO string, and localeCompare works on it', async () => {
    // The operation all three commercial resolvers use to break a tie.
    const back = await roundTrip<string>('at', 'timestamptz', '2026-09-22T07:27:09.861Z')
    expect(typeof back).toBe('string')
    expect(back).toBe('2026-09-22T07:27:09.861Z')
    expect(() => back.localeCompare('2020-01-01')).not.toThrow()
  })

  it('date is YYYY-MM-DD and never moves by a day', async () => {
    expect(await roundTrip('day', 'date', '2026-09-22')).toBe('2026-09-22')
  })

  it('a TOP-LEVEL jsonb ARRAY survives (the booking insert that failed)', async () => {
    const value = [{ airline: 'AI', code: 'CORP01' }, { airline: '6E', code: 'CORP02' }]
    expect(await roundTrip('j', 'jsonb', value, true)).toEqual(value)
  })

  it('an EMPTY jsonb array stays an array, not {}', async () => {
    expect(await roundTrip('j', 'jsonb', [], true)).toEqual([])
  })

  it('nested jsonb keeps numbers as numbers', async () => {
    const value = { passengerBreakup: [{ baseFare: 8777, taxLines: [{ code: 'YQ', amount: 749 }] }] }
    expect(await roundTrip('j', 'jsonb', value, true)).toEqual(value)
  })

  it('json(null) stores SQL NULL, not the JSON literal null', async () => {
    const isNull = await transaction(async tx => {
      await exec(tx, sql`create temp table jn (j jsonb) on commit drop`)
      await exec(tx, sql`insert into jn values (${json(null)})`)
      return one<{ n: boolean }>(tx, sql`select j is null as n from jn`)
    })
    expect(isNull.n).toBe(true)
  })

  it('text[] stays a real PostgreSQL array', async () => {
    const value = ['098-5014504605', '098-5014504606']
    const back = await roundTrip<string[]>('t', 'text[]', value)
    expect(Array.isArray(back)).toBe(true)
    expect(back).toEqual(value)
  })

  it('text survives quotes, backslashes and SQL-looking content', async () => {
    const value = `O'Brien "quoted" \\backslash ; DROP TABLE clients -- %_`
    expect(await roundTrip('s', 'text', value)).toBe(value)
  })

  it('unicode survives', async () => {
    const value = 'Société Air France — 全日本空輸'
    expect(await roundTrip('s', 'text', value)).toBe(value)
  })

  it('boolean and uuid come back as boolean and string', async () => {
    expect(await roundTrip('b', 'boolean', true)).toBe(true)
    const id = '6f9619ff-8b86-d011-b42d-00c04fc964ff'
    expect(await roundTrip('u', 'uuid', id)).toBe(id)
  })

  it('int2 and int4 are numbers', async () => {
    expect(await roundTrip('s', 'int2', '7')).toBe(7)
    expect(await roundTrip('i', 'int4', '2147483647')).toBe(2147483647)
  })

  it('char(n) comes back space-padded to its length', async () => {
    // clients.currency is char(3). A shorter value is padded by PostgreSQL, so
    // 'IN' reads back as 'IN ' -- worth knowing before comparing one.
    expect(await roundTrip('c', 'char(3)', 'INR')).toBe('INR')
    expect(await roundTrip('c', 'char(3)', 'IN')).toBe('IN ')
  })

  // Every type the schema uses must have a case above. A new column type is a
  // decision for typeParsers.ts and the type generator -- this makes it fail
  // here rather than arrive as the next untested value bug. (Ported from the
  // shim's roundTrip test, which read the shim's generated column map.)
  const COVERED = new Set(['numeric', 'int2', 'int4', 'int8', 'timestamptz', 'date', 'jsonb', '_text',
    'text', 'bpchar', 'bool', 'uuid'])

  it('every column type in the schema has a round trip here', async () => {
    const { rows } = await transaction(tx => tx.query(`
      select distinct udt_name from information_schema.columns where table_schema = 'public'`))
    const unexpected = (rows as { udt_name: string }[]).map(r => r.udt_name).filter(t => !COVERED.has(t)).sort()
    expect(unexpected, `column types with no round trip: ${unexpected.join(', ')}`).toEqual([])
  })
})
