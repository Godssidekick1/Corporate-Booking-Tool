import { describe, it, expect, afterAll } from 'vitest'
import { sql, empty, join, json, compile, many, maybeOne, one, exec } from './sql'
import { db, isConstraint, ConstraintViolation, RowNotFound, TooManyRows } from './index'
import { transaction } from './transaction'
import { closePool } from './pool'

// ── The sql tag and its executors ────────────────────────────────────────────
// Compilation is tested without a database; execution against cbt_test.
// ─────────────────────────────────────────────────────────────────────────────

describe('compile', () => {
  it('turns every interpolation into a numbered placeholder', () => {
    const q = compile(sql`select * from t where a = ${1} and b = ${'x'}`)
    expect(q.text).toBe('select * from t where a = $1 and b = $2')
    expect(q.values).toEqual([1, 'x'])
  })

  it('NEVER puts a value into the text, whatever it contains', () => {
    const hostile = `'; drop table clients; --`
    const q = compile(sql`select * from t where name = ${hostile}`)
    expect(q.text).toBe('select * from t where name = $1')
    expect(q.text).not.toContain('drop')
    expect(q.values).toEqual([hostile])
  })

  it('renumbers placeholders across nested fragments', () => {
    const where = sql`a = ${1} and b = ${2}`
    const q = compile(sql`select * from t where ${where} and c = ${3}`)
    expect(q.text).toBe('select * from t where a = $1 and b = $2 and c = $3')
    expect(q.values).toEqual([1, 2, 3])
  })

  it('reuses one fragment in two queries with independent numbering', () => {
    const where = sql`x = ${'v'}`
    expect(compile(sql`select count(*) from t where ${where}`).text).toBe('select count(*) from t where x = $1')
    expect(compile(sql`select * from t where ${where} limit ${5}`).text).toBe('select * from t where x = $1 limit $2')
  })

  it('empty contributes nothing', () => {
    const q = compile(sql`select 1 ${empty} where true ${empty}`)
    expect(q.text).toBe('select 1  where true ')
    expect(q.values).toEqual([])
  })

  it('join separates fragments, and joins nothing to nothing', () => {
    const q = compile(join([sql`a = ${1}`, sql`b = ${2}`], sql` or `))
    expect(q.text).toBe('a = $1 or b = $2')
    expect(compile(join([])).text).toBe('')
  })

  it('json() stringifies and casts; json(null) is SQL NULL', () => {
    const q = compile(sql`insert into t (a, b) values (${json([{ x: 1 }])}, ${json(null)})`)
    expect(q.text).toBe('insert into t (a, b) values ($1::jsonb, $2::jsonb)')
    expect(q.values).toEqual(['[{"x":1}]', null])
  })

  it('an array is ONE parameter, for use with = any()', () => {
    const q = compile(sql`where id = any(${['a', 'b']})`)
    expect(q.text).toBe('where id = any($1)')
    expect(q.values).toEqual([['a', 'b']])
  })

  it('undefined becomes NULL rather than a missing parameter', () => {
    expect(compile(sql`values (${undefined})`).values).toEqual([null])
  })
})

const HAS_DB = Boolean(process.env.DATABASE_URL)
const d = HAS_DB ? describe : describe.skip

d('execution', () => {
  afterAll(async () => { await closePool() })

  it('many returns every row, and [] for none', async () => {
    expect(await many(db, sql`select x from generate_series(1, 3) x`)).toHaveLength(3)
    expect(await many(db, sql`select 1 where false`)).toEqual([])
  })

  it('maybeOne: the row, null for none, THROWS for several', async () => {
    expect(await maybeOne<{ x: number }>(db, sql`select 1 as x`)).toEqual({ x: 1 })
    expect(await maybeOne(db, sql`select 1 where false`)).toBeNull()
    await expect(maybeOne(db, sql`select x from generate_series(1, 2) x`)).rejects.toBeInstanceOf(TooManyRows)
  })

  it('one: the row, THROWS for none or several', async () => {
    expect(await one<{ x: number }>(db, sql`select 7 as x`)).toEqual({ x: 7 })
    await expect(one(db, sql`select 1 where false`)).rejects.toBeInstanceOf(RowNotFound)
    await expect(one(db, sql`select x from generate_series(1, 2) x`)).rejects.toBeInstanceOf(TooManyRows)
  })

  it('exec returns the rows affected', async () => {
    const n = await transaction(async tx => {
      await exec(tx, sql`create temp table scratch (v int) on commit drop`)
      await exec(tx, sql`insert into scratch values (1), (2), (3)`)
      return exec(tx, sql`update scratch set v = v + 1 where v > ${1}`)
    })
    expect(n).toBe(2)
  })

  it('= any() with an EMPTY array matches nothing, rather than a syntax error', async () => {
    // `in ()` is invalid SQL; this is why every list filter uses = any().
    expect(await many(db, sql`select code from airlines where code = any(${[] as string[]})`)).toEqual([])
  })

  it('a query FAILURE throws -- it can never read as "no rows"', async () => {
    // The class of bug the repository layer exists to end: 214 call sites used
    // to discard `error`, so a failed query looked like an empty result.
    await expect(many(db, sql`select * from no_such_table`)).rejects.toThrow(/no_such_table/)
  })

  it('a unique violation becomes a ConstraintViolation naming the constraint', async () => {
    const err = await transaction(async tx => {
      await exec(tx, sql`insert into airlines (code, name) values ('Z7', 'Probe')`)
      return exec(tx, sql`insert into airlines (code, name) values ('Z7', 'Probe again')`)
    }).catch(e => e)

    expect(err).toBeInstanceOf(ConstraintViolation)
    expect(err.kind).toBe('unique')
    expect(err.code).toBe('23505')
    expect(err.constraint).toBe('airlines_pkey')
    expect(isConstraint(err, 'unique', 'airlines_pkey')).toBe(true)
    expect(isConstraint(err, 'foreign_key')).toBe(false)
  })

  it('a foreign-key violation is kind foreign_key', async () => {
    const err = await exec(db, sql`
      insert into bands (client_id, code, label, rank)
      values ('00000000-0000-0000-0000-000000000000', 'X', 'X', 1)`).catch(e => e)
    expect(isConstraint(err, 'foreign_key')).toBe(true)
  })
})
