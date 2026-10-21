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

// ── Reference data, held in memory ───────────────────────────────────────────
// Saving one profile used to look the same country up three times (nationality,
// issuing country, address), and ask whether cities are loaded, each a query
// waiting on the one before: on a pooled, distant database that alone was
// seconds per save. Countries change only with a migration, so they are read
// once an hour. That a country's cities ARE loaded is remembered (they are
// loaded once, by scripts/load-cities.mjs, and stay); that they are not is
// asked again each time, so a load takes effect on the very next save.
// ─────────────────────────────────────────────────────────────────────────────

const COUNTRIES_FOR = 60 * 60_000

type CountryIndex = { byKey: Map<string, reference.Country> }
let countries: { at: number; index: Promise<CountryIndex> } | null = null
const citiesLoaded = new Set<string>()

function countryIndex(db: Queryable): Promise<CountryIndex> {
  if (!countries || Date.now() - countries.at > COUNTRIES_FOR) {
    const index = reference.countriesForLookup(db).then(rows => {
      const byKey = new Map<string, reference.Country>()
      for (const r of rows) {
        const c = { code: r.code, name: r.name }
        byKey.set(`code:${r.code.toUpperCase()}`, c)
        if (r.iso3) byKey.set(`iso3:${r.iso3.toUpperCase()}`, c)
        byKey.set(`name:${r.name.toLowerCase()}`, c)
      }
      return { byKey }
    })
    // A failed read is not remembered: the next save asks again.
    index.catch(() => { countries = null })
    countries = { at: Date.now(), index }
  }
  return countries.index
}

// A country by its code, ISO3 code or English name, case-insensitively -- as
// reference.findCountry, from memory.
async function findCountry(db: Queryable, value: string): Promise<reference.Country | null> {
  const { byKey } = await countryIndex(db)
  return byKey.get(`code:${value.toUpperCase()}`) ?? byKey.get(`iso3:${value.toUpperCase()}`)
    ?? byKey.get(`name:${value.toLowerCase()}`) ?? null
}

async function hasCities(db: Queryable, country: string): Promise<boolean> {
  if (citiesLoaded.has(country)) return true
  const yes = await reference.hasCities(db, country)
  if (yes) citiesLoaded.add(country)
  return yes
}

export async function resolveCountryCode(db: Queryable, value: string): Promise<string | null> {
  const v = value.trim()
  if (!v) return null
  const demonym = countryForDemonym(v)
  if (demonym) return demonym
  return (await findCountry(db, v))?.code ?? null
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

  // The three country fields together (from memory, so no waiting on each).
  const countryFields = (['nationality', 'issuingCountry', 'country'] as const).filter(f => input[f] !== undefined)
  const codes = await Promise.all(countryFields.map(f => input[f]!.trim() ? resolveCountryCode(db, input[f]!) : Promise.resolve('')))
  for (const [i, field] of countryFields.entries()) {
    const value = input[field]!
    if (codes[i] === null) return { ok: false, field, error: `${LABEL[field]} "${value.trim()}" is not a country. Choose one from the list.` }
    out[field] = codes[i] as string
  }

  const country = out.country || (await resolveCountryCode(db, existing.country ?? '')) || DEFAULT_COUNTRY

  // Whether this country's cities are loaded, asked alongside the state.
  const citiesKnown = input.city !== undefined && input.city.trim() ? hasCities(db, country) : null
  citiesKnown?.catch(() => {})

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
    else if (!(await citiesKnown)) out.city = value
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
  return (await findCountry(db, code))?.name ?? code
}
