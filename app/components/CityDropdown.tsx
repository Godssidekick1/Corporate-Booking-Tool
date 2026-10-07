'use client'

import { CitySelect } from '@/app/components/places/PlacePickers'
import { useCountryCode } from '@/app/components/StateDropdown'

// ── CityDropdown ─────────────────────────────────────────────────────────────
// Places in the address's country (and state, once chosen), searched over the
// GeoNames list on the server.
//
// A CITY IS A SUGGESTION, NOT A WHITELIST. A branch or a client can sit in a
// town no list has heard of, so when nothing matches, what was typed is kept
// (Enter). Traveller addresses are the strict case; see CitySelect.
// ─────────────────────────────────────────────────────────────────────────────

interface CityDropdownProps {
  value: string
  onChange: (value: string) => void
  // The country by name or ISO code, as the form holds it. Blank → India.
  country?: string
  state?: string
  disabled?: boolean
}

export default function CityDropdown({ value, onChange, country, state, disabled }: CityDropdownProps) {
  const code = useCountryCode(country)
  return (
    <CitySelect
      country={code}
      state={state}
      value={value}
      onChange={onChange}
      disabled={disabled}
      placeholder={state ? `Search cities in ${state}…` : 'Search or type a city…'}
    />
  )
}
