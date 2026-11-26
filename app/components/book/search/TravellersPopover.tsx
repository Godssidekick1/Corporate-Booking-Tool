'use client'

import { CABINS, type Cabin } from '@/app/lib/book/searchQuery'
import css from './SearchBar.module.css'

// ── Travellers (and class), in a popover ─────────────────────────────────────
// The search form and the results page's edit bar both open this. The counts
// are capped at 9 in all; an infant needs an adult (said here, refused at
// search). Class is offered when the caller passes it (the edit bar: one
// field for both); the search form keeps its own Cabin select.
// ─────────────────────────────────────────────────────────────────────────────

export interface Travellers { adult: number; child: number; infant: number }

const ROWS = [
  { key: 'adult', label: 'Adults', sub: '12+ years', min: 1 },
  { key: 'child', label: 'Children', sub: '2–11 years', min: 0 },
  { key: 'infant', label: 'Infants', sub: 'Under 2 years', min: 0 },
] as const

// Closes on a press outside the box, or Escape (now shared: app/hooks/useDismiss.ts).
export { useDismiss } from '@/app/hooks/useDismiss'

export default function TravellersPopover({ value, onChange, cabin, onCabin, onDone }: {
  value: Travellers
  onChange: (next: Travellers) => void
  cabin?: Cabin
  onCabin?: (cabin: Cabin) => void
  onDone: () => void
}) {
  const total = value.adult + value.child + value.infant
  return (
    <div className={css.pop} role="dialog" aria-label={onCabin ? 'Travellers and class' : 'Travellers'}>
      {ROWS.map(row => (
        <div key={row.key} className={css.popRow}>
          <div><b>{row.label}</b><small>{row.sub}</small></div>
          <div className={css.stepper}>
            <button type="button" aria-label={`Fewer ${row.label.toLowerCase()}`} disabled={value[row.key] <= row.min}
              onClick={() => onChange({ ...value, [row.key]: Math.max(row.min, value[row.key] - 1) })}>−</button>
            <b aria-live="polite">{value[row.key]}</b>
            <button type="button" aria-label={`More ${row.label.toLowerCase()}`} disabled={total >= 9}
              onClick={() => onChange({ ...value, [row.key]: value[row.key] + 1 })}>+</button>
          </div>
        </div>
      ))}
      {value.infant > value.adult && <p className={css.popWarn}>Each infant must travel with an adult.</p>}
      {onCabin && (
        <div className={css.cabins} role="radiogroup" aria-label="Class">
          {CABINS.map(c => (
            <button key={c} type="button" role="radio" aria-checked={cabin === c} onClick={() => onCabin(c)}>{c}</button>
          ))}
        </div>
      )}
      <button type="button" className={css.popDone} onClick={onDone}>Done</button>
    </div>
  )
}
