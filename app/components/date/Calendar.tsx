'use client'

import { useEffect, useRef, useState } from 'react'
import {
  MONTH_NAMES, WEEKDAYS, addDays, addMonths, clampDay, formatMonth, monthGrid, monthKey, monthOf, parts,
  spokenDay, toIso, withinBounds, type Month,
} from '@/app/lib/dates/calendar'
import css from './Date.module.css'

// ── Calendar: one or two month grids ─────────────────────────────────────────
// Pure display plus keyboard: the parent owns what is picked. A range (depart
// and return) is drawn as a dashed route between its two ends, previewed as
// the pointer moves while the second end is being chosen.
//
// Keyboard (a grid, as WAI-ARIA describes): arrows move a day or a week,
// Page Up/Down a month, Home/End the start or end of the week, Enter or Space
// picks. Days outside min..max cannot be focused into picking.
// ─────────────────────────────────────────────────────────────────────────────

export interface CalendarProps {
  months: 1 | 2
  view: Month
  onView: (m: Month) => void
  // The day being chosen, and (for a range) both ends.
  value: string | null
  range?: { start: string | null; end: string | null; editing: 'start' | 'end' } | null
  labels?: { start: string; end: string }
  min?: string | null
  max?: string | null
  today: string
  onPick: (iso: string) => void
  // Month and year selects instead of arrows only: for dates years away (birth).
  yearNav?: boolean
  // Focus the grid on mount (the popover just opened).
  autoFocus?: boolean
}

export default function Calendar({ months, view, onView, value, range, labels, min, max, today, onPick, yearNav, autoFocus }: CalendarProps) {
  const [focusDay, setFocusDay] = useState(() => clampDay(value ?? range?.start ?? today, min, max))
  const [hover, setHover] = useState<string | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const moved = useRef(false)

  const minMonth = min ? monthOf(min) : null
  const maxMonth = max ? monthOf(max) : null
  const shown = Array.from({ length: months }, (_, i) => addMonths(view, i))
  const canBack = !minMonth || monthKey(view) > monthKey(minMonth)
  const canFwd = !maxMonth || monthKey(shown[shown.length - 1]) < monthKey(maxMonth)

  // Keyboard focus follows focusDay once the person starts using the keys.
  useEffect(() => {
    if (!moved.current && !autoFocus) return
    root.current?.querySelector<HTMLButtonElement>(`button[data-iso="${focusDay}"]`)?.focus()
  }, [focusDay, view, autoFocus])

  function moveFocus(next: string) {
    const day = clampDay(next, min, max)
    moved.current = true
    setFocusDay(day)
    const m = monthOf(day)
    if (monthKey(m) < monthKey(view)) onView(m)
    else if (monthKey(m) > monthKey(shown[shown.length - 1])) onView(addMonths(m, -(months - 1)))
  }

  function onKey(e: React.KeyboardEvent) {
    const { y, m, d } = parts(focusDay)
    const dow = new Date(Date.UTC(y, m, d)).getUTCDay()
    const map: Record<string, () => string> = {
      ArrowLeft: () => addDays(focusDay, -1),
      ArrowRight: () => addDays(focusDay, 1),
      ArrowUp: () => addDays(focusDay, -7),
      ArrowDown: () => addDays(focusDay, 7),
      Home: () => addDays(focusDay, -dow),
      End: () => addDays(focusDay, 6 - dow),
      PageUp: () => { const t = addMonths({ y, m }, -1); return toIso(t.y, t.m, Math.min(d, 28)) },
      PageDown: () => { const t = addMonths({ y, m }, 1); return toIso(t.y, t.m, Math.min(d, 28)) },
    }
    const go = map[e.key]
    if (!go) return
    e.preventDefault()
    moveFocus(go())
  }

  // The range to draw: while choosing the return, preview up to the pointer.
  const start = range?.start ?? null
  const end = range?.editing === 'end' && start && hover && hover >= start ? hover : (range?.end ?? null)

  const years: number[] = []
  if (yearNav) {
    const from = minMonth?.y ?? parts(today).y - 100
    const to = maxMonth?.y ?? parts(today).y + 20
    for (let y = to; y >= from; y--) years.push(y)
  }

  return (
    <div ref={root} className={css.months} onKeyDown={onKey} onMouseLeave={() => setHover(null)}>
      {shown.map((month, i) => (
        <div key={`${month.y}-${month.m}`} className={css.month}>
          <div className={css.head}>
            <button type="button" className={`${css.nav} ${i === 0 ? '' : css.navHidden}`} onClick={() => onView(addMonths(view, -1))}
              disabled={!canBack} aria-label="Previous month" tabIndex={i === 0 ? 0 : -1}>‹</button>
            {yearNav && i === 0 ? (
              <div className={css.selects}>
                <select className={css.select} aria-label="Month" value={month.m}
                  onChange={e => onView({ y: month.y, m: Number(e.target.value) })}>
                  {MONTH_NAMES.map((name, m) => <option key={name} value={m}>{name}</option>)}
                </select>
                <select className={css.select} aria-label="Year" value={month.y}
                  onChange={e => onView({ y: Number(e.target.value), m: month.m })}>
                  {years.map(y => <option key={y} value={y}>{y}</option>)}
                </select>
              </div>
            ) : (
              <span className={css.title} aria-live="polite">{formatMonth(month)}</span>
            )}
            <button type="button" className={`${css.nav} ${i === shown.length - 1 ? '' : css.navHidden}`} onClick={() => onView(addMonths(view, 1))}
              disabled={!canFwd} aria-label="Next month" tabIndex={i === shown.length - 1 ? 0 : -1}>›</button>
          </div>

          <div className={css.grid} role="grid" aria-label={formatMonth(month)}>
            {WEEKDAYS.map(w => <span key={w} className={css.dow} role="columnheader" aria-hidden>{w}</span>)}
            {monthGrid(month).flat().map((iso, k) => {
              if (!iso) return <span key={`pad-${k}`} className={css.cell} aria-hidden />
              const allowed = withinBounds(iso, min, max)
              const isStart = !!start && iso === start
              const isEnd = !!end && iso === end
              const picked = range ? (isStart || isEnd) : iso === value
              const between = !!start && !!end && iso > start && iso < end
              const cellCls = [css.cell, between ? css.inRange : '', isStart && end && end > start ? css.rangeStart : '', isEnd && start && end > start ? css.rangeEnd : ''].join(' ')
              const cap = range && labels ? (isStart ? labels.start : isEnd ? labels.end : null) : null
              return (
                <span key={iso} className={cellCls} role="gridcell" aria-selected={picked}>
                  <button type="button" data-iso={iso}
                    className={[css.day, picked ? css.selected : '', iso === today ? css.today : ''].join(' ')}
                    disabled={!allowed}
                    tabIndex={iso === focusDay ? 0 : -1}
                    aria-label={`${spokenDay(iso)}${iso === today ? ', today' : ''}${cap ? `, ${cap.toLowerCase()}` : ''}`}
                    aria-current={iso === today ? 'date' : undefined}
                    onMouseEnter={() => setHover(iso)}
                    onFocus={() => setFocusDay(iso)}
                    onClick={() => onPick(iso)}>
                    <span>{parts(iso).d}</span>
                    {cap && <span className={css.cap}>{cap}</span>}
                  </button>
                </span>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}
