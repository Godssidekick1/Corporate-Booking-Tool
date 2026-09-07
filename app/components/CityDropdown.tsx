'use client'

import SearchableSelect from './SearchableSelect'
import { ALL_INDIAN_CITIES, citiesForState } from '@/app/lib/data/locations'

// ── CityDropdown ─────────────────────────────────────────────────────────────
// Typable, wrapping SearchableSelect rather than being a second dropdown
// pattern of its own.
//
// A CITY IS A SUGGESTION, NOT A WHITELIST. The old version rendered a plain
// <select> whose value silently became '' for anything not on a 40-entry list,
// then complained the value "isn't a recognized city". A branch or a client can
// sit in a town this list has never heard of, and the list is ours, not theirs
// — so an unlisted value is kept, shown, and flagged as unrecognised rather than
// discarded.
//
// `state` narrows the suggestions once one is chosen; without it, every city.
// ─────────────────────────────────────────────────────────────────────────────

interface CityDropdownProps {
  value: string
  onChange: (value: string) => void
  id?: string
  name?: string
  disabled?: boolean
  state?: string
}

export default function CityDropdown({ value, onChange, disabled, state }: CityDropdownProps) {
  const suggestions = state ? citiesForState(state) : ALL_INDIAN_CITIES
  const unlisted = value !== '' && !ALL_INDIAN_CITIES.includes(value)

  return (
    <div>
      <SearchableSelect
        value={value}
        onChange={onChange}
        // The id IS the city name here: there is no separate key, and using the
        // name as the id lets a free-typed value round-trip unchanged.
        options={suggestions.map(city => ({ id: city, label: city }))}
        selectedLabel={value}
        allowFreeText
        placeholder={state ? `Search cities in ${state}…` : 'Search or type a city…'}
        emptyMessage="No suggestions — type the city name"
        disabled={disabled}
      />
      {unlisted && (
        <p style={noteStyle}>
          &ldquo;{value}&rdquo; isn&rsquo;t in our list. It has been kept — check the spelling.
        </p>
      )}
    </div>
  )
}

const noteStyle: React.CSSProperties = {
  fontSize: '11px', color: '#92400E', margin: '4px 0 0',
}
