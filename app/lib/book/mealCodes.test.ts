import { describe, it, expect } from 'vitest'
import { mealGroupsFor, mealGuidance, mealsOrderable, MEAL_CODES } from './mealCodes'

// ── Special meals: what is offered, and when one can be asked for ────────────

describe('mealGroupsFor', () => {
  const codes = (list: { code: string }[]) => list.map(m => m.code)

  it('an adult: the most asked-for first, the rest under More options, no child or baby meal', () => {
    const { common, more } = mealGroupsFor('ADT')
    expect(codes(common)).toEqual(['AVML', 'VLML', 'VGML', 'VJML', 'MOML', 'DBML'])
    expect(codes(more)).toContain('KSML')
    expect([...codes(common), ...codes(more)]).not.toContain('CHML')
    expect([...codes(common), ...codes(more)]).not.toContain('BBML')
  })

  it('a child sees the child meal among the common ones; an infant the baby meal', () => {
    expect(codes(mealGroupsFor('CHD').common)).toContain('CHML')
    expect(codes(mealGroupsFor('INF').common)).toContain('BBML')
    expect(codes(mealGroupsFor('INF').common)).not.toContain('CHML')
  })

  it('nothing is lost: the two groups together are the whole list for that passenger', () => {
    const { common, more } = mealGroupsFor('ADT')
    expect(common.length + more.length).toBe(MEAL_CODES.filter(m => !m.paxType).length)
  })
})

describe('mealsOrderable', () => {
  it('only a full-service fare that includes a meal', () => {
    expect(mealsOrderable(false, true)).toBe(true)
    expect(mealsOrderable(false, undefined)).toBe(true)   // fares stored before the field existed
    expect(mealsOrderable(true, true)).toBe(false)        // a low-cost carrier sells its meals
    expect(mealsOrderable(false, false)).toBe(false)
  })
})

describe('mealGuidance', () => {
  const now = new Date('2030-11-09T12:00:00')

  it('a low-cost carrier: not orderable, said plainly', () => {
    const g = mealGuidance({ isLcc: true, mealIncluded: true, departure: '2030-11-20T08:00:00', now })
    expect(g).toMatchObject({ orderable: false, warning: null })
    expect(g.text).toMatch(/sold on board or as a paid add-on/)
  })

  it('a fare without a meal: not orderable', () => {
    expect(mealGuidance({ isLcc: false, mealIncluded: false, now })).toMatchObject({ orderable: false, warning: null })
  })

  it('less than a day before departure: orderable, with the notice warning', () => {
    const g = mealGuidance({ isLcc: false, mealIncluded: true, departure: '2030-11-10T08:00:00', now })
    expect(g.orderable).toBe(true)
    expect(g.warning).toMatch(/24–48 hours’ notice/)
  })

  it('more than a day out, or already departed: no warning', () => {
    expect(mealGuidance({ mealIncluded: true, departure: '2030-11-10T12:00:01', now }).warning).toBeNull()
    expect(mealGuidance({ mealIncluded: true, departure: '2030-11-09T11:00:00', now }).warning).toBeNull()
    expect(mealGuidance({ mealIncluded: true, departure: null, now }).warning).toBeNull()
  })
})
