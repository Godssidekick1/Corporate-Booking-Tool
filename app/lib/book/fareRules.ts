import type { FareRuleResponse } from '@/app/lib/amadeus/client'

// ── The airline's fare rules, made readable ──────────────────────────────────
// amadeus.fareRule answers with FareRulesFlight[].Remarks: a JSON STRING the
// GDS fills with each sector's policies (confirmed on the test system,
// 2026-11-16). This turns it into a plain structure the fare page, the booking
// pages and the refund panel all render the same way.
//
//   policyType 33 = cancellation / refund, 31 = change / reissue
//   condition  1  = before departure: a charge between `from` and `to` hours
//                   before departure
//              3  = no-show (the last hours before departure, and after)
//              4  = a free window just after booking ("within 48 hours of
//                   booking"), written as hours before departure too
//   permitted "T" / "F"; value + currency is the charge (per passenger, per
//   sector: the remarks say "per component")
//
// Every time is "hours before departure", so which window applies at a moment
// needs only that one number (app/lib/refunds/penaltyFromRules.ts).
//
// Never throws: a remarks string that is not JSON, or the GDS's error object
// ("NO FARE FOR BOOKING CODE"), becomes an `unavailable` note, not a crash.
// Unknown policy types and conditions are kept, labelled by their code.
// ─────────────────────────────────────────────────────────────────────────────

export type WindowKind = 'before_departure' | 'no_show' | 'after_booking' | 'other'

export interface FareRuleWindow {
  kind: WindowKind
  condition: number
  // Hours before departure; from <= to.
  fromHours: number
  toHours: number
  // The charge, per passenger per sector. 0 with permitted = free.
  amount: number
  currency: string
  permitted: boolean
  label: string
  note: string | null
}

export interface FareRulePax {
  paxType: string
  fareBasis: string | null
  cancel: FareRuleWindow[]
  change: FareRuleWindow[]
  other: { policyType: number; windows: FareRuleWindow[] }[]
}

export interface FareRuleSector {
  origin: string | null
  destination: string | null
  // As the GDS writes it: local time at the origin, "2026-12-07 07:30".
  travelDate: string | null
  carrier: string | null
  fareBasis: string[]
  // The TMC's negotiated code, when one priced the fare. Never shown to the
  // traveller (travellerFareRules strips it).
  dealCode: string | null
  pax: FareRulePax[]
}

export interface FareRules {
  sectors: FareRuleSector[]
  // The GDS's own reasons when it had no rule for a sector.
  unavailable: string[]
  fetchedAt: string
}

const CANCEL = 33
const CHANGE = 31

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN
  return Number.isFinite(n) ? n : null
}
// Keys as the provider spells them today, or PascalCase if that changes.
const field = (o: Record<string, unknown>, key: string): unknown =>
  o[key] ?? o[key.charAt(0).toUpperCase() + key.slice(1)] ?? o[key.toLowerCase()]

// ── Hours, in words ──────────────────────────────────────────────────────────

export function hoursText(h: number): string {
  if (h >= 48 && h % 24 === 0) return `${h / 24} days`
  return h === 1 ? '1 hour' : `${h} hours`
}

// ── Remarks, cleaned ─────────────────────────────────────────────────────────
// GDS remarks arrive lowercase or shouting, in fare-filing shorthand ("note
// till 02 hrs charge inr 5000 per component"). Tidied, never rewritten: the
// words stay the airline's.

const CURRENCIES = ['inr', 'usd', 'eur', 'gbp', 'aed', 'sgd', 'thb', 'sar', 'qar', 'omr', 'kwd', 'bhd', 'lkr', 'npr']
const MAX_REMARK = 600

export function cleanRemark(raw: unknown): string | null {
  let t = str(raw)
  if (!t) return null
  t = t.replace(/\s+/g, ' ')
  const letters = t.replace(/[^a-z]/gi, '')
  if (letters && letters === letters.toUpperCase()) t = t.toLowerCase()
  t = t
    .replace(new RegExp(`\\b(${CURRENCIES.join('|')})\\s*(?=\\d)`, 'gi'), m => `${m.trim().toUpperCase()} `)
    .replace(new RegExp(`\\b(${CURRENCIES.join('|')})\\b`, 'gi'), m => m.toUpperCase())
    .replace(/\b(yq|yr|pnr|gst)\b/gi, m => m.toUpperCase())
    .replace(/\b0*(\d+)\s*(hrs?|hours?)\b/gi, (_, n: string) => `${n} ${n === '1' ? 'hour' : 'hours'}`)
    .replace(/\batleast\b/gi, 'at least')
    .replace(/\bpax\b/gi, 'passenger')
    .replace(/(^|[.!?]\s+)note:?\s+/gi, (_, lead: string) => `${lead}Note: `)
    .replace(/(^|[.!?]\s+)([a-z])/g, (_, lead: string, c: string) => lead + c.toUpperCase())
    .trim()
  if (t.length > MAX_REMARK) t = `${t.slice(0, MAX_REMARK - 1).trimEnd()}…`
  if (!/[.!?…]$/.test(t)) t += '.'
  return t
}

// ── Windows ──────────────────────────────────────────────────────────────────

function windowsOf(timeline: unknown): FareRuleWindow[] {
  if (!Array.isArray(timeline)) return []
  const out: FareRuleWindow[] = []
  for (const step of timeline) {
    if (!isObj(step)) continue
    const condition = num(field(step, 'condition')) ?? 0
    const note = cleanRemark(field(step, 'remark'))
    const charges = Array.isArray(field(step, 'charge')) ? (field(step, 'charge') as unknown[]) : []
    for (const c of charges) {
      if (!isObj(c)) continue
      const from = num(field(c, 'from'))
      const to = num(field(c, 'to'))
      if (from === null || to === null) continue
      const permitted = String(field(c, 'permitted') ?? '').trim().toUpperCase()
      out.push({
        kind: condition === 1 ? 'before_departure' : condition === 3 ? 'no_show' : condition === 4 ? 'after_booking' : 'other',
        condition,
        fromHours: Math.min(from, to),
        toHours: Math.max(from, to),
        amount: Math.max(0, num(field(c, 'value')) ?? 0),
        currency: (str(field(c, 'currency')) ?? 'INR').toUpperCase(),
        permitted: permitted === 'T' || permitted === 'TRUE' || permitted === 'Y',
        label: '',
        note,
      })
    }
  }
  return label(out)
}

// Labels need the whole list: the furthest "before departure" window reads
// "More than 2 hours before departure", since its upper bound is only when
// the rules were fetched; the others read as a span.
function label(ws: FareRuleWindow[]): FareRuleWindow[] {
  const before = ws.filter(w => w.kind === 'before_departure')
  const furthest = before.reduce((m, w) => Math.max(m, w.toHours), -Infinity)
  const order: Record<WindowKind, number> = { after_booking: 0, before_departure: 1, no_show: 2, other: 3 }
  return ws
    .map(w => {
      let text: string
      switch (w.kind) {
        case 'before_departure':
          text = w.toHours === furthest
            ? (w.fromHours > 0 ? `More than ${hoursText(w.fromHours)} before departure` : 'Any time before departure')
            : `${hoursText(w.fromHours)} to ${hoursText(w.toHours)} before departure`
          break
        case 'no_show':
          text = w.toHours > 0 ? `No-show, or less than ${hoursText(w.toHours)} before departure` : 'No-show'
          break
        case 'after_booking':
          text = `Within ${hoursText(w.toHours - w.fromHours)} of booking`
          break
        default:
          text = `Rule ${w.condition}`
      }
      return { ...w, label: text }
    })
    // Soonest after booking first, departure last: the order time runs in.
    .sort((x, y) => order[x.kind] - order[y.kind] || y.toHours - x.toHours)
}

// ── The response ─────────────────────────────────────────────────────────────

function sectorOf(o: Record<string, unknown>): FareRuleSector {
  const pax: FareRulePax[] = []
  for (const p of Array.isArray(field(o, 'policy')) ? (field(o, 'policy') as unknown[]) : []) {
    if (!isObj(p)) continue
    const entry: FareRulePax = {
      paxType: (str(field(p, 'paxType')) ?? 'ADT').toUpperCase(),
      fareBasis: str(field(p, 'fareBasis')),
      cancel: [], change: [], other: [],
    }
    for (const pol of Array.isArray(field(p, 'policies')) ? (field(p, 'policies') as unknown[]) : []) {
      if (!isObj(pol)) continue
      const type = num(field(pol, 'policyType')) ?? 0
      const windows = windowsOf(field(pol, 'timeline'))
      if (type === CANCEL) entry.cancel.push(...windows)
      else if (type === CHANGE) entry.change.push(...windows)
      else if (windows.length) entry.other.push({ policyType: type, windows })
    }
    entry.cancel = label(entry.cancel)
    entry.change = label(entry.change)
    pax.push(entry)
  }
  const basis = field(o, 'fareBasis')
  return {
    origin: str(field(o, 'origin'))?.toUpperCase() ?? null,
    destination: str(field(o, 'destination'))?.toUpperCase() ?? null,
    travelDate: str(field(o, 'traveldate')) ?? str(field(o, 'travelDate')),
    carrier: str(field(o, 'validatingCarrier'))?.toUpperCase() ?? null,
    fareBasis: Array.isArray(basis) ? basis.map(str).filter((b): b is string => !!b) : str(basis) ? [str(basis)!] : [],
    dealCode: str(field(o, 'dealCode')),
    pax,
  }
}

export function parseFareRules(response: FareRuleResponse | null | undefined, now: Date = new Date()): FareRules | null {
  const flights = Array.isArray(response?.FareRulesFlight) ? response.FareRulesFlight : []
  const sectors: FareRuleSector[] = []
  const unavailable: string[] = []
  for (const f of flights) {
    const raw = isObj(f) ? field(f as Record<string, unknown>, 'remarks') : null
    if (typeof raw !== 'string' || !raw.trim()) continue
    let parsed: unknown
    try { parsed = JSON.parse(raw) } catch { unavailable.push('The airline’s rules could not be read.'); continue }
    for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
      if (!isObj(item)) continue
      const error = str(field(item, 'errorMessage'))
      if (error && !Array.isArray(field(item, 'policy'))) { unavailable.push(cleanRemark(error) ?? error); continue }
      const sector = sectorOf(item)
      if (sector.pax.length) sectors.push(sector)
    }
  }
  if (!sectors.length && !unavailable.length) return null
  return { sectors, unavailable: [...new Set(unavailable)], fetchedAt: now.toISOString() }
}

// What a traveller may see: everything but the TMC's negotiated deal code.
export function travellerFareRules(rules: FareRules | null | undefined): FareRules | null {
  if (!rules) return null
  return { ...rules, sectors: rules.sectors.map(s => ({ ...s, dealCode: null })) }
}

// A stored value read back from jsonb, checked loosely: a column written by an
// older shape, or by hand, renders as nothing rather than breaking a page.
export function asFareRules(v: unknown): FareRules | null {
  if (!isObj(v) || !Array.isArray(v.sectors)) return null
  return v as unknown as FareRules
}
