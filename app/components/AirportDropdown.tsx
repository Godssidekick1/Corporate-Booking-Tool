'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { AIRPORTS, Airport } from '@/app/lib/data/locations'

// ── AirportDropdown ────────────────────────────────────────────────────────
// A real searchable combobox — type a city, airport name, or code, and the
// closest matches appear in a dropdown. Replaces what used to be a plain
// grouped <select> (which only supported browser-native jump-to-first-letter,
// not real search across city/name/code).
//
// Keeps the exact same prop interface as the old version (value/onChange/
// exclude/dropdownStyle) so callers (book/flights) don't need to change at
// all — this is a drop-in replacement.
// ─────────────────────────────────────────────────────────────────────────────

interface AirportDropdownProps {
  value: string
  onChange: (value: string) => void
  id?: string
  label?: string
  disabled?: boolean
  exclude?: string
  dropdownStyle?: React.CSSProperties
}

function airportLabel(a: Airport): string {
  return `${a.city} (${a.code}) — ${a.name}`
}

// Ranks matches so the most useful result is first: exact code match beats
// city-starts-with beats city-contains beats name-contains. A plain
// substring filter alone (no ranking) would put e.g. "New Delhi" below
// "Newark" for a query like "new" purely on array order, which reads as
// broken even though it's technically "matching."
function rankMatch(a: Airport, query: string): number {
  const q = query.toLowerCase().trim()
  if (!q) return 0
  const code = a.code.toLowerCase()
  const city = a.city.toLowerCase()
  const name = a.name.toLowerCase()

  if (code === q) return 0
  if (code.startsWith(q)) return 1
  if (city.startsWith(q)) return 2
  if (city.includes(q)) return 3
  if (name.startsWith(q)) return 4
  if (name.includes(q)) return 5
  return -1 // no match
}

export default function AirportDropdown({
  value, onChange, id, label, disabled, exclude, dropdownStyle,
}: AirportDropdownProps) {
  const selected = AIRPORTS.find(a => a.code === value) ?? null

  const [query, setQuery] = useState(selected ? airportLabel(selected) : '')
  const [isOpen, setIsOpen] = useState(false)
  const [highlightedIndex, setHighlightedIndex] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Keep the displayed text in sync if `value` changes from outside (e.g.
  // the search page's swap-origin-destination button).
  useEffect(() => {
    const current = AIRPORTS.find(a => a.code === value) ?? null
    setQuery(current ? airportLabel(current) : '')
  }, [value])

  const results = useMemo(() => {
    if (!isOpen) return []
    const isShowingSelectedLabel = selected && query === airportLabel(selected)
    const effectiveQuery = isShowingSelectedLabel ? '' : query

    return AIRPORTS
      .filter(a => a.code !== exclude)
      .map(a => ({ airport: a, rank: rankMatch(a, effectiveQuery) }))
      .filter(r => effectiveQuery === '' || r.rank >= 0)
      .sort((x, y) => x.rank - y.rank)
      .slice(0, 8)
      .map(r => r.airport)
  }, [query, isOpen, exclude, selected])

  useEffect(() => {
    setHighlightedIndex(0)
  }, [results])

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false)
        // Reverting to the selected airport's label on blur-without-pick
        // avoids leaving a half-typed query showing as if it were the
        // actual selection.
        setQuery(selected ? airportLabel(selected) : '')
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [selected])

  function selectAirport(airport: Airport) {
    onChange(airport.code)
    setQuery(airportLabel(airport))
    setIsOpen(false)
    inputRef.current?.blur()
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (!isOpen) {
      if (e.key === 'ArrowDown' || e.key === 'Enter') setIsOpen(true)
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlightedIndex(i => Math.min(i + 1, results.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlightedIndex(i => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (results[highlightedIndex]) selectAirport(results[highlightedIndex])
    } else if (e.key === 'Escape') {
      setIsOpen(false)
      setQuery(selected ? airportLabel(selected) : '')
    }
  }

  const isInvalid = value !== '' && !selected

  const defaultStyle: React.CSSProperties = {
    height: '38px', padding: '0 10px', fontSize: '13px', color: '#111827',
    background: '#fff', border: '1px solid #D1D5DB', borderRadius: '7px',
    outline: 'none', width: '100%', boxSizing: 'border-box',
  }
  const inputStyle = { ...(dropdownStyle ?? defaultStyle), borderColor: isInvalid ? '#DC2626' : (dropdownStyle ?? defaultStyle).borderColor }

  return (
    <div ref={containerRef} style={{ position: 'relative' }}>
      {label && <label htmlFor={id} style={labelStyle}>{label}</label>}
      <input
        ref={inputRef}
        id={id}
        type="text"
        role="combobox"
        aria-expanded={isOpen}
        aria-autocomplete="list"
        autoComplete="off"
        value={query}
        disabled={disabled}
        placeholder="City, airport, or code…"
        onFocus={() => {
          setIsOpen(true)
          // Selecting all text on focus so typing immediately replaces the
          // current selection's label, rather than requiring a manual clear.
          inputRef.current?.select()
        }}
        onChange={e => {
          setQuery(e.target.value)
          setIsOpen(true)
          if (value) onChange('') // typing invalidates the previous selection until a new one is picked
        }}
        onKeyDown={handleKeyDown}
        style={inputStyle}
      />

      {isOpen && results.length > 0 && (
        <div style={dropdownWrapStyle}>
          {results.map((a, i) => (
            <div
              key={a.code}
              // onMouseDown (not onClick) fires before the input's onBlur/
              // click-outside handler, so the pick registers before the
              // dropdown closes itself out from under the click.
              onMouseDown={e => { e.preventDefault(); selectAirport(a) }}
              onMouseEnter={() => setHighlightedIndex(i)}
              style={{ ...optionStyle, ...(i === highlightedIndex ? optionHighlightStyle : {}) }}
            >
              <span style={optionCityStyle}>{a.city}</span>
              <span style={optionCodeStyle}>{a.code}</span>
              <span style={optionNameStyle}>{a.name}</span>
            </div>
          ))}
        </div>
      )}

      {isOpen && query.trim() !== '' && results.length === 0 && (
        <div style={dropdownWrapStyle}>
          <div style={emptyStyle}>No airports match "{query}"</div>
        </div>
      )}

      {isInvalid && !isOpen && (
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

const dropdownWrapStyle: React.CSSProperties = {
  position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 30,
  background: '#fff', border: '1px solid #E5E7EB', borderRadius: '10px',
  boxShadow: '0 8px 24px rgba(0,0,0,0.08)', overflow: 'hidden', maxHeight: '280px', overflowY: 'auto',
}

const optionStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'baseline', gap: '8px', padding: '9px 12px',
  cursor: 'pointer', borderBottom: '1px solid #F9FAFB',
}

const optionHighlightStyle: React.CSSProperties = {
  background: '#EEF2FF',
}

const optionCityStyle: React.CSSProperties = {
  fontSize: '12.5px', fontWeight: 600, color: '#111827',
}

const optionCodeStyle: React.CSSProperties = {
  fontSize: '11px', fontWeight: 700, color: '#3730A3', background: '#EEF2FF', padding: '1px 6px', borderRadius: '4px',
}

const optionNameStyle: React.CSSProperties = {
  fontSize: '11px', color: '#9CA3AF', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
}

const emptyStyle: React.CSSProperties = {
  padding: '14px 12px', fontSize: '12px', color: '#9CA3AF', textAlign: 'center',
}