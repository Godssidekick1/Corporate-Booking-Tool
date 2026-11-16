import { describe, it, expect } from 'vitest'
import { activeCount, applyFilters, countIf, defaultFare, emptyFilters, flip, isRefundable, stopsOf, type Filters } from './resultFilters'
import type { FlatFlightResult } from './types'

// ── The results' filters, for one list and for a round trip's two ────────────

function flight(key: string, o: { airline: string; dep: string; arr: string; stops?: number; price: number; refundable?: boolean; within?: boolean }): FlatFlightResult {
  return {
    flightKey: key,
    airline: { code: o.airline, name: o.airline },
    journeys: [{
      journeyNo: 1, stopCount: o.stops ?? 0,
      origin: { code: 'DEL', dateTime: `2030-11-18T${o.dep}:00` },
      destination: { code: 'BLR', dateTime: `2030-11-18T${o.arr}:00` },
    }],
    fareOptions: [{ pricingKey: `${key}-1`, sellEstimate: o.price, refundable: o.refundable ?? false, policy: o.within === false ? 'amber' : 'green' }],
  } as unknown as FlatFlightResult
}

const ONWARD = [
  flight('o1', { airline: 'AI', dep: '07:30', arr: '10:20', price: 5800, refundable: true }),
  flight('o2', { airline: '6E', dep: '13:10', arr: '16:00', price: 5200 }),
  flight('o3', { airline: 'AI', dep: '19:00', arr: '22:10', stops: 1, price: 7400, within: false }),
]
const RETURN = [
  flight('r1', { airline: 'AI', dep: '08:00', arr: '11:00', price: 6100 }),
  flight('r2', { airline: '6E', dep: '20:30', arr: '23:20', price: 4900, refundable: true }),
]
const keys = (lists: FlatFlightResult[][]) => lists.map(l => l.map(f => f.flightKey))
const withF = (patch: Partial<Filters>, lists = 2): Filters => ({ ...emptyFilters(lists), ...patch })

describe('one list', () => {
  it('nothing chosen shows everything', () => {
    expect(keys(applyFilters([ONWARD], emptyFilters(1)))).toEqual([['o1', 'o2', 'o3']])
  })

  it('a chip’s count is what clicking it shows, with the other groups applied', () => {
    const f = withF({ airlines: new Set(['AI']) }, 1)
    // Non-stop with AI chosen: o1 only.
    expect(countIf([ONWARD], f, 'stops', x => stopsOf(x) === 0)).toBe(1)
    // The airline chips ignore the airline choice itself: 6E would still show 1.
    expect(countIf([ONWARD], f, 'airlines', x => x.airline?.code === '6E')).toBe(1)
    // Clicking 1 stop would show o3, and it does.
    const clicked = { ...f, stops: new Set([1]) }
    expect(keys(applyFilters([ONWARD], clicked))).toEqual([['o3']])
  })

  it('price, refundable, within policy, departure time', () => {
    expect(keys(applyFilters([ONWARD], withF({ maxPrice: 5800 }, 1)))).toEqual([['o1', 'o2']])
    expect(keys(applyFilters([ONWARD], withF({ refundable: true }, 1)))).toEqual([['o1']])
    expect(keys(applyFilters([ONWARD], withF({ withinOnly: true }, 1)))).toEqual([['o1', 'o2']])
    const evening = emptyFilters(1); evening.times[0].dep.add('evening')
    expect(keys(applyFilters([ONWARD], evening))).toEqual([['o3']])
  })
})

describe('the fare a flight starts with on the fare page', () => {
  const withFares = (fares: { key: string; price: number; policy?: 'green' | 'amber' | 'red' }[]) =>
    ({ ...ONWARD[0], fareOptions: fares.map(f => ({ pricingKey: f.key, sellEstimate: f.price, policy: f.policy })) }) as FlatFlightResult

  it('the cheapest within policy, even when a cheaper fare needs approval', () => {
    expect(defaultFare(withFares([
      { key: 'saver', price: 5000, policy: 'amber' }, { key: 'flex', price: 7000, policy: 'green' }, { key: 'value', price: 6000, policy: 'green' },
    ]))?.pricingKey).toBe('value')
  })
  it('the cheapest when none is within policy, or policy is not judged', () => {
    expect(defaultFare(withFares([{ key: 'a', price: 7000, policy: 'red' }, { key: 'b', price: 6500, policy: 'amber' }]))?.pricingKey).toBe('b')
    expect(defaultFare(withFares([{ key: 'a', price: 7000 }, { key: 'b', price: 6500 }]))?.pricingKey).toBe('b')
    expect(defaultFare(withFares([]))).toBeUndefined()
  })
})

describe('a round trip’s two columns', () => {
  it('shared groups filter both columns and count across both', () => {
    const f = withF({ airlines: new Set(['6E']) })
    expect(keys(applyFilters([ONWARD, RETURN], f))).toEqual([['o2'], ['r2']])
    // Refundable with 6E chosen: r2 only, across both columns.
    expect(countIf([ONWARD, RETURN], f, 'refundable', isRefundable)).toBe(1)
    // Each airline chip counts both columns: AI has two onward and one return.
    expect(countIf([ONWARD, RETURN], emptyFilters(2), 'airlines', x => x.airline?.code === 'AI')).toBe(3)
  })

  it('an onward time leaves the return column alone', () => {
    const f = emptyFilters(2); f.times[0].dep.add('morning')
    expect(keys(applyFilters([ONWARD, RETURN], f))).toEqual([['o1'], ['r1', 'r2']])
    // The return's own departure chips count the return column only.
    expect(countIf([ONWARD, RETURN], f, 'dep1', () => true)).toBe(2)
    // And the onward times count the onward column only.
    expect(countIf([ONWARD, RETURN], f, 'dep0', () => true)).toBe(3)
  })

  it('price is per flight, in each column', () => {
    expect(keys(applyFilters([ONWARD, RETURN], withF({ maxPrice: 5500 })))).toEqual([['o2'], ['r2']])
  })

  it('clear all counts and clears each chosen chip once', () => {
    const f = withF({ airlines: new Set(['AI']), refundable: true, maxPrice: 6000 })
    f.times[1].arr.add('evening')
    expect(activeCount(f)).toBe(4)
    expect(activeCount(emptyFilters(2))).toBe(0)
    expect(flip(flip(new Set([1]), 2), 1)).toEqual(new Set([2]))
  })
})
