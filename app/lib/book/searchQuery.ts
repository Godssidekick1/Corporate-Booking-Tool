// ── A flight search, as an address ───────────────────────────────────────────
// The results page (/book/flights/results) carries the search in its address,
// so a refresh, the browser's Back and every "Back to results" link land on the
// same list. Short keys, ISO dates:
//
//   ?o=DEL&d=BLR&dep=2026-11-18&ret=2026-11-21&a=1&c=0&i=0&cabin=Economy
//
// `ret` present = a round trip. Pure: parsed and checked here, searched by the
// page (app/components/book/search/runSearch.ts).
// ─────────────────────────────────────────────────────────────────────────────

export const CABINS = ['Economy', 'Premium Economy', 'Business', 'First'] as const
export type Cabin = (typeof CABINS)[number]

export interface SearchQuery {
  origin: string
  destination: string
  // yyyy-mm-dd
  departDate: string
  returnDate: string | null
  adult: number
  child: number
  infant: number
  cabin: Cabin
}

const CODE = /^[A-Z]{3}$/
const ISO = /^\d{4}-\d{2}-\d{2}$/
const MAX_TRAVELLERS = 9

export function queryParams(q: SearchQuery): string {
  const p = new URLSearchParams({ o: q.origin, d: q.destination, dep: q.departDate })
  if (q.returnDate) p.set('ret', q.returnDate)
  p.set('a', String(q.adult))
  p.set('c', String(q.child))
  p.set('i', String(q.infant))
  p.set('cabin', q.cabin)
  return p.toString()
}

export const resultsHrefFor = (q: SearchQuery) => `/book/flights/results?${queryParams(q)}`

const count = (v: string | null, min: number): number | null => {
  if (v === null || !/^\d$/.test(v)) return null
  const n = Number(v)
  return n >= min ? n : null
}

// An address that is not a whole search reads as none: the page sends it to
// the search form rather than guessing.
export function parseQuery(search: string): SearchQuery | null {
  const p = new URLSearchParams(search)
  const origin = (p.get('o') ?? '').toUpperCase()
  const destination = (p.get('d') ?? '').toUpperCase()
  const departDate = p.get('dep') ?? ''
  const ret = p.get('ret')
  const adult = count(p.get('a') ?? '1', 1)
  const child = count(p.get('c') ?? '0', 0)
  const infant = count(p.get('i') ?? '0', 0)
  const cabin = (CABINS as readonly string[]).includes(p.get('cabin') ?? '') ? (p.get('cabin') as Cabin) : 'Economy'
  if (!CODE.test(origin) || !CODE.test(destination) || !ISO.test(departDate)) return null
  if (ret !== null && !ISO.test(ret)) return null
  if (adult === null || child === null || infant === null) return null
  return { origin, destination, departDate, returnDate: ret, adult, child, infant, cabin }
}

export function sameQuery(a: SearchQuery | null | undefined, b: SearchQuery | null | undefined): boolean {
  return !!a && !!b && queryParams(a) === queryParams(b)
}

// What is wrong with a search, in words for the traveller; null when it can be
// run. `today` is yyyy-mm-dd, passed in so this stays pure.
export function queryProblem(q: SearchQuery, today: string): string | null {
  if (!CODE.test(q.origin)) return 'Choose where you are flying from.'
  if (!CODE.test(q.destination)) return 'Choose where you are flying to.'
  if (q.origin === q.destination) return 'The origin and destination are the same airport.'
  if (!ISO.test(q.departDate)) return 'Choose a departure date.'
  if (q.departDate < today) return 'The departure date has passed.'
  if (q.returnDate !== null) {
    if (!ISO.test(q.returnDate)) return 'Choose a return date, or make it one way.'
    // Same day is allowed: a day trip out and back is an ordinary booking.
    if (q.returnDate < q.departDate) return 'The return is before the departure.'
  }
  if (q.adult < 1) return 'At least one adult must travel.'
  if (q.adult + q.child + q.infant > MAX_TRAVELLERS) return `At most ${MAX_TRAVELLERS} travellers in one booking.`
  if (q.infant > q.adult) return 'Each infant must travel with an adult. Please adjust the travellers.'
  return null
}

// The provider's date format.
export function apiDate(iso: string): string {
  const [y, m, d] = iso.split('-')
  return `${d}/${m}/${y}`
}

// "Wed, 18 Nov". Read as a local date: new Date('2026-11-18') is UTC midnight,
// which is the 17th west of Greenwich.
export function displayDate(iso: string): string {
  if (!ISO.test(iso)) return ''
  return new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })
}

export function travellersText(q: Pick<SearchQuery, 'adult' | 'child' | 'infant'>): string {
  const n = q.adult + q.child + q.infant
  return n === 1 ? '1 Adult' : `${n} Travellers`
}

// Today and a day offset, as yyyy-mm-dd in local time.
export function isoDay(offsetDays = 0, from: Date = new Date()): string {
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() + offsetDays)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
