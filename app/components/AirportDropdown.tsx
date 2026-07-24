'use client'

import { AIRPORTS_BY_COUNTRY, Airport } from '@/app/lib/data/locations'

interface AirportDropdownProps {
  value: string
  onChange: (value: string) => void
  id?: string
  label?: string
  disabled?: boolean
  exclude?: string
  dropdownStyle?: React.CSSProperties
}

export default function AirportDropdown({
  value, onChange, id, label, disabled, exclude, dropdownStyle,
}: AirportDropdownProps) {
  const allAirports = Object.values(AIRPORTS_BY_COUNTRY).flat() as Airport[]
  const isInvalid = value !== '' && !allAirports.some(a => a.code === value)

  const defaultStyle: React.CSSProperties = {
    height: '38px', padding: '0 10px', fontSize: '13px', color: '#111827',
    background: '#fff', border: '1px solid #D1D5DB', borderRadius: '7px',
    outline: 'none', width: '100%',
  }

  return (
    <div>
      {label && (
        <label htmlFor={id} style={labelStyle}>{label}</label>
      )}
      <select
        id={id}
        value={value}
        onChange={e => onChange(e.target.value)}
        disabled={disabled}
        required
        style={{
          ...(dropdownStyle ?? defaultStyle),
          borderColor: isInvalid ? '#DC2626' : undefined,
        }}
      >
        <option value="">Select airport…</option>
        {Object.entries(AIRPORTS_BY_COUNTRY).map(([country, airports]) => (
          <optgroup key={country} label={country}>
            {(airports as Airport[])
              .filter(a => a.code !== exclude)
              .map(a => (
                <option key={a.code} value={a.code}>
                  {a.city} ({a.code}) — {a.name}
                </option>
              ))}
          </optgroup>
        ))}
      </select>
      {isInvalid && (
        <p style={errorStyle}>Unrecognised airport "{value}".</p>
      )}
    </div>
  )
}

const labelStyle: React.CSSProperties = {
  display: 'block', fontSize: '11px', fontWeight: 600,
  color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.6px', marginBottom: '6px',
}

const errorStyle: React.CSSProperties = {
  fontSize: '11px', color: '#DC2626', margin: '4px 0 0',
}