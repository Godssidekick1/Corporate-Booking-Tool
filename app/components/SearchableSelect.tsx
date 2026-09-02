'use client'

import { useEffect, useMemo, useRef, useState } from 'react'

// ── SearchableSelect ─────────────────────────────────────────────────────
// A generic typable combobox: type to filter, click or arrow+enter to pick.
// Same interaction pattern as AirportDropdown, but generic over any
// {id, label, sublabel?} option shape instead of the airport-specific data
// model — for client/employee/approver pickers across TMC settings pages.
// ─────────────────────────────────────────────────────────────────────────────

interface SearchableOption {
  id: string
  label: string
  sublabel?: string
}

interface SearchableSelectProps {
  value: string
  onChange: (id: string) => void
  options: SearchableOption[]
  placeholder?: string
  disabled?: boolean
  emptyMessage?: string
}

export default function SearchableSelect({
  value, onChange, options, placeholder = 'Search…', disabled, emptyMessage = 'No matches',
}: SearchableSelectProps) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [highlightIndex, setHighlightIndex] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)

  const selected = options.find(o => o.id === value) ?? null

  // When closed, the input shows the selected option's label. While open
  // and being typed into, it shows the raw query instead — otherwise every
  // keystroke would be fighting the selected-label display.
  const displayValue = open ? query : (selected?.label ?? '')

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return options
    return options.filter(o =>
      o.label.toLowerCase().includes(q) || (o.sublabel ?? '').toLowerCase().includes(q)
    )
  }, [options, query])

  useEffect(() => {
    setHighlightIndex(0)
  }, [query, open])

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false)
        setQuery('')
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  function pick(option: SearchableOption) {
    onChange(option.id)
    setQuery('')
    setOpen(false)
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'Enter') { setOpen(true); return }
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlightIndex(i => Math.min(i + 1, filtered.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlightIndex(i => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (filtered[highlightIndex]) pick(filtered[highlightIndex])
    } else if (e.key === 'Escape') {
      setOpen(false)
      setQuery('')
    }
  }

  return (
    <div ref={rootRef} style={s.root}>
      <input
        type="text"
        value={displayValue}
        placeholder={placeholder}
        disabled={disabled}
        onFocus={() => { setOpen(true); setQuery('') }}
        onChange={e => { setQuery(e.target.value); setOpen(true) }}
        onKeyDown={handleKeyDown}
        style={{ ...s.input, ...(disabled ? s.inputDisabled : {}) }}
      />
      {open && (
        <div style={s.dropdown}>
          {filtered.length === 0 ? (
            <div style={s.emptyRow}>{emptyMessage}</div>
          ) : (
            filtered.map((o, i) => (
              <div
                key={o.id}
                onMouseDown={e => { e.preventDefault(); pick(o) }}
                onMouseEnter={() => setHighlightIndex(i)}
                style={{ ...s.option, ...(i === highlightIndex ? s.optionHighlight : {}), ...(o.id === value ? s.optionSelected : {}) }}
              >
                <div style={s.optionLabel}>{o.label}</div>
                {o.sublabel && <div style={s.optionSublabel}>{o.sublabel}</div>}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  root: { position: 'relative', width: '100%' },
  input: {
    width: '100%', height: '38px', padding: '0 12px', fontSize: '13px', color: '#111827',
    background: '#fff', border: '1px solid #E5E7EB', borderRadius: '8px', outline: 'none', boxSizing: 'border-box' as const,
  },
  inputDisabled: { background: '#F3F4F6', color: '#9CA3AF', cursor: 'not-allowed' },
  dropdown: {
    position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 20,
    background: '#fff', border: '1px solid #E5E7EB', borderRadius: '10px',
    boxShadow: '0 8px 24px rgba(0,0,0,0.08)', maxHeight: '260px', overflowY: 'auto' as const, padding: '4px',
  },
  emptyRow: { padding: '10px 12px', fontSize: '12.5px', color: '#9CA3AF' },
  option: { padding: '8px 10px', borderRadius: '7px', cursor: 'pointer' },
  optionHighlight: { background: '#F3F4F6' },
  optionSelected: { background: '#EEF2FF' },
  optionLabel: { fontSize: '13px', color: '#111827', fontWeight: 500 },
  optionSublabel: { fontSize: '11px', color: '#9CA3AF', marginTop: '1px' },
}