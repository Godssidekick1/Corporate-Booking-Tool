'use client'

import { useEffect, useState } from 'react'
import css from './Takeoff.module.css'

// ── Loaders for the booking flow ─────────────────────────────────────────────
// A plane taking off, wherever the flow waits on the airline:
//   SearchLoader  the results page while a search runs (7-8 s is normal): the
//                 scene, what the search is doing step by step, and the shape
//                 of the results to come.
//   PageLoader    a page or panel loading: the scene, smaller, and a line.
//   TakeoffScene  the scene alone (the "please wait" overlay uses it).
// Our own drawing, inline SVG and CSS: nothing fetched. Reduced motion shows a
// still plane just after lift-off.
// ─────────────────────────────────────────────────────────────────────────────

export function TakeoffScene({ compact = false }: { compact?: boolean }) {
  return (
    <svg className={`${css.scene} ${compact ? css.compact : ''}`} viewBox="0 0 400 120" aria-hidden="true" focusable="false">
      <g className={css.cloud}><path d="M300 30a9 9 0 0 1 17-4 7 7 0 0 1 12 5h-29z" /></g>
      <g className={`${css.cloud} ${css.cloudSlow}`}><path d="M180 18a7 7 0 0 1 13-3 6 6 0 0 1 10 4h-23z" /></g>
      <line className={css.ground} x1="0" y1="98" x2="400" y2="98" />
      <line className={css.dash} x1="0" y1="106" x2="400" y2="106" />
      <ellipse className={css.shadow} cx="52" cy="99" rx="26" ry="2.5" />
      <g transform="translate(20 72)">
        <g className={css.plane}>
          {/* Tail fin, tailplane, fuselage, wing (side view, nose to the right). */}
          <path d="M4 10 9 10 13 1 8 1Z" />
          <path d="M2 13h9l-4 4.5H3Z" />
          <path d="M2 13c0-2 2-3 5-3h41c6 0 12 1.5 14 3-2 1.5-8 3-14 3H7c-3 0-5-1-5-3Z" />
          <path d="M24 14h11L22 23h-4Z" />
          <path className={css.window} d="M54 11.4l4 .9-.8.9-4-.4Z" />
          {[16, 21, 26, 31, 36, 41, 46].map(x => <circle key={x} className={css.window} cx={x} cy="12.4" r="0.9" />)}
          {/* Wheels, on the runway until lift-off. */}
          <circle cx="16" cy="18.5" r="1.8" />
          <circle cx="44" cy="18.5" r="1.8" />
        </g>
      </g>
    </svg>
  )
}

const Check = () => (
  <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m2.5 6.2 2.3 2.3 4.7-5" />
  </svg>
)

// What a search does, in order (app/api/book/search: the traveller's policy,
// the company's prices). Shown as it goes; the last step stays current until
// the answer arrives.
// Worded for whoever is booking: the desk and corporate admins book for others.
const STEPS = ['Checking the traveller’s policy', 'Working out what the company pays', 'Sorting the options']
const STEP_MS = 2200
const SLOW_MS = 14000

export function SearchLoader({ route, dates }: { route: string; dates: string }) {
  const steps = STEPS
  const [now, setNow] = useState(0)
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    const tick = setInterval(() => setNow(n => Math.min(n + 1, steps.length - 1)), STEP_MS)
    const late = setTimeout(() => setSlow(true), SLOW_MS)
    return () => { clearInterval(tick); clearTimeout(late) }
  }, [steps.length])

  return (
    <div className={css.search} role="status" aria-live="polite" aria-busy="true">
      <div className={css.searchCard}>
        <TakeoffScene />
        <p className={css.searchTitle}>Finding flights</p>
        <p className={css.searchRoute}>{route} · {dates}</p>
        <ol className={css.steps}>
          {steps.map((label, i) => (
            <li key={label} className={`${css.step} ${i < now ? css.stepDone : i === now ? css.stepNow : ''}`}
              aria-current={i === now ? 'step' : undefined}>
              <i><Check /></i>{label}
            </li>
          ))}
        </ol>
        {slow && <p className={css.slow}>The airlines are taking longer than usual. Still searching…</p>}
      </div>
      {[0, 1, 2].map(i => <div key={i} className={`skeleton ${css.ghost}`} style={{ opacity: 1 - i * 0.25 }} />)}
    </div>
  )
}

export function PageLoader({ label, note }: { label?: string; note?: string }) {
  return (
    <div className={css.page} role="status" aria-live="polite" aria-label={label ? undefined : 'Loading'}>
      <TakeoffScene compact />
      {label && <p className={css.pageLabel}>{label}</p>}
      {note && <p className={css.pageNote}>{note}</p>}
    </div>
  )
}
