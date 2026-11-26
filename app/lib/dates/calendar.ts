// ── Calendar arithmetic on ISO days ──────────────────────────────────────────
// Pure, and in plain yyyy-mm-dd strings throughout, the format every date in
// the app is stored and sent in. No Date objects cross the boundary: a Date
// carries a time and a time zone, which is how "18 Nov" becomes the 17th west
// of Greenwich. Built on Date.UTC only for the arithmetic.
//
// Used by app/components/date (our own date picker, replacing the browser's).
// ─────────────────────────────────────────────────────────────────────────────

export const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/

export interface Month { y: number; m: number } // m: 0-11

const pad = (n: number) => String(n).padStart(2, '0')

export function toIso(y: number, m: number, d: number): string {
  const t = new Date(Date.UTC(y, m, d))
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`
}

export function isIsoDay(s: unknown): s is string {
  if (typeof s !== 'string' || !ISO_DAY.test(s)) return false
  const [y, m, d] = s.split('-').map(Number)
  return toIso(y, m - 1, d) === s // rejects 2026-02-30
}

export function parts(iso: string): { y: number; m: number; d: number } {
  const [y, m, d] = iso.split('-').map(Number)
  return { y, m: m - 1, d }
}

export function addDays(iso: string, n: number): string {
  const { y, m, d } = parts(iso)
  return toIso(y, m, d + n)
}

export function monthOf(iso: string): Month {
  const { y, m } = parts(iso)
  return { y, m }
}

export function addMonths(month: Month, n: number): Month {
  const t = new Date(Date.UTC(month.y, month.m + n, 1))
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() }
}

export const sameMonth = (a: Month, b: Month) => a.y === b.y && a.m === b.m
export const monthKey = (a: Month) => a.y * 12 + a.m

// The weeks of a month, Sunday first, as Indian travel calendars show them.
// Days outside the month are null, so a grid keeps its shape.
export function monthGrid(month: Month): (string | null)[][] {
  const first = new Date(Date.UTC(month.y, month.m, 1)).getUTCDay()
  const days = new Date(Date.UTC(month.y, month.m + 1, 0)).getUTCDate()
  const cells: (string | null)[] = Array.from({ length: first }, () => null)
  for (let d = 1; d <= days; d++) cells.push(toIso(month.y, month.m, d))
  while (cells.length % 7) cells.push(null)
  const weeks: (string | null)[][] = []
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7))
  return weeks
}

// Inside [min, max]; either bound may be absent.
export function withinBounds(iso: string, min?: string | null, max?: string | null): boolean {
  if (min && iso < min) return false
  if (max && iso > max) return false
  return true
}

// The nearest allowed day to `iso`.
export function clampDay(iso: string, min?: string | null, max?: string | null): string {
  if (min && iso < min) return min
  if (max && iso > max) return max
  return iso
}

// Today on this device, as a local date (not the UTC date: before 05:30 in
// India that is still yesterday).
export function todayIso(now: Date = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

const DAY_SHORT = new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })
const MONTH_FMT = new Intl.DateTimeFormat('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' })
const LONG_FMT = new Intl.DateTimeFormat('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })

const utc = (iso: string) => { const { y, m, d } = parts(iso); return new Date(Date.UTC(y, m, d)) }

// "Wed, 18 Nov 2026", or without the year when it is this year ("Wed, 18 Nov").
export function formatDay(iso: string, opts: { year?: 'always' | 'auto' } = {}): string {
  if (!isIsoDay(iso)) return ''
  const showYear = opts.year === 'always' || parts(iso).y !== new Date().getFullYear()
  // The year appended by hand: en-IN writes "Wed, 18 Nov, 2026", comma and all.
  return showYear ? `${DAY_SHORT.format(utc(iso))} ${parts(iso).y}` : DAY_SHORT.format(utc(iso))
}
export const formatMonth = (month: Month) => MONTH_FMT.format(new Date(Date.UTC(month.y, month.m, 1)))
// For screen readers: "Wednesday 18 November 2026".
export const spokenDay = (iso: string) => LONG_FMT.format(utc(iso)).replace(',', '')

export const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']
export const MONTH_NAMES = Array.from({ length: 12 }, (_, m) =>
  new Intl.DateTimeFormat('en-IN', { month: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(2026, m, 1))))
