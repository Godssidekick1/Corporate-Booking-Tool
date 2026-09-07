'use client'

import SearchableSelect from './SearchableSelect'
import { COMMON_COUNTRIES } from '@/app/lib/data/locations'

// ── CountryDropdown ──────────────────────────────────────────────────────────
// Typable, wrapping SearchableSelect so there is one dropdown pattern in the app
// rather than a plain <select> here and a combobox everywhere else.
//
// Unlike the city field this is NOT free text: the country list is short,
// deliberate, and drives real behaviour elsewhere (which airports are offered,
// which currency). An unrecognised country is a mistake, not a gap in our data,
// so the existing warning is kept.
// ─────────────────────────────────────────────────────────────────────────────

interface CountryDropdownProps {
  value: string
  onChange: (value: string) => void
  id?: string
  name?: string
  disabled?: boolean
}

export default function CountryDropdown({ value, onChange, disabled }: CountryDropdownProps) {
  const isInvalid = value !== '' && !COMMON_COUNTRIES.includes(value)

  return (
    <div>
      <SearchableSelect
        value={value}
        onChange={onChange}
        options={COMMON_COUNTRIES.map(country => ({ id: country, label: country }))}
        selectedLabel={value}
        placeholder="Search countries…"
        emptyMessage="No countries match"
        disabled={disabled}
      />
      {isInvalid && (
        <p style={errorStyle}>
          &ldquo;{value}&rdquo; isn&rsquo;t a recognised country. Please pick one from the list.
        </p>
      )}
    </div>
  )
}

const errorStyle: React.CSSProperties = {
  fontSize: '11px', color: '#DC2626', margin: '4px 0 0',
}
