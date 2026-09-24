import { describe, it, expect } from 'vitest'
import { sql, compile, json } from './sql'
import { searchAcross, page, nest, without, assignments, insertColumns } from './fragments'

// ── Fragment helpers ─────────────────────────────────────────────────────────
// Pure compilation -- no database. What matters is the SQL text a helper
// emits and that every value stays a placeholder.
// ─────────────────────────────────────────────────────────────────────────────

const COLUMNS = { name: sql`name`, status: sql`status`, profile: sql`traveler_profile` } as const

describe('searchAcross', () => {
  it('matches the term anywhere in any column, as one parameter per column', () => {
    const q = compile(sql`select 1 where true ${searchAcross([sql`a`, sql`b`], ' smith ')}`)
    expect(q.text).toBe('select 1 where true and (a ilike $1 or b ilike $2)')
    expect(q.values).toEqual(['%smith%', '%smith%'])
  })

  it('contributes nothing for an empty or all-stripped term', () => {
    expect(compile(sql`x${searchAcross([sql`a`], '')}`).text).toBe('x')
    expect(compile(sql`x${searchAcross([sql`a`], null)}`).text).toBe('x')
    expect(compile(sql`x${searchAcross([sql`a`], ' (,)* ')}`).text).toBe('x')
  })

  it('treats LIKE wildcards literally (a backslash is stripped, as it always was)', () => {
    expect(compile(searchAcross([sql`a`], '50%_off\\')).values).toEqual(['%50\\%\\_off%'])
  })
})

describe('page', () => {
  it('turns inclusive from/to into limit/offset', () => {
    const q = compile(page({ from: 20, to: 29 }))
    expect(q.text).toBe('limit $1 offset $2')
    expect(q.values).toEqual([10, 20])
  })
})

describe('nest / without', () => {
  it('folds prefixed columns into an object, null when the join matched nothing', () => {
    const row = { id: 1, g__id: 'x', g__name: 'G', h__id: null }
    expect(nest(row, 'g__')).toEqual({ id: 'x', name: 'G' })
    expect(nest(row, 'h__')).toBeNull()
    expect(without(row, 'g__', 'h__')).toEqual({ id: 1 })
  })
})

describe('assignments', () => {
  it('sets only the fields present; null clears, undefined leaves alone', () => {
    const q = compile(sql`update t set ${assignments(COLUMNS, { name: 'A', status: undefined, profile: null })}`)
    expect(q.text).toBe('update t set name = $1, traveler_profile = $2')
    expect(q.values).toEqual(['A', null])
  })

  it('passes json() through so jsonb columns get JSON', () => {
    const q = compile(sql`${assignments(COLUMNS, { profile: json({ a: [1] }) })}`)
    expect(q.text).toBe('traveler_profile = $1::jsonb')
    expect(q.values).toEqual(['{"a":[1]}'])
  })

  it('refuses a key outside the map, and an empty update', () => {
    expect(() => assignments(COLUMNS, { role: 'admin' } as never)).toThrow('"role" is not an updatable column here')
    expect(() => assignments(COLUMNS, { name: undefined })).toThrow('update with nothing to set')
  })
})

describe('insertColumns', () => {
  it('lists only the fields present, so omitted columns take their DEFAULT', () => {
    const q = compile(sql`insert into t ${insertColumns(COLUMNS, { name: 'A', status: undefined, profile: null })}`)
    expect(q.text).toBe('insert into t (name, traveler_profile) values ($1, $2)')
    expect(q.values).toEqual(['A', null])
  })

  it('refuses a key outside the map, and an empty insert', () => {
    expect(() => insertColumns(COLUMNS, { role: 'x' } as never)).toThrow('"role" is not an insertable column here')
    expect(() => insertColumns(COLUMNS, {})).toThrow('insert with no columns')
  })
})
