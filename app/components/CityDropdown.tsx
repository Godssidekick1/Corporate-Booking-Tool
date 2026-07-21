'use client'

import { ALL_INDIAN_CITIES } from '@/app/lib/data/locations'

interface CityDropdownProps {
  value: string
  onChange: (value: string) => void
  id?: string
  name?: string
  disabled?: boolean
}

export default function CityDropdown({ value, onChange, id, name, disabled }: CityDropdownProps) {
  const isInvalid = value !== '' && !ALL_INDIAN_CITIES.includes(value)

  return (
    <div>
      <select
        id={id}
        name={name}
        value={ALL_INDIAN_CITIES.includes(value) ? value : ''}
        onChange={e => onChange(e.target.value)}
        disabled={disabled}
        style={{ ...inputStyle, borderColor: isInvalid ? '#DC2626' : '#D1D5DB' }}
      >
        <option value="">Select a city…</option>
        {ALL_INDIAN_CITIES.map(city => (
          <option key={city} value={city}>{city}</option>
        ))}
      </select>
      {isInvalid && (
        <p style={errorStyle}>
          "{value}" isn't a recognized city. Please select one from the list.
        </p>
      )}
    </div>
  )
}

const inputStyle: React.CSSProperties = {
  height: '38px', padding: '0 10px', fontSize: '13px', color: '#111827',
  background: '#fff', border: '1px solid #D1D5DB', borderRadius: '7px', outline: 'none', width: '100%',
}

const errorStyle: React.CSSProperties = {
  fontSize: '11px', color: '#DC2626', margin: '4px 0 0',
}