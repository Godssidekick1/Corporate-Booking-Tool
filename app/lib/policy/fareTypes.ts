// ── Fare types a policy can allow ────────────────────────────────────────────
// One short list, the way Indian corporate travel names fares: the fare class
// a supplier files (Retail, Corporate, SME, Tactical, Special), NDC content,
// and the airline brands companies most often rule on (IndiGo's Flexi, Super 6E,
// Stretch and StretchPlus).
//
// A policy's `allowed_fare_types` holds these codes. Nothing ticked means every
// type is allowed; once anything is ticked, fares of any other type are not
// shown to that traveller at all, and are refused if priced or booked anyway.
//
// Pure: the policy editor shows the list, the search filter and the price and
// add-passenger guards read the mapping.
// ─────────────────────────────────────────────────────────────────────────────

export const FARE_TYPES = [
  { code: 'RETAIL',      label: 'Retail' },
  { code: 'CORPORATE',   label: 'Corporate' },
  { code: 'SME',         label: 'SME' },
  { code: 'FLEXI',       label: 'Flexi' },
  { code: 'NDC',         label: 'NDC' },
  { code: 'TACTICAL',    label: 'Tactical' },
  { code: 'SPECIAL',     label: 'Special' },
  { code: 'SUPER6E',     label: 'Super 6E' },
  { code: 'STRETCH',     label: 'Stretch' },
  { code: 'STRETCHPLUS', label: 'StretchPlus' },
] as const

export type FareTypeCode = typeof FARE_TYPES[number]['code']

export const FARE_TYPE_LABEL: Record<string, string> =
  Object.fromEntries(FARE_TYPES.map(t => [t.code, t.label]))

export interface FareTypeSource {
  fareType?: string
  brandedFareName?: string
  isNdc?: boolean
}

// ── fareTypeOf ───────────────────────────────────────────────────────────────
// Which ONE of the types above a fare is. Each fare gets exactly one, so a
// policy's list reads as a plain "these, and nothing else". The order of the
// checks is the decision:
//   1. The airline brand, when it names one of ours (StretchPlus before
//      Stretch, since one contains the other). A brand is the most specific
//      thing a fare says about itself.
//   2. The supplier's fare class, when it is not plain retail ("CRP" is how
//      the provider files corporate fares; the others match by name).
//   3. NDC, for NDC content that is otherwise ordinary retail.
//   4. Retail: "NRM", no fare class at all, and anything we do not recognise.
//      Unknown reads as retail, the ordinary public fare, rather than as a
//      type nobody can allow -- a new provider code must not empty every
//      traveller's results the day it first appears.
// ─────────────────────────────────────────────────────────────────────────────
export function fareTypeOf(fare: FareTypeSource): FareTypeCode {
  const brand = (fare.brandedFareName ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (brand.includes('STRETCHPLUS')) return 'STRETCHPLUS'
  if (brand.includes('STRETCH')) return 'STRETCH'
  if (brand.includes('SUPER6E')) return 'SUPER6E'
  if (brand.includes('FLEXI')) return 'FLEXI'

  const code = (fare.fareType ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (code === 'CRP' || code.startsWith('CORP')) return 'CORPORATE'
  if (code === 'SME') return 'SME'
  if (code.startsWith('TACT')) return 'TACTICAL'
  if (code === 'SPL' || code.startsWith('SPECIAL')) return 'SPECIAL'
  if (code.startsWith('FLEXI')) return 'FLEXI'

  if (fare.isNdc) return 'NDC'
  return 'RETAIL'
}
