import { isUuid } from '@/app/lib/book/bookingActor'
import type { ReportFilters, FilterKey } from './types'

// ── Reading a report's filters from the query string ─────────────────────────
// Dates are India's calendar days. Without them a report covers this month
// and the two before it ("Last 3 months"), which is also the screen's
// default. A range is at most three years: past that a monthly chart stops
// being readable and the query stops being cheap.
// ─────────────────────────────────────────────────────────────────────────────

const DAY = /^\d{4}-\d{2}-\d{2}$/
const MAX_DAYS = 366 * 3

// Today in India, as YYYY-MM-DD.
export function indiaToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(now)
}

function validDay(v: string): boolean {
  if (!DAY.test(v)) return false
  const d = new Date(`${v}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v
}

export function defaultRange(now: Date = new Date()): { from: string; to: string } {
  const today = indiaToday(now)
  const [y, m] = today.split('-').map(Number)
  const start = new Date(Date.UTC(y, m - 1 - 2, 1))
  return { from: start.toISOString().slice(0, 10), to: today }
}

export function parseFilters(
  params: URLSearchParams,
  allowed: readonly FilterKey[],
  now: Date = new Date(),
): { filters: ReportFilters } | { error: string } {
  const fallback = defaultRange(now)
  const from = params.get('from') || fallback.from
  const to = params.get('to') || fallback.to
  if (!validDay(from) || !validDay(to)) return { error: 'Dates must be YYYY-MM-DD' }
  if (from > to) return { error: 'The start date is after the end date' }
  const days = (Date.parse(to) - Date.parse(from)) / 86_400_000
  if (days > MAX_DAYS) return { error: 'Choose a range of three years or less' }

  const filters: ReportFilters = { from, to }
  for (const key of allowed) {
    const raw = params.get(key)?.trim()
    if (!raw) continue
    if (key === 'clientId' || key === 'clientGroupId') {
      if (!isUuid(raw)) return { error: `${key} is not a valid id` }
      filters[key] = raw
    } else if (key === 'billable') {
      if (raw !== 'yes' && raw !== 'no') return { error: 'billable is yes or no' }
      filters.billable = raw
    } else {
      if (raw.length > 120) return { error: `${key} is too long` }
      filters[key] = raw
    }
  }
  return { filters }
}
