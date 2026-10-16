import type { TripDetails } from '@/app/lib/repositories/trips'

// ── A trip's details, from a request body ────────────────────────────────────
// What the New trip form and the trip page send: travel type, billable, a
// project (free text, optional), currency, budget and cost centre. One parser
// for both, so creating and editing cannot accept different things.
//
// Only fields PRESENT in the body are returned -- an edit changes what it
// names and nothing else. The cost centre is checked against the traveller's
// client by the route (it needs the database); its shape is checked here.
// ─────────────────────────────────────────────────────────────────────────────

// The currencies a budget is offered in. Any ISO code is valid in the
// database; this is the list the form shows.
export const TRIP_CURRENCIES = ['INR', 'USD', 'EUR', 'GBP', 'AED', 'SGD'] as const

export const TRAVEL_TYPES = ['domestic', 'international'] as const

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const PROJECT_MAX = 120
const BUDGET_MAX = 10_000_000_000

export type ParsedDetails = { ok: true; details: TripDetails } | { ok: false; error: string }

export function parseTripDetails(body: Record<string, unknown>): ParsedDetails {
  const d: TripDetails = {}

  if ('travelType' in body) {
    const v = body.travelType
    if (v === null || v === '') d.travel_type = null
    else if (typeof v === 'string' && (TRAVEL_TYPES as readonly string[]).includes(v)) d.travel_type = v as 'domestic' | 'international'
    else return { ok: false, error: 'travelType must be "domestic" or "international"' }
  }

  if ('billable' in body) {
    if (typeof body.billable !== 'boolean') return { ok: false, error: 'billable must be true or false' }
    d.billable = body.billable
  }

  if ('project' in body) {
    const v = body.project
    if (v === null || v === undefined) d.project = null
    else if (typeof v !== 'string') return { ok: false, error: 'project must be text' }
    else {
      const p = v.trim()
      if (p.length > PROJECT_MAX) return { ok: false, error: `project is at most ${PROJECT_MAX} characters` }
      d.project = p || null
    }
  }

  if ('currency' in body) {
    const v = typeof body.currency === 'string' ? body.currency.trim().toUpperCase() : ''
    if (!/^[A-Z]{3}$/.test(v)) return { ok: false, error: 'currency must be a three-letter code, e.g. INR' }
    d.currency = v
  }

  if ('budgetAmount' in body) {
    const v = body.budgetAmount
    if (v === null || v === '') d.budget_amount = null
    else {
      const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
      if (!Number.isFinite(n) || n < 0 || n > BUDGET_MAX) return { ok: false, error: 'budgetAmount must be a number of 0 or more' }
      d.budget_amount = Math.round(n * 100) / 100
    }
  }

  if ('costCentreId' in body) {
    const v = body.costCentreId
    if (v === null || v === '') d.cost_centre_id = null
    else if (typeof v === 'string' && UUID.test(v)) d.cost_centre_id = v
    else return { ok: false, error: 'costCentreId is not a cost centre id' }
  }

  return { ok: true, details: d }
}
