import type { FareRules, FareRuleWindow, FareRuleSector } from '@/app/lib/book/fareRules'
import { hoursText } from '@/app/lib/book/fareRules'
import { isIndianAirport } from '@/app/lib/rule-engine/classifyTrip'

// ── The airline penalty a fare's rules say a cancellation costs ──────────────
// For the refund panel's "Airline penalty" line: the cancellation window that
// held when the ticket was cancelled, per sector, added up. Every window is
// "hours before departure" (app/lib/book/fareRules.ts), so the one number
// needed per sector is how long before its departure the cancellation came.
//
// A prefill, never a decision: the desk can change it. Nothing is prefilled,
// and the reason is given instead, when the rules cannot be trusted to give
// the right figure:
//   - the provider's own cancellation answer already charged something: that
//     charge is usually this same penalty, and taking both would charge the
//     company twice (the rules' figure is still shown as a cross-check);
//   - the fare is non-refundable at that point (the airline keeps the fare
//     itself, which a penalty line does not express);
//   - a charge is not in rupees, no window covers the moment, or a sector has
//     no departure time to measure from.
//
// Departures are the GDS's travel date, local time at the origin, read as
// India time (+05:30): exact for domestic sectors, and said so otherwise.
// ─────────────────────────────────────────────────────────────────────────────

export interface PenaltyFromRules {
  // What to prefill, per ticket; null when nothing should be.
  amount: number | null
  // What the rules give, even when not prefilled (for the cross-check).
  rulesAmount: number | null
  // One line per sector: how the figure was reached.
  basis: string[]
  warnings: string[]
}

const IST_OFFSET = '+05:30'
const inr = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`

// "2026-12-07 07:30" (local at the origin) as an instant, read as India time.
export function departureOf(sector: Pick<FareRuleSector, 'travelDate'>): Date | null {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/.exec(sector.travelDate ?? '')
  if (!m) return null
  const d = new Date(`${m[1]}T${m[2]}:00${IST_OFFSET}`)
  return Number.isNaN(d.getTime()) ? null : d
}

// The ticket's passenger type as the rules file it: ADT, CHD or INF.
export function rulePaxType(paxType: string | null | undefined): string {
  const t = (paxType ?? '').trim().toUpperCase()
  if (t.startsWith('C')) return 'CHD'
  if (t.startsWith('I')) return 'INF'
  return 'ADT'
}

// The cancellation window in force `hours` before departure. A free window
// just after booking wins; on a shared boundary ("till 2 hours"), the window
// before departure wins over no-show.
export function windowAt(windows: FareRuleWindow[], hours: number): FareRuleWindow | null {
  if (hours < 0) return windows.find(w => w.kind === 'no_show') ?? null
  const holds = (w: FareRuleWindow) => hours >= w.fromHours && hours <= w.toHours
  for (const kind of ['after_booking', 'before_departure', 'no_show'] as const) {
    const w = windows.find(x => x.kind === kind && holds(x))
    if (w) return w
  }
  // Earlier than the furthest window's upper bound, which is only when the
  // rules were fetched: that window still applies.
  const before = windows.filter(w => w.kind === 'before_departure')
  const furthest = before.reduce<FareRuleWindow | null>((m, w) => (!m || w.toHours > m.toHours ? w : m), null)
  return furthest && hours > furthest.toHours ? furthest : null
}

export function penaltyFromRules(
  rules: FareRules | null | undefined,
  ticket: { paxType: string | null | undefined; cancelledAt: string | Date | null | undefined; providerCharge: number },
): PenaltyFromRules | null {
  if (!rules?.sectors.length || !ticket.cancelledAt) return null
  const cancelledAt = new Date(ticket.cancelledAt)
  if (Number.isNaN(cancelledAt.getTime())) return null
  const paxType = rulePaxType(ticket.paxType)

  const basis: string[] = []
  const warnings: string[] = []
  let total = 0
  let usable = true

  for (const sector of rules.sectors) {
    const where = `${sector.origin ?? '?'} → ${sector.destination ?? '?'}`
    const pax = sector.pax.find(p => p.paxType === paxType) ?? sector.pax.find(p => p.paxType === 'ADT')
    if (!pax) { warnings.push(`${where}: the rules have no ${paxType} fare.`); usable = false; continue }
    if (pax.paxType !== paxType) warnings.push(`${where}: no ${paxType} rule; the adult rule is used.`)

    const departure = departureOf(sector)
    if (!departure) { warnings.push(`${where}: no departure time to measure from.`); usable = false; continue }
    const hours = (departure.getTime() - cancelledAt.getTime()) / 3_600_000
    const when = hours < 0 ? 'after departure' : `${hoursText(Math.floor(hours))} before departure`

    const w = windowAt(pax.cancel, hours)
    if (!w) { warnings.push(`${where}: no cancellation rule covers ${when}.`); usable = false; continue }
    if (!w.permitted) {
      warnings.push(`${where}: non-refundable ${w.kind === 'no_show' ? 'as a no-show' : 'at that point'} (cancelled ${when}). The airline keeps the fare; enter what it refunds.`)
      usable = false
      continue
    }
    if (w.currency !== 'INR') { warnings.push(`${where}: the charge is in ${w.currency}; enter it in rupees.`); usable = false; continue }
    total += w.amount
    basis.push(`${where}: ${w.amount ? inr(w.amount) : 'free'} (${w.label.charAt(0).toLowerCase()}${w.label.slice(1)}; cancelled ${when})`)
  }

  const rulesAmount = usable ? Math.round(total * 100) / 100 : null
  if (rules.sectors.some(s => s.origin && !isIndianAirport(s.origin))) {
    warnings.push('Departure times are read as India time: check the window for a sector leaving from abroad.')
  }
  if (rulesAmount !== null && ticket.providerCharge > 0) {
    const same = Math.abs(ticket.providerCharge - rulesAmount) < 1
    warnings.push(`The airline already charged ${inr(ticket.providerCharge)} on cancelling${same ? ', the same as the fare rules' : `; the fare rules say ${inr(rulesAmount)}`}. Not added again.`)
    return { amount: null, rulesAmount, basis, warnings }
  }
  return { amount: rulesAmount, rulesAmount, basis, warnings }
}
