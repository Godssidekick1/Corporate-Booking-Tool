'use client'

import { RegionSelect, findCountry, useCountries } from '@/app/components/places/PlacePickers'
import { gstCodeForState } from '@/app/lib/data/locations'

// ── StateDropdown ────────────────────────────────────────────────────────────
// The states or provinces of the address's country (GeoNames), typable.
//
// Not free text, and that is the point: GST registers per state, so the state is
// the thing a GSTIN's first two digits have to agree with. A typed "Mahrashtra"
// could never be cross-checked, so this one stays a closed list.
//
// For India the GST code sits in the sublabel, because it is what someone
// reconciling a certificate against a GSTIN is actually looking for. The
// GeoNames names of India's 36 states and union territories are exactly the
// names the GST map in app/lib/data/locations.ts uses.
// ─────────────────────────────────────────────────────────────────────────────

interface StateDropdownProps {
  value: string
  onChange: (value: string) => void
  // The country by name or ISO code, as the form holds it. Blank → India.
  country?: string
  disabled?: boolean
}

export default function StateDropdown({ value, onChange, country, disabled }: StateDropdownProps) {
  const code = useCountryCode(country)
  return (
    <RegionSelect
      country={code}
      value={value}
      onChange={onChange}
      disabled={disabled}
      placeholder="Search states…"
      sublabel={code === 'IN' ? name => { const gst = gstCodeForState(name); return gst ? `GST code ${gst}` : undefined } : undefined}
    />
  )
}

// The ISO code for a form's country (stored by name). '' while the country
// list loads or when the value is not a country -- the state picker then waits.
export function useCountryCode(country: string | undefined): string {
  const countries = useCountries()
  return findCountry(countries, country?.trim() || 'India')?.code ?? ''
}
