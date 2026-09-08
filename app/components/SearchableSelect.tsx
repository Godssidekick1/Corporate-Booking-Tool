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
  // ── Server-backed mode ────────────────────────────────────────────────────
  // Supplying onSearch switches this from "filter the array I gave you" to
  // "ask the server". Needed anywhere the option list is unbounded: a picker
  // over 2,000 travellers should not download 2,000 travellers.
  //
  // When present, local filtering is skipped entirely — the caller's options
  // ARE the result, and filtering them again would hide rows the server chose
  // to return.
  onSearch?: (query: string) => void
  loading?: boolean
  // The label for `value`, supplied by the caller.
  //
  // Not optional in server mode, and the reason is easy to miss: after a search
  // the selected option usually is not in `options` any more, so deriving the
  // label from the list blanks the field the moment somebody types. The caller
  // knows what it selected; this is it telling us.
  selectedLabel?: string
  // Commit whatever was typed even when it matches nothing.
  //
  // For fields where the option list is a SUGGESTION rather than the set of
  // legal values — a city, say. Our list of Indian cities is ours, not the
  // world's, and a branch in a town we have not heard of still has to be
  // recordable. Off by default: for a client or a bucket, a value that is not
  // an option is simply wrong.
  allowFreeText?: boolean
  // Offer an explicit "none" row at the top of the list.
  //
  // A <select> gets this for free — you add an <option value="">. A combobox
  // does not: clearing the text just leaves an empty query, and there is no
  // gesture that means "go back to unset". Without it, assigning a client group
  // by accident would be permanent, which is the sort of one-way door a picker
  // should never be.
  allowClear?: boolean
  clearLabel?: string
}

const CLEAR_ID = '__clear__'

export default function SearchableSelect({
  value, onChange, options, placeholder = 'Search…', disabled, emptyMessage = 'No matches',
  onSearch, loading = false, selectedLabel, allowFreeText = false,
  allowClear = false, clearLabel = 'None',
}: SearchableSelectProps) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [highlightIndex, setHighlightIndex] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)

  const selected = options.find(o => o.id === value) ?? null

  // When closed, the input shows the selected option's label. While open
  // and being typed into, it shows the raw query instead — otherwise every
  // keystroke would be fighting the selected-label display.
  //
  // selectedLabel wins over the list lookup because in server mode the selected
  // row is usually absent from the current results.
  const displayValue = open ? query : (selected?.label ?? selectedLabel ?? '')

  const filtered = useMemo(() => {
    // Server mode: the options ARE the answer. Filtering them again would drop
    // rows the server matched on a field this component cannot see, such as an
    // employee's email or a client's code.
    if (onSearch) return options

    const q = query.trim().toLowerCase()
    if (!q) return options
    return options.filter(o =>
      o.label.toLowerCase().includes(q) || (o.sublabel ?? '').toLowerCase().includes(q)
    )
  }, [options, query, onSearch])

  // The clear row is part of the visible list, not a decoration beside it: it
  // has to be arrow-navigable and Enter-selectable like any other row, and it
  // has to shift the highlight indices to match. Only offered when there is
  // something to clear — "Unassigned" on an already-unassigned field is noise.
  const rows = useMemo(
    () => (allowClear && value ? [{ id: CLEAR_ID, label: clearLabel }, ...filtered] : filtered),
    [allowClear, value, clearLabel, filtered]
  )

  // Debounced here rather than in every caller, so a picker is one prop to wire
  // up instead of a timer each screen has to remember to clear.
  useEffect(() => {
    if (!onSearch) return
    const t = setTimeout(() => onSearch(query), 220)
    return () => clearTimeout(t)
  }, [query, onSearch])

  useEffect(() => {
    // Reset the keyboard cursor whenever the visible list changes, or arrowing
    // down would start from a position that no longer points at anything.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHighlightIndex(0)
  }, [query, open])

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        // Clicking away commits typed text in free-text mode. Without this the
        // most natural thing a user can do — type a city, click the next field —
        // would silently discard what they typed.
        commitFreeText()
        setOpen(false)
        setQuery('')
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
    // commitFreeText closes over the current query, which is what it needs to
    // read at click time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allowFreeText, query, value])

  function pick(option: SearchableOption) {
    // The clear row is a sentinel, not a real id — it maps back to the empty
    // string the rest of the app already uses for "not set".
    onChange(option.id === CLEAR_ID ? '' : option.id)
    setQuery('')
    setOpen(false)
  }

  // Only fires when free text is allowed, something was typed, and it is not
  // already the value — so a plain open-and-close never rewrites the field.
  function commitFreeText() {
    if (!allowFreeText) return
    const typed = query.trim()
    if (typed && typed !== value) onChange(typed)
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'Enter') { setOpen(true); return }
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlightIndex(i => Math.min(i + 1, rows.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlightIndex(i => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      // A highlighted suggestion always wins over the raw text — otherwise
      // typing "Mumb" and pressing Enter would store "Mumb" rather than the
      // Mumbai sitting highlighted in front of them.
      if (rows[highlightIndex]) pick(rows[highlightIndex])
      else if (allowFreeText) {
        commitFreeText()
        setQuery('')
        setOpen(false)
      }
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
          {/* "No matches" during a fetch is a lie — the server has not answered
              yet. Checked before the empty case for exactly that reason. */}
          {loading ? (
            <div style={s.emptyRow}>Searching…</div>
          ) : rows.length === 0 ? (
            <div style={s.emptyRow}>{emptyMessage}</div>
          ) : (
            rows.map((o, i) => (
              <div
                key={o.id}
                onMouseDown={e => { e.preventDefault(); pick(o) }}
                onMouseEnter={() => setHighlightIndex(i)}
                style={{ ...s.option, ...(i === highlightIndex ? s.optionHighlight : {}), ...(o.id === value ? s.optionSelected : {}) }}
              >
                <div style={{ ...s.optionLabel, ...(o.id === CLEAR_ID ? s.clearLabel : {}) }}>{o.label}</div>
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
  clearLabel: { color: '#9CA3AF', fontWeight: 400, fontStyle: 'italic' as const },
  optionSublabel: { fontSize: '11px', color: '#9CA3AF', marginTop: '1px' },
}