import { describe, it, expect } from 'vitest'
import {
  addDays, addMonths, clampDay, formatDay, isIsoDay, monthGrid, todayIso, toIso, withinBounds,
} from './calendar'

describe('calendar arithmetic on ISO days', () => {
  it('adds days across month, year and leap-day boundaries', () => {
    expect(addDays('2026-11-30', 1)).toBe('2026-12-01')
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29')
    expect(addDays('2027-02-28', 1)).toBe('2027-03-01')
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
  })

  it('adds months, wrapping years', () => {
    expect(addMonths({ y: 2026, m: 11 }, 1)).toEqual({ y: 2027, m: 0 })
    expect(addMonths({ y: 2026, m: 0 }, -1)).toEqual({ y: 2025, m: 11 })
    expect(addMonths({ y: 2026, m: 5 }, 30)).toEqual({ y: 2028, m: 11 })
  })

  it('a month grid: Sunday first, whole weeks, every day once', () => {
    const nov = monthGrid({ y: 2026, m: 10 })   // 1 Nov 2026 is a Sunday
    expect(nov[0][0]).toBe('2026-11-01')
    expect(nov.every(w => w.length === 7)).toBe(true)
    const days = nov.flat().filter(Boolean)
    expect(days).toHaveLength(30)
    expect(days.at(-1)).toBe('2026-11-30')
    const feb = monthGrid({ y: 2028, m: 1 })    // leap February, starts Tuesday
    expect(feb[0].slice(0, 2)).toEqual([null, null])
    expect(feb.flat().filter(Boolean)).toHaveLength(29)
  })

  it('validates real days only', () => {
    expect(isIsoDay('2026-02-28')).toBe(true)
    expect(isIsoDay('2026-02-30')).toBe(false)
    expect(isIsoDay('2026-2-3')).toBe(false)
    expect(isIsoDay(undefined)).toBe(false)
  })

  it('bounds and clamping, either bound optional', () => {
    expect(withinBounds('2026-11-20', '2026-11-20', '2026-11-30')).toBe(true)
    expect(withinBounds('2026-11-19', '2026-11-20')).toBe(false)
    expect(withinBounds('2026-12-01', null, '2026-11-30')).toBe(false)
    expect(clampDay('2026-11-10', '2026-11-20')).toBe('2026-11-20')
    expect(clampDay('2026-12-10', null, '2026-11-30')).toBe('2026-11-30')
  })

  it('today is the local date, not the UTC one', () => {
    expect(todayIso(new Date(2026, 10, 26, 0, 30))).toBe('2026-11-26')
    expect(toIso(2026, 10, 26)).toBe('2026-11-26')
  })

  it('formats a day without shifting it by time zone', () => {
    expect(formatDay('2026-11-18', { year: 'always' })).toMatch(/18 Nov 2026/)
    expect(formatDay('not a date')).toBe('')
  })
})
