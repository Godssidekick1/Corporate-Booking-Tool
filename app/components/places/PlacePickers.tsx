'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import SearchableSelect from '@/app/components/SearchableSelect'
import { toDateInput, fromDateInput } from '@/app/lib/places/profileFormat'

// ── Place pickers ────────────────────────────────────────────────────────────
// Country, state and city pickers over the GeoNames reference data (CC BY 4.0),
// shared by every screen that records a place: traveller profiles, the
// employee's own profile, the booking passenger form, and the client, branch
// and GST screens through the CountryDropdown / StateDropdown / CityDropdown
// wrappers.
//
// Countries (~250) and a country's states arrive whole and filter in the
// browser; cities (~225,000) are searched on the server. Each list is fetched
// once per page load and shared by every picker on the page.
//
// A saved value from before these pickers ("India", "Indian", a misspelt
// state) is still shown -- with a note -- rather than silently blanked.
// ─────────────────────────────────────────────────────────────────────────────

export interface Country { code: string; name: string }
export interface Region { code: string; name: string }
interface City { id: number; name: string; region_code: string | null }

const cache = new Map<string, Promise<unknown>>()
function fetchOnce<T>(url: string, pick: (d: Record<string, unknown>) => T): Promise<T> {
  if (!cache.has(url)) {
    cache.set(url, fetch(url).then(r => r.json()).then(d => {
      if (!d.ok) throw new Error(d.error || `Could not load ${url}`)
      return pick(d)
    }).catch(err => { cache.delete(url); throw err }))
  }
  return cache.get(url) as Promise<T>
}

export function useCountries(): Country[] {
  const [countries, setCountries] = useState<Country[]>([])
  useEffect(() => {
    let live = true
    fetchOnce('/api/reference/countries', d => d.countries as Country[])
      .then(c => { if (live) setCountries(c) }).catch(() => {})
    return () => { live = false }
  }, [])
  return countries
}

export function useRegions(country: string): Region[] {
  const [regions, setRegions] = useState<{ country: string; list: Region[] }>({ country: '', list: [] })
  useEffect(() => {
    if (!country) return
    let live = true
    fetchOnce(`/api/reference/regions?country=${encodeURIComponent(country)}`, d => d.regions as Region[])
      .then(list => { if (live) setRegions({ country, list }) }).catch(() => {})
    return () => { live = false }
  }, [country])
  return regions.country === country ? regions.list : []
}

// A country code from a code or an English name, as older records hold either.
export function findCountry(countries: Country[], value: string): Country | null {
  const v = value.trim().toLowerCase()
  if (!v) return null
  return countries.find(c => c.code.toLowerCase() === v || c.name.toLowerCase() === v) ?? null
}

const note: React.CSSProperties = { fontSize: 11, color: '#B45309', margin: '4px 0 0' }
const credit: React.CSSProperties = { fontSize: 10, color: '#9CA3AF', margin: '4px 0 0' }

// ── CountrySelect ────────────────────────────────────────────────────────────
// `by` picks what is stored: 'code' (ISO 3166, what the airline takes: a
// profile's nationality and issuing country) or 'name' (an address shown to
// people: a client's or branch's country).
export function CountrySelect({ value, onChange, by = 'code', placeholder = 'Select a country…', disabled, allowClear }: {
  value: string
  onChange: (value: string) => void
  by?: 'code' | 'name'
  placeholder?: string
  disabled?: boolean
  allowClear?: boolean
}) {
  const countries = useCountries()
  const match = findCountry(countries, value)
  const id = match ? (by === 'code' ? match.code : match.name) : ''
  return (
    <div>
      <SearchableSelect
        value={id}
        onChange={onChange}
        options={countries.map(c => ({ id: by === 'code' ? c.code : c.name, label: c.name, sublabel: c.code }))}
        selectedLabel={match?.name ?? value}
        placeholder={countries.length ? placeholder : 'Loading…'}
        emptyMessage="No country matches"
        disabled={disabled || countries.length === 0}
        allowClear={allowClear}
      />
      {value && countries.length > 0 && !match && (
        <p style={note}>&ldquo;{value}&rdquo; isn&apos;t a country on the list. Choose one.</p>
      )}
    </div>
  )
}

// ── RegionSelect ─────────────────────────────────────────────────────────────
// A country's states or provinces, stored by name.
export function RegionSelect({ country, value, onChange, disabled, placeholder = 'Select a state…', sublabel }: {
  country: string
  value: string
  onChange: (name: string) => void
  disabled?: boolean
  placeholder?: string
  sublabel?: (name: string) => string | undefined
}) {
  const regions = useRegions(country)
  const match = regions.find(r => r.name.toLowerCase() === value.trim().toLowerCase())
  return (
    <div>
      <SearchableSelect
        value={match?.name ?? ''}
        onChange={onChange}
        options={regions.map(r => ({ id: r.name, label: r.name, sublabel: sublabel?.(r.name) }))}
        selectedLabel={match?.name ?? value}
        placeholder={country ? placeholder : 'Choose the country first'}
        emptyMessage="No state matches"
        disabled={disabled || !country}
      />
      {value && regions.length > 0 && !match && (
        <p style={note}>&ldquo;{value}&rdquo; isn&apos;t a state of this country. Choose one.</p>
      )}
    </div>
  )
}

// ── CitySelect ───────────────────────────────────────────────────────────────
// Places in a country (and state, once chosen), searched on the server.
// strict: only listed places can be chosen -- a traveller's address. Without
// it the typed text is kept when nothing matches -- a branch in a small town.
// A database without the city list (scripts/load-cities.mjs not yet run)
// falls back to typing.
export function CitySelect({ country, state, value, onChange, disabled, strict = false, placeholder = 'Search for a city…' }: {
  country: string
  state?: string
  value: string
  onChange: (name: string) => void
  disabled?: boolean
  strict?: boolean
  placeholder?: string
}) {
  const regions = useRegions(country)
  const regionCode = state ? regions.find(r => r.name.toLowerCase() === state.trim().toLowerCase())?.code ?? null : null
  const [results, setResults] = useState<City[]>([])
  const [loaded, setLoaded] = useState<boolean | null>(null)
  const [loading, setLoading] = useState(false)

  const search = useCallback((q: string) => {
    if (!country) return
    setLoading(true)
    const params = new URLSearchParams({ country, search: q })
    if (regionCode) params.set('region', regionCode)
    fetch(`/api/reference/cities?${params}`).then(r => r.json())
      .then(d => { if (d.ok) { setResults(d.cities); setLoaded(d.loaded) } })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [country, regionCode])

  useEffect(() => { search('') }, [search])

  const options = useMemo(() => results.map(c => ({ id: c.name, label: c.name })), [results])

  if (loaded === false) {
    return (
      <input
        value={value} disabled={disabled} placeholder="City"
        onChange={e => onChange(e.target.value)}
        style={{ height: 36, padding: '0 10px', fontSize: 13, border: '1px solid #D1D5DB', borderRadius: 7, width: '100%', boxSizing: 'border-box' }}
      />
    )
  }

  return (
    <div>
      <SearchableSelect
        value={value}
        onChange={onChange}
        options={options}
        onSearch={search}
        loading={loading}
        selectedLabel={value}
        placeholder={country ? placeholder : 'Choose the country first'}
        emptyMessage={strict ? 'No place by that name' : 'Not listed: press Enter to keep what you typed'}
        disabled={disabled || !country}
        allowFreeText={!strict}
      />
      <p style={credit}>Place names: GeoNames (CC BY 4.0)</p>
    </div>
  )
}

// ── DateField ────────────────────────────────────────────────────────────────
// A calendar picker over the DD/MM/YYYY strings profiles store (the format the
// airline takes). min / max are YYYY-MM-DD, e.g. todayInput() so a birth date
// cannot be in the future or a passport already expired.
export function DateField({ value, onChange, min, max, disabled, style }: {
  value: string | undefined
  onChange: (ddmmyyyy: string) => void
  min?: string
  max?: string
  disabled?: boolean
  style?: React.CSSProperties
}) {
  return (
    <input
      type="date" value={toDateInput(value)} min={min} max={max} disabled={disabled}
      onChange={e => onChange(fromDateInput(e.target.value))}
      style={style}
    />
  )
}
