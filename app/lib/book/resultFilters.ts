import { journeysOf, type FareOption, type FlatFlightResult } from './types'

// ── The results' filters, one set for one list or two ────────────────────────
// The filters beside the results (app/components/book/FilterPanel.tsx): within
// policy, stops, departure and arrival time, airlines, price, refundable.
// One-way (and a round trip priced together) filter one list. A domestic
// round trip filters two, the onward and return columns: every group applies
// to both, except the times, which each column has its own of.
//
// A chip's count is what clicking it would show: the flights that pass every
// OTHER group, across every list the group applies to. Pure, so the counting
// is tested (resultFilters.test.ts) rather than eyeballed.
// ─────────────────────────────────────────────────────────────────────────────

export type Bucket = 'early' | 'morning' | 'afternoon' | 'evening'
export type Verdict = 'green' | 'amber' | 'red'

export interface Times { dep: Set<Bucket>; arr: Set<Bucket> }

export interface Filters {
  airlines: Set<string>
  // 0, 1, or 2 meaning two or more.
  stops: Set<number>
  refundable: boolean
  withinOnly: boolean
  // The most a flight may cost (what the company pays for its cheapest fare).
  maxPrice: number | null
  // One per list: times[0] for the first (or only) list, times[1] the return.
  times: Times[]
}

// A group of chips. Times are per list: 'dep0' is the first list's departure.
export type Group = 'airlines' | 'stops' | 'refundable' | 'within' | 'price' | `dep${number}` | `arr${number}`

export const emptyFilters = (lists: number): Filters => ({
  airlines: new Set(), stops: new Set(), refundable: false, withinOnly: false, maxPrice: null,
  times: Array.from({ length: Math.max(1, lists) }, () => ({ dep: new Set<Bucket>(), arr: new Set<Bucket>() })),
})

// ── What each flight is, for the filters and the cards ───────────────────────

const hourOf = (iso?: string) => Number(/T(\d{2})/.exec(iso ?? '')?.[1] ?? NaN)

// "2030-11-10T08:05:00": read from the string. The provider sends local airport
// times with no zone, so parsing to a Date would shift them.
export function bucketOf(iso?: string): Bucket | null {
  const h = hourOf(iso)
  if (!Number.isFinite(h)) return null
  return h < 6 ? 'early' : h < 12 ? 'morning' : h < 18 ? 'afternoon' : 'evening'
}

export function minutes(duration?: string): number {
  const m = /^(\d+):(\d{2})/.exec(duration ?? '')
  return m ? Number(m[1]) * 60 + Number(m[2]) : 0
}

export const fareAmount = (f: FareOption) => f.sellEstimate ?? f.totalFare
export const airlineOf = (f: FlatFlightResult) => (f.airline?.code ?? f.legs?.[0]?.airlineCode ?? '').toUpperCase()
export const stopsOf = (f: FlatFlightResult) => Math.max(...journeysOf(f).map(j => j.stopCount ?? 0))
export const durationOf = (f: FlatFlightResult) => journeysOf(f).reduce((sum, j) => sum + minutes(j.totalDuration ?? j.duration), 0)
export const hasWithin = (f: FlatFlightResult) => f.fareOptions.some(o => o.policy === 'green')
export const isRefundable = (f: FlatFlightResult) => f.fareOptions.some(o => o.refundable)
export const departBucket = (f: FlatFlightResult) => bucketOf(journeysOf(f)[0]?.origin?.dateTime)
export const arriveBucket = (f: FlatFlightResult) => bucketOf(journeysOf(f)[0]?.destination?.dateTime)

// What the company pays for the cheapest fare.
export function youPay(f: FlatFlightResult): number | undefined {
  const amounts = f.fareOptions.map(fareAmount).filter((n): n is number => typeof n === 'number')
  return amounts.length ? Math.min(...amounts) : f.sellEstimate ?? f.totalFare
}

// ── Passing and counting ─────────────────────────────────────────────────────

const timesOf = (filters: Filters, list: number): Times =>
  filters.times[list] ?? { dep: new Set(), arr: new Set() }

function test(group: Group, f: FlatFlightResult, filters: Filters, list: number): boolean {
  switch (group) {
    case 'airlines': return filters.airlines.size === 0 || filters.airlines.has(airlineOf(f))
    case 'stops': return filters.stops.size === 0 || filters.stops.has(Math.min(stopsOf(f), 2))
    case 'refundable': return !filters.refundable || isRefundable(f)
    case 'within': return !filters.withinOnly || hasWithin(f)
    case 'price': return filters.maxPrice === null || (youPay(f) ?? Infinity) <= filters.maxPrice
  }
  // A time group tests only its own list's flights.
  const which = group.startsWith('dep') ? 'dep' : 'arr'
  if (Number(group.slice(3)) !== list) return true
  const set = timesOf(filters, list)[which]
  return set.size === 0 || set.has((which === 'dep' ? departBucket(f) : arriveBucket(f)) as Bucket)
}

function groupsFor(list: number): Group[] {
  return ['airlines', 'stops', 'refundable', 'within', 'price', `dep${list}`, `arr${list}`]
}

export function passes(f: FlatFlightResult, filters: Filters, list = 0, except?: Group): boolean {
  return groupsFor(list).every(g => g === except || test(g, f, filters, list))
}

// Each list, filtered.
export function applyFilters(lists: FlatFlightResult[][], filters: Filters): FlatFlightResult[][] {
  return lists.map((flights, i) => flights.filter(f => passes(f, filters, i)))
}

// How many flights clicking a chip of `group` would show: across every list
// for a shared group, its own list for a time group.
export function countIf(lists: FlatFlightResult[][], filters: Filters, group: Group, pred: (f: FlatFlightResult) => boolean): number {
  const own = group.startsWith('dep') || group.startsWith('arr') ? Number(group.slice(3)) : null
  return lists.reduce((n, flights, i) =>
    own !== null && own !== i ? n : n + flights.filter(f => passes(f, filters, i, group) && pred(f)).length, 0)
}

// The number shown on "Clear all (N)": each chosen chip counts once.
export function activeCount(filters: Filters): number {
  return filters.airlines.size + filters.stops.size
    + filters.times.reduce((n, t) => n + t.dep.size + t.arr.size, 0)
    + (filters.refundable ? 1 : 0) + (filters.withinOnly ? 1 : 0) + (filters.maxPrice !== null ? 1 : 0)
}

// A copy of the set with `value` added, or removed if it was there.
export function flip<T>(set: Set<T>, value: T): Set<T> {
  const next = new Set(set)
  if (next.has(value)) next.delete(value)
  else next.add(value)
  return next
}
