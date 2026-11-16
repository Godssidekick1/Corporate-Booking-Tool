'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import AirportDropdown from '@/app/components/AirportDropdown'
import TravellersPopover, { useDismiss } from './TravellersPopover'
import {
  displayDate, isoDay, queryProblem, travellersText, type SearchQuery,
} from '@/app/lib/book/searchQuery'
import css from './SearchBar.module.css'

// ── The results page's edit bar ──────────────────────────────────────────────
// The search, editable where it stands: trip type, from, swap, to, depart,
// return (× makes it one way), travellers and class, Search. Changes are a
// draft until Search, which hands back the whole new search; the page runs it.
// Who is travelling and the trip's purpose are not here: they change the
// policy, the trip and the passenger form, so they are changed on the search
// page (the heading row's "Change").
// ─────────────────────────────────────────────────────────────────────────────

const plusDays = (iso: string, n: number) => isoDay(n, new Date(`${iso}T00:00:00`))

// The airport box inside a field: no border of its own, the field's type size.
const airportInput: React.CSSProperties = {
  border: 'none', background: 'transparent', outline: 'none', padding: 0, width: '100%', height: '21px',
  fontSize: '15px', fontWeight: 600, color: 'var(--color-ink)', textOverflow: 'ellipsis', fontFamily: 'inherit',
}

function DateField({ label, value, min, onChange, onClear }: {
  label: string
  value: string
  min: string
  onChange: (iso: string) => void
  onClear?: () => void
}) {
  return (
    <div className={`${css.field} ${onClear ? css.withClear : ''}`}>
      <span className={css.label}>{label}</span>
      <span className={css.value}>{displayDate(value)}</span>
      {/* Clicking anywhere on the field opens the calendar; typing works too. */}
      <input type="date" className={css.overlay} aria-label={label} value={value} min={min} required
        onClick={e => { try { e.currentTarget.showPicker?.() } catch { /* not allowed here: typing still works */ } }}
        onChange={e => { if (e.target.value) onChange(e.target.value) }} />
      {onClear && <button type="button" className={css.clear} onClick={onClear} aria-label={`Remove the ${label.toLowerCase()} date (one way)`} title="Make it one way">×</button>}
    </div>
  )
}

export default function SearchEditBar({ query, busy, onSearch }: {
  query: SearchQuery
  busy: boolean
  onSearch: (next: SearchQuery) => void
}) {
  const [draft, setDraft] = useState<SearchQuery>(query)
  const [problem, setProblem] = useState('')
  const [paxOpen, setPaxOpen] = useState(false)
  const paxRef = useRef<HTMLDivElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const closePax = useCallback(() => setPaxOpen(false), [])
  useDismiss(paxRef, paxOpen, closePax)

  // A search run from elsewhere (arrival, Back) resets the draft to it.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setDraft(query); setProblem('') }, [query])

  // The bar's height, for whatever sticks below it (the results' filters).
  useEffect(() => {
    const el = wrapRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const root = document.documentElement
    const ro = new ResizeObserver(() => root.style.setProperty('--book-bar-h', `${el.offsetHeight}px`))
    ro.observe(el)
    return () => { ro.disconnect(); root.style.removeProperty('--book-bar-h') }
  }, [])

  const set = (patch: Partial<SearchQuery>) => { setDraft(d => ({ ...d, ...patch })); setProblem('') }
  const today = isoDay()

  function submit(e: React.FormEvent) {
    e.preventDefault()
    setPaxOpen(false)
    const wrong = queryProblem(draft, today)
    if (wrong) { setProblem(wrong); return }
    onSearch(draft)
  }

  return (
    <div ref={wrapRef} className={css.wrap}>
      <form className={css.bar} onSubmit={submit} aria-label="Change the search">
        <label className={`${css.field} ${css.trip} ${css.tripCell}`}>
          <span className={css.label}>Trip</span>
          <select className={css.select} value={draft.returnDate ? 'return' : 'oneway'}
            onChange={e => set({ returnDate: e.target.value === 'return' ? plusDays(draft.departDate, 2) : null })}>
            <option value="oneway">One way</option>
            <option value="return">Round trip</option>
          </select>
        </label>

        <div className={css.field}>
          <span className={css.label}>From</span>
          <AirportDropdown value={draft.origin} onChange={origin => set({ origin })} exclude={draft.destination}
            dropdownStyle={airportInput} display="short" />
        </div>
        <button type="button" className={css.swap} aria-label="Swap origin and destination" title="Swap"
          onClick={() => set({ origin: draft.destination, destination: draft.origin })}>⇄</button>
        <div className={css.field}>
          <span className={css.label}>To</span>
          <AirportDropdown value={draft.destination} onChange={destination => set({ destination })} exclude={draft.origin}
            dropdownStyle={airportInput} display="short" />
        </div>

        <DateField label="Depart" value={draft.departDate} min={today}
          onChange={departDate => set({
            departDate,
            // A return before the new departure moves with it.
            returnDate: draft.returnDate && draft.returnDate < departDate ? departDate : draft.returnDate,
          })} />
        {draft.returnDate ? (
          <DateField label="Return" value={draft.returnDate} min={draft.departDate}
            onChange={returnDate => set({ returnDate })} onClear={() => set({ returnDate: null })} />
        ) : (
          <button type="button" className={css.field} onClick={() => set({ returnDate: plusDays(draft.departDate, 2) })}>
            <span className={css.label}>Return</span>
            <span className={`${css.value} ${css.valueMuted}`}>Add return</span>
          </button>
        )}

        <div ref={paxRef} className={`${css.paxCell}`} style={{ position: 'relative', display: 'grid' }}>
          <button type="button" className={css.field} aria-expanded={paxOpen} aria-haspopup="dialog" onClick={() => setPaxOpen(o => !o)}>
            <span className={css.label}>Travellers &amp; class</span>
            <span className={css.value}>{travellersText(draft)} · {draft.cabin}</span>
          </button>
          {paxOpen && (
            <TravellersPopover
              value={{ adult: draft.adult, child: draft.child, infant: draft.infant }}
              onChange={t => set(t)}
              cabin={draft.cabin} onCabin={cabin => set({ cabin })}
              onDone={closePax}
            />
          )}
        </div>

        <button type="submit" className={css.go} disabled={busy}>{busy ? 'Searching…' : 'Search'}</button>
      </form>
      {problem && <p className={css.problem} role="alert">{problem}</p>}
    </div>
  )
}
