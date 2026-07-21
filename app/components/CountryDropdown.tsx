'use client'

import { COMMON_COUNTRIES } from '@/app/lib/data/locations'

interface CountryDropdownProps {
  value: string
  onChange: (value: string) => void
  id?: string
  name?: string
  disabled?: boolean
}

export default function CountryDropdown({ value, onChange, id, name, disabled }: CountryDropdownProps) {
  const isInvalid = value !== '' && !COMMON_COUNTRIES.includes(value)

  return (
    <div>
      <select
        id={id}
        name={name}
        value={COMMON_COUNTRIES.includes(value) ? value : ''}
        onChange={e => onChange(e.target.value)}
        disabled={disabled}
        style={{ ...inputStyle, borderColor: isInvalid ? '#DC2626' : '#D1D5DB' }}
      >
        <option value="">Select a country…</option>
        {COMMON_COUNTRIES.map(country => (
          <option key={country} value={country}>{country}</option>
        ))}
      </select>
      {isInvalid && (
        <p style={errorStyle}>
          "{value}" isn't a recognized country. Please select one from the list.
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