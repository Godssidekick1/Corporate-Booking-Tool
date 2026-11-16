import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { apiDate, displayDate, isoDay, parseQuery, queryParams, queryProblem, resultsHrefFor, sameQuery, type SearchQuery } from './searchQuery'
import { flowStorage } from './flowStorage'

// ── The results page's address, and the list it reuses ───────────────────────

const Q: SearchQuery = {
  origin: 'DEL', destination: 'BLR', departDate: '2030-11-18', returnDate: '2030-11-21',
  adult: 2, child: 1, infant: 1, cabin: 'Business',
}

describe('the search in the address', () => {
  it('round-trips through the address unchanged', () => {
    expect(parseQuery(queryParams(Q))).toEqual(Q)
    expect(parseQuery(queryParams({ ...Q, returnDate: null }))).toEqual({ ...Q, returnDate: null })
    expect(resultsHrefFor(Q)).toBe('/book/flights/results?o=DEL&d=BLR&dep=2030-11-18&ret=2030-11-21&a=2&c=1&i=1&cabin=Business')
  })

  it('reads lower-case codes and defaults the travellers and class', () => {
    expect(parseQuery('?o=del&d=blr&dep=2030-11-18')).toEqual({
      origin: 'DEL', destination: 'BLR', departDate: '2030-11-18', returnDate: null, adult: 1, child: 0, infant: 0, cabin: 'Economy',
    })
  })

  it('an address that is not a whole search is none', () => {
    for (const bad of ['', '?o=DEL&d=BLR', '?o=DELHI&d=BLR&dep=2030-11-18', '?o=DEL&d=BLR&dep=18/11/2030',
      '?o=DEL&d=BLR&dep=2030-11-18&ret=soon', '?o=DEL&d=BLR&dep=2030-11-18&a=0', '?o=DEL&d=BLR&dep=2030-11-18&c=-1',
      '?o=DEL&d=BLR&dep=2030-11-18&a=12']) {
      expect(parseQuery(bad), bad).toBeNull()
    }
    // An unknown class falls back to Economy rather than refusing the search.
    expect(parseQuery('?o=DEL&d=BLR&dep=2030-11-18&cabin=Luxury')?.cabin).toBe('Economy')
  })

  it('compares whole searches', () => {
    expect(sameQuery(Q, { ...Q })).toBe(true)
    expect(sameQuery(Q, { ...Q, cabin: 'Economy' })).toBe(false)
    expect(sameQuery(Q, null)).toBe(false)
  })
})

describe('what is wrong with a search', () => {
  const today = '2030-11-01'
  it('a whole, future search is fine; same-day returns are allowed', () => {
    expect(queryProblem(Q, today)).toBeNull()
    expect(queryProblem({ ...Q, returnDate: Q.departDate }, today)).toBeNull()
  })
  it('says what to fix, one thing at a time', () => {
    expect(queryProblem({ ...Q, origin: '' }, today)).toMatch(/flying from/)
    expect(queryProblem({ ...Q, destination: 'DEL' }, today)).toMatch(/same airport/)
    expect(queryProblem({ ...Q, departDate: '2030-10-31' }, today)).toMatch(/has passed/)
    expect(queryProblem({ ...Q, returnDate: '' }, today)).toMatch(/return date/)
    expect(queryProblem({ ...Q, returnDate: '2030-11-17' }, today)).toMatch(/before the departure/)
    expect(queryProblem({ ...Q, adult: 1, infant: 2, child: 0 }, today)).toMatch(/infant must travel with an adult/)
    expect(queryProblem({ ...Q, adult: 5, child: 4, infant: 1 }, today)).toMatch(/At most 9/)
  })
})

describe('dates', () => {
  it('in the provider’s format and in words, read as local dates', () => {
    expect(apiDate('2030-11-18')).toBe('18/11/2030')
    expect(displayDate('2030-11-18')).toMatch(/18 Nov/)
    expect(displayDate('nonsense')).toBe('')
    expect(isoDay(1, new Date(2030, 11, 31))).toBe('2031-01-01')
  })
})

describe('the stored list the results page reuses', () => {
  const store = new Map<string, string>()
  beforeEach(() => {
    store.clear()
    ;(globalThis as { window?: unknown }).window = {
      sessionStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => { store.set(k, v) },
        removeItem: (k: string) => { store.delete(k) },
      },
    }
  })
  afterEach(() => { delete (globalThis as { window?: unknown }).window })

  const save = () => flowStorage.saveSearchResults([], {
    origin: 'DEL', destination: 'BLR', departDate: '', adult: 2, child: 1, infant: 1, query: Q,
  }, 'AK', undefined, [{ code: 'SG', name: 'SpiceJet' }])

  it('only for the same search, and only while fresh', () => {
    save()
    const now = Date.now()
    expect(flowStorage.freshResults(Q, 60_000, now)?.hiddenByPolicy).toEqual([{ code: 'SG', name: 'SpiceJet' }])
    expect(flowStorage.freshResults({ ...Q, adult: 1 }, 60_000, now)).toBeNull()
    expect(flowStorage.freshResults(Q, 60_000, now + 61_000)).toBeNull()
  })

  it('a new search from the form drops the list but keeps the way back', () => {
    expect(flowStorage.resultsHref()).toBe('/book/flights')
    save()
    expect(flowStorage.resultsHref()).toBe(resultsHrefFor(Q))
    flowStorage.dropResults()
    expect(flowStorage.freshResults(Q, 60_000)).toBeNull()
    expect(flowStorage.resultsHref()).toBe(resultsHrefFor(Q))
  })
})
