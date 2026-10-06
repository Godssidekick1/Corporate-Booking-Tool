import type { Queryable } from '@/app/lib/db'
import * as reference from '@/app/lib/repositories/reference'
import { countryForDemonym } from '@/app/lib/places/profileFormat'

// ── normalisePlaces ──────────────────────────────────────────────────────────
// Turns the place fields of a traveller profile into their canonical form, or
// says why one is not a real place. Every route that saves a profile runs it:
// Traveller profiles (TMC), the employee's own profile, and the CSV import.
//
//   nationality, issuingCountry -> ISO 3166 code ('IN'), what the airline
//                                  takes. A country name, code or ISO3 code
//                                  is accepted, plus the demonyms below so
//                                  values typed before the picker convert.
//   country (address)           -> ISO code; India when not given, as every
//                                  client so far is Indian.
//   state                       -> the region's own name, within that country
//   city                        -> the place's own name, within that country
//                                  and state -- once cities are loaded
//                                  (scripts/load-cities.mjs). Before that a
//                                  city is kept as typed, rather than refusing
//                                  everything on a database without the list.
//
// Only the fields present are checked: a partial update leaves the others.
// Data: GeoNames (CC BY 4.0).
// ─────────────────────────────────────────────────────────────────────────────

export interface PlaceFields {
  nationality?: string
  issuingCountry?: string
  country?: string
  state?: string
  city?: string
}

export type PlaceResult =
  | { ok: true; fields: PlaceFields }
  | { ok: false; field: keyof PlaceFields; error: string }

export const DEFAULT_COUNTRY = 'IN'

export async function resolveCountryCode(db: Queryable, value: string): Promise<string | null> {
  const v = value.trim()
  if (!v) return null
  const demonym = countryForDemonym(v)
  if (demonym) return demonym
  return (await reference.findCountry(db, v))?.code ?? null
}

const LABEL: Record<keyof PlaceFields, string> = {
  nationality: 'Nationality', issuingCountry: 'Issuing country', country: 'Country', state: 'State', city: 'City',
}

export async function normalisePlaces(
  db: Queryable,
  input: PlaceFields,
  // What the profile already holds, so a city can be checked against the
  // stored state when only the city changes.
  existing: PlaceFields = {}
): Promise<PlaceResult> {
  const out: PlaceFields = {}

  for (const field of ['nationality', 'issuingCountry', 'country'] as const) {
    const value = input[field]
    if (value === undefined) continue
    if (!value.trim()) { out[field] = ''; continue }
    const code = await resolveCountryCode(db, value)
    if (!code) return { ok: false, field, error: `${LABEL[field]} "${value.trim()}" is not a country. Choose one from the list.` }
    out[field] = code
  }

  const country = out.country || (await resolveCountryCode(db, existing.country ?? '')) || DEFAULT_COUNTRY

  let regionCode: string | null = null
  if (input.state !== undefined) {
    const value = input.state.trim()
    if (!value) out.state = ''
    else {
      const region = await reference.findRegion(db, country, value)
      if (!region) return { ok: false, field: 'state', error: `"${value}" is not a state of ${await countryName(db, country)}. Choose one from the list.` }
      out.state = region.name
      regionCode = region.code
    }
  } else if (input.city !== undefined && existing.state) {
    regionCode = (await reference.findRegion(db, country, existing.state))?.code ?? null
  }

  if (input.city !== undefined) {
    const value = input.city.trim()
    if (!value) out.city = ''
    else if (!(await reference.hasCities(db, country))) out.city = value
    else {
      const city = await reference.findCity(db, country, regionCode, value)
      if (!city) {
        const where = (out.state ?? existing.state) || await countryName(db, country)
        return { ok: false, field: 'city', error: `"${value}" was not found in ${where}. Choose one from the list.` }
      }
      out.city = city.name
    }
  }

  return { ok: true, fields: out }
}

async function countryName(db: Queryable, code: string): Promise<string> {
  return (await reference.findCountry(db, code))?.name ?? code
}
