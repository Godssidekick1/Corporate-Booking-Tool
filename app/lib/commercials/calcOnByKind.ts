// ── The commercial rule vocabulary ───────────────────────────────────────────
// Kinds, calculation bases, fare types and which combinations are offered.
//
// NO IMPORTS, deliberately. This is read by the resolver (pure), by the route
// handlers (server, service-role client) and by the rule editor (browser).
// Putting it anywhere that touches Supabase would drag the service-role client
// into the client bundle — the same reason app/lib/fop/paymentTypes.ts exists
// separately from clientGates.ts.
//
// WHICH calc_on VALUES EACH KIND MAY USE IS NOT A DATABASE CHECK. It lives here
// for the reason permissionKeys.ts gives about permission keys: the valid set is
// app-level config, and adding one should not require a migration. The routes
// validate against it before writing.
// ─────────────────────────────────────────────────────────────────────────────

export const COMMERCIAL_KINDS = ['markup', 'discount', 'processing_fee'] as const
export type CommercialKind = typeof COMMERCIAL_KINDS[number]

export const KIND_LABELS: Record<CommercialKind, string> = {
  markup: 'Markup',
  discount: 'Discount',
  processing_fee: 'Processing fee',
}

// What each does to a price, in one sentence, for the screen that edits it.
export const KIND_EFFECTS: Record<CommercialKind, string> = {
  markup:
    'Added to the fare and never itemised. The traveller sees a more expensive flight, not a markup line.',
  discount:
    'Shown as its own line and taken off the total. The airline does not fund it, so it comes out of your margin.',
  processing_fee:
    'Shown as its own line and added to the total. Multiplied by passengers, and by sectors when charged per sector.',
}

export const CALC_TYPES = ['percent', 'fixed'] as const
export type CalcType = typeof CALC_TYPES[number]

// ── CalcOn ───────────────────────────────────────────────────────────────────
// Which part of the fare a rate is calculated against.
//
// YQ is conventionally the fuel/insurance surcharge and YR the carrier-imposed
// misc fee. Both are filed in the TAX box rather than in the fare, and airlines
// use them somewhat interchangeably — which is exactly why "base + YQ" and
// "base + YQ + YR" are different commercial arrangements worth different money.
export const CALC_ON = ['bf', 'yq', 'yr', 'bf_yq', 'bf_yq_yr', 'tf', 'other_tax'] as const
export type CalcOn = typeof CALC_ON[number]

export const CALC_ON_LABELS: Record<CalcOn, string> = {
  bf: 'Base fare',
  yq: 'YQ only (fuel surcharge)',
  yr: 'YR only (carrier fee)',
  bf_yq: 'Base fare + YQ',
  bf_yq_yr: 'Base fare + YQ + YR',
  tf: 'Total fare',
  other_tax: 'Other taxes',
}

// Bases that need individual tax lines to compute. Until a live payload has
// confirmed whether YQ is counted inside Total.OtherTax or sits outside it,
// these are offered with a warning rather than silently producing a number
// nobody has reconciled.
export const CALC_ON_NEEDS_TAX_LINES: CalcOn[] = ['yq', 'yr', 'bf_yq', 'bf_yq_yr', 'other_tax']

// Which bases each kind offers. The old screens differed: markup listed
// "BF / YQ / other tax" while discount listed "BF / BF+YQ / TF / BF+YQ+YR".
// Both vocabularies are preserved rather than forced into one, because a TMC
// reading the screen expects to see the options it negotiated against.
export const CALC_ON_BY_KIND: Record<CommercialKind, CalcOn[]> = {
  markup: ['bf', 'yq', 'yr', 'other_tax'],
  discount: ['bf', 'bf_yq', 'bf_yq_yr', 'tf'],
  processing_fee: ['bf', 'bf_yq', 'tf'],
}

export function isCalcOnAllowed(kind: CommercialKind, calcOn: string): boolean {
  return (CALC_ON_BY_KIND[kind] as string[]).includes(calcOn)
}

// ── Fare type ────────────────────────────────────────────────────────────────
// The old discount screen carried four rate columns side by side. One fare_type
// per rule instead, so a rule always has exactly one rate and the resolver never
// has to know which column to read — four different rates is four rows.
//
// 'soo' and 'side_trip' are carried through from the screen this replaces
// WITHOUT a definition attached, because nobody has given one. If they turn out
// not to be fare types at all, only this list changes.
export const FARE_TYPES = ['all', 'retail', 'corporate', 'soo', 'side_trip'] as const
export type FareType = typeof FARE_TYPES[number]

export const FARE_TYPE_LABELS: Record<FareType, string> = {
  all: 'All fare types',
  retail: 'Retail',
  corporate: 'Corporate',
  soo: 'SOO',
  side_trip: 'Side trip',
}

// ── Cabin ────────────────────────────────────────────────────────────────────
// The cabin, NOT the booking class. One cabin holds many RBDs at very different
// prices — rbd_spec is the field that keys on those, and it reuses the parser in
// app/lib/fop/rbdSpec.ts rather than inventing a second spec syntax.
export const CABINS = ['Y', 'W', 'C', 'F'] as const
export type Cabin = typeof CABINS[number]

export const CABIN_LABELS: Record<Cabin, string> = {
  Y: 'Economy',
  W: 'Premium economy',
  C: 'Business',
  F: 'First',
}

// ── Processing fee only ──────────────────────────────────────────────────────
// Passengers ALWAYS multiply — a fee is per ticket and every passenger gets a
// ticket. This decides whether sectors multiply as well, so ₹250 on a
// 3-passenger 2-sector booking is ₹750 per transaction and ₹1,500 per sector.
export const CALC_BASES = ['per_transaction', 'per_sector'] as const
export type CalcBasis = typeof CALC_BASES[number]

export const CALC_BASIS_LABELS: Record<CalcBasis, string> = {
  per_transaction: 'Per transaction (× passengers)',
  per_sector: 'Per sector (× passengers × sectors)',
}

export function isCommercialKind(value: string): value is CommercialKind {
  return (COMMERCIAL_KINDS as readonly string[]).includes(value)
}
