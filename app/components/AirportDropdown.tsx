'use client'

import { useEffect, useId, useRef, useState } from 'react'

// ── AirportDropdown ────────────────────────────────────────────────────────
// A real searchable combobox — type a city, airport name, code or country, and
// the closest matches appear in a dropdown.
//
// The airports are searched on the server (/api/reference/airports, ~5,500
// airports with IATA codes from OurAirports) rather than shipped to the
// browser: the old hand-made list of ~150 is why many real airports could not
// be searched at all. Ranking happens there: exact code, then code prefix,
// city, airport name, country; served and bigger airports first.
//
// Same props as before (value/onChange/exclude/dropdownStyle), so callers
// (book/flights) did not change. `value` is the IATA code.
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

interface Airport { code: string; name: string; city: string; country_code: string; country: string }

function airportLabel(a: Airport): string {
  return `${a.city} (${a.code}) — ${a.name}`
}

// One lookup per code per page, shared by both pickers on the search form.
const byCode = new Map<string, Promise<Airport | null>>()
function lookup(code: string): Promise<Airport | null> {
  if (!byCode.has(code)) {
    byCode.set(code, fetch(`/api/reference/airports?code=${encodeURIComponent(code)}`)
      .then(r => r.json())
      .then(d => (d.ok ? (d.airport as Airport | null) : null))
      .catch(() => { byCode.delete(code); return null }))
  }
  return byCode.get(code)!
}

export default function AirportDropdown({
  value, onChange, id, label, disabled, exclude, dropdownStyle,
}: AirportDropdownProps) {
  // What each code is, once known: undefined = not looked up yet, null = no
  // such airport.
  const [known, setKnown] = useState<Record<string, Airport | null>>({})
  const selected = value ? known[value] : null

  const [query, setQuery] = useState('')
  const [isOpen, setIsOpen] = useState(false)
  const [highlightedIndex, setHighlightedIndex] = useState(0)
  const [found, setFound] = useState<{ q: string; airports: Airport[] } | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const listId = useId()
  // Enter pressed before the server answered: pick its first answer instead.
  const pendingEnter = useRef(false)
  const inputRef = useRef<HTMLInputElement>(null)

  // A code set from outside (a saved search, a popular route, the swap
  // button) is looked up for its label.
  useEffect(() => {
    if (!value || value in known) return
    let live = true
    lookup(value).then(a => { if (live) setKnown(k => ({ ...k, [value]: a })) })
    return () => { live = false }
  }, [value, known])

  // While open the box shows what is typed; closed, the chosen airport.
  const shown = isOpen ? query : selected ? airportLabel(selected) : value
  // Opening the box puts the chosen airport's label in it, selected; that is
  // not a search, so it lists the default suggestions instead.
  const search = selected && query === airportLabel(selected) ? '' : query.trim()

  useEffect(() => {
    if (!isOpen) return
    let live = true
    const t = setTimeout(() => {
      fetch(`/api/reference/airports?search=${encodeURIComponent(search)}`)
        .then(r => r.json())
        .then(d => { if (live && d.ok) { setFound({ q: search, airports: d.airports }); setHighlightedIndex(0) } })
        .catch(() => {})
    }, search ? 200 : 0)
    return () => { live = false; clearTimeout(t) }
  }, [isOpen, search])

  const results = (found?.airports ?? []).filter(a => a.code !== exclude)
  const searching = isOpen && found?.q !== search

  // Enter while a search is out. The rows on screen answer an older query, and
  // ignoring the key reads as it not registering -- so it waits for the answer.
  useEffect(() => {
    if (searching || !pendingEnter.current) return
    pendingEnter.current = false
    if (results[0]) selectAirport(results[0])
    // selectAirport reads the current props; only the answer arriving matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searching, found])

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setIsOpen(false)
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  function selectAirport(airport: Airport) {
    setKnown(k => ({ ...k, [airport.code]: airport }))
    onChange(airport.code)
    setIsOpen(false)
    inputRef.current?.blur()
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (!isOpen) {
      if (e.key === 'ArrowDown' || e.key === 'Enter') { setQuery(selected ? airportLabel(selected) : ''); setIsOpen(true) }
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
      if (searching) pendingEnter.current = true
      else if (results[highlightedIndex]) selectAirport(results[highlightedIndex])
    } else if (e.key === 'Escape') {
      setIsOpen(false)
    }
  }

  const isInvalid = value !== '' && known[value] === null

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
        aria-controls={listId}
        autoComplete="off"
        value={shown}
        disabled={disabled}
        placeholder="City, airport, or code…"
        onFocus={() => {
          setQuery(selected ? airportLabel(selected) : '')
          setIsOpen(true)
          // Selecting all text on focus so typing immediately replaces the
          // current selection's label, rather than requiring a manual clear.
          // The text is the same label either side of this render.
          inputRef.current?.select()
        }}
        // Still focused after Escape: a click opens it again.
        onMouseDown={() => {
          if (!isOpen && document.activeElement === inputRef.current) {
            setQuery(selected ? airportLabel(selected) : '')
            setIsOpen(true)
          }
        }}
        onChange={e => {
          // Typing into the closed box (focused, showing the chosen airport)
          // starts a new search with what was typed.
          const v = e.target.value
          setQuery(!isOpen && shown && v.startsWith(shown) ? v.slice(shown.length) : v)
          setIsOpen(true)
          pendingEnter.current = false
          if (value) onChange('') // typing invalidates the previous selection until a new one is picked
        }}
        onKeyDown={handleKeyDown}
        style={inputStyle}
      />

      {isOpen && results.length > 0 && (
        <div id={listId} role="listbox" style={dropdownWrapStyle}>
          {results.map((a, i) => (
            <div
              key={a.code}
              role="option"
              aria-selected={i === highlightedIndex}
              // onMouseDown (not onClick) fires before the input's onBlur/
              // click-outside handler, so the pick registers before the
              // dropdown closes itself out from under the click.
              onMouseDown={e => { e.preventDefault(); selectAirport(a) }}
              onMouseEnter={() => setHighlightedIndex(i)}
              style={{ ...optionStyle, ...(i === highlightedIndex ? optionHighlightStyle : {}) }}
            >
              <span style={optionCityStyle}>{a.city}</span>
              <span style={optionCodeStyle}>{a.code}</span>
              <span style={optionNameStyle}>{a.name}{a.country_code !== 'IN' ? ` · ${a.country}` : ''}</span>
            </div>
          ))}
        </div>
      )}

      {isOpen && search !== '' && !searching && results.length === 0 && (
        <div style={dropdownWrapStyle}>
          <div style={emptyStyle}>No airports match &ldquo;{query}&rdquo;</div>
        </div>
      )}

      {isInvalid && !isOpen && (
        <p style={errorStyle}>Unrecognised airport &ldquo;{value}&rdquo;.</p>
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
