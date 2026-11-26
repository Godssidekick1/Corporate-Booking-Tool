'use client'

import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type Ref } from 'react'
import { useDismiss } from '@/app/hooks/useDismiss'
import { addMonths, clampDay, formatDay, isIsoDay, monthKey, monthOf, todayIso, type Month } from '@/app/lib/dates/calendar'
import Calendar from './Calendar'
import css from './Date.module.css'

// ── DateInput: our own date field ────────────────────────────────────────────
// Replaces <input type="date"> everywhere (user, 2026-11-25: the browser's own
// looked different in every browser and could not show a trip's two dates
// together). Values are yyyy-mm-dd strings, exactly as before, so callers
// keep their state and validation.
//
// One field per date. A pair of fields that form a range (depart and return, a
// report's from and to) each pass `range`, so either calendar shows both ends
// and the route between them; the caller keeps them in order as it did.
//
// `renderTrigger` lets a page keep its own field look (the results page's edit
// bar); otherwise the trigger looks like the app's inputs.
// ─────────────────────────────────────────────────────────────────────────────

export interface DateInputHandle { open: () => void; close: () => void }

export interface DateInputProps {
  value: string | null | undefined
  onChange: (iso: string) => void
  min?: string | null
  max?: string | null
  placeholder?: string
  disabled?: boolean
  id?: string
  // What the date is ("Departure", "Date of birth"): the stub and screen readers say it.
  label?: string
  'aria-label'?: string
  months?: 1 | 2
  // Month and year selects, for dates years away (date of birth, passport expiry).
  yearNav?: boolean
  // This field is one end of a range.
  range?: { start: string | null | undefined; end: string | null | undefined; role: 'start' | 'end' }
  // Short captions on the two ends inside the calendar ("Dep", "Ret").
  rangeLabels?: { start: string; end: string }
  // Offer "Clear" (an optional date, or "make it one way").
  onClear?: () => void
  clearLabel?: string
  // Show the year always, or only when it is not this year (default).
  year?: 'auto' | 'always'
  style?: CSSProperties
  className?: string
  renderTrigger?: (p: { display: string; open: boolean; toggle: () => void; disabled: boolean }) => ReactNode
  handleRef?: Ref<DateInputHandle>
  // Called after a day is picked (and the calendar has closed): e.g. open the return next.
  onPicked?: (iso: string) => void
}

export default function DateInput(props: DateInputProps) {
  const {
    value, onChange, min, max, placeholder = 'Choose a date', disabled = false, id, label,
    months = 1, yearNav, range, rangeLabels, onClear, clearLabel = 'Clear', year = 'auto',
    style, className, renderTrigger, handleRef, onPicked,
  } = props
  const [open, setOpen] = useState(false)
  const [view, setView] = useState<Month>(() => monthOf(todayIso()))
  const popRef = useRef<HTMLDivElement>(null)
  const wrap = useRef<HTMLDivElement>(null)
  const today = todayIso()
  const current = isIsoDay(value) ? value : null

  // The month to open on: the date itself, else the range's other end, else
  // the nearest allowed month to today.
  const rangeStart = range?.start
  const startView = useCallback((): Month => {
    const anchor = current ?? (isIsoDay(rangeStart) ? rangeStart : null) ?? clampDay(today, min, max)
    let m = monthOf(anchor)
    // Two months shown: keep the last one inside max.
    if (months === 2 && max && monthKey(addMonths(m, 1)) > monthKey(monthOf(max))) m = addMonths(m, -1)
    return m
  }, [current, rangeStart, today, min, max, months])

  // Placed against the window (position: fixed), so a scrolling panel such as
  // a slide-over cannot clip it: below the field, or above when there is more
  // room there; right-aligned when it would run off the right edge. Phones get
  // the bottom sheet from the stylesheet instead.
  //
  // The page is zoomed to 90% on large screens (globals.css): a field's box is
  // measured in zoomed pixels but styles are set in unzoomed ones, so the
  // ratio between the two is measured and divided out.
  // Written straight onto the popover's style: positioning is the one job that
  // has to read the page and write to it, and state would re-render for it.
  const place = useCallback(() => {
    const el = wrap.current
    const pop = popRef.current
    if (!el || !pop) return
    const set = (c: Record<'position' | 'top' | 'bottom' | 'left' | 'right', string>) => Object.assign(pop.style, c)
    if (window.innerWidth <= 640) { set({ position: '', top: '', bottom: '', left: '', right: '' }); return }
    const r = el.getBoundingClientRect()
    const scale = el.offsetWidth ? r.width / el.offsetWidth : 1
    const vw = window.innerWidth / scale
    const vh = window.innerHeight / scale
    const top = r.top / scale, bottom = r.bottom / scale, left = r.left / scale, right = r.right / scale
    const width = months === 2 ? 650 : 330
    const height = 440
    const up = vh - bottom < height && top > vh - bottom
    const alignRight = left + width > vw - 12 && right - width > 12
    set({
      position: 'fixed',
      top: up ? 'auto' : `${bottom + 6}px`,
      bottom: up ? `${vh - top + 6}px` : 'auto',
      left: alignRight ? 'auto' : `${Math.max(12, left)}px`,
      right: alignRight ? `${Math.max(12, vw - right)}px` : 'auto',
    })
  }, [months])

  // Opening only sets state; the placement is measured as it opens, before the
  // browser paints (below), so nothing reads the page during render.
  const show = useCallback(() => {
    if (disabled) return
    setView(startView())
    setOpen(true)
  }, [disabled, startView])

  const close = useCallback(() => setOpen(false), [])
  useDismiss(wrap, open, close)

  useLayoutEffect(() => { if (open) place() }, [open, place])

  // Follow the field while the page (or a panel) scrolls.
  useEffect(() => {
    if (!open) return
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => { window.removeEventListener('scroll', place, true); window.removeEventListener('resize', place) }
  }, [open, place])
  useImperativeHandle(handleRef, () => ({ open: show, close }), [show, close])

  function pick(iso: string) {
    onChange(iso)
    setOpen(false)
    onPicked?.(iso)
  }

  const display = current ? formatDay(current, { year }) : ''
  const name = label ?? props['aria-label'] ?? 'Date'

  // The stub: what is picked, in words.
  const stubItems = range && rangeLabels
    ? [
        { label: rangeLabels.start, value: isIsoDay(range.start) ? formatDay(range.start, { year }) : null },
        { label: rangeLabels.end, value: isIsoDay(range.end) ? formatDay(range.end, { year }) : null },
      ]
    : [{ label: name, value: display || null }]

  return (
    <div ref={wrap} className={css.wrap}>
      {renderTrigger ? renderTrigger({ display, open, toggle: () => (open ? close() : show()), disabled }) : (
        <button type="button" id={id} className={`${css.trigger} ${className ?? ''}`} style={style} disabled={disabled}
          aria-haspopup="dialog" aria-expanded={open} aria-label={`${name}: ${display || 'not chosen'}`}
          onClick={() => (open ? close() : show())}>
          <span className={display ? undefined : css.placeholder}>{display || placeholder}</span>
          <CalendarIcon />
        </button>
      )}

      {open && (
        <>
          <div className={css.backdrop} onMouseDown={close} aria-hidden />
          {/* preventDefault: inside a <label>, a click on the calendar's text
              would otherwise "click" the label's control (the trigger) and
              close the calendar mid-pick. Buttons' own handlers still run. */}
          <div ref={popRef} className={css.pop}
            role="dialog" aria-label={`Choose ${name.toLowerCase()}`} onClick={e => e.preventDefault()}>
            <Calendar
              months={months}
              view={view}
              onView={setView}
              value={current}
              range={range ? {
                start: isIsoDay(range.start) ? range.start : null,
                end: isIsoDay(range.end) ? range.end : null,
                editing: range.role,
              } : null}
              labels={rangeLabels ? { start: rangeLabels.start.slice(0, 3), end: rangeLabels.end.slice(0, 3) } : undefined}
              min={min}
              max={max}
              today={today}
              onPick={pick}
              yearNav={yearNav}
              autoFocus
            />
            <div className={css.stub}>
              {stubItems.map((item, i) => (
                <span key={item.label} style={{ display: 'contents' }}>
                  {i > 0 && <span className={css.stubArrow} aria-hidden>→</span>}
                  <span className={css.stubItem}>
                    <span className={css.stubLabel}>{item.label}</span>
                    <span className={`${css.stubValue} ${item.value ? '' : css.stubMuted}`}>{item.value ?? 'Not chosen'}</span>
                  </span>
                </span>
              ))}
              <span className={css.stubActions}>
                {onClear && <button type="button" className={css.ghost} onClick={() => { onClear(); close() }}>{clearLabel}</button>}
                <button type="button" className={css.done} onClick={close}>Done</button>
              </span>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function CalendarIcon() {
  return (
    <svg className={css.icon} viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect x="2" y="3" width="12" height="11" rx="2" stroke="currentColor" strokeWidth="1.4" />
      <path d="M2 6.5h12M5.5 1.5v3M10.5 1.5v3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}
