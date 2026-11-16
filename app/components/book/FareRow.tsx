'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { VERDICT_META } from '@/app/lib/policy/verdictLabels'
import type { FareOption, FlatFlightResult, PenaltyLine } from '@/app/lib/book/types'
import css from './FareRow.module.css'

// ── FareRow ──────────────────────────────────────────────────────────────────
// A flight's fares in one row that scrolls sideways, wherever fares are shown:
// a results card, a round-trip column, both fare pages. Each card says what the
// company pays, the policy verdict, refundability with the cancellation fee,
// the change fee, baggage, meal and up to four of the airline's inclusions.
//
// Two ways to use it:
//   'select': one fare is chosen (a radio group: arrow keys move the choice).
//             The chosen card gets a filled band and a tick, and is scrolled
//             into view.
//   'choose': each card's button acts at once (the results list: choosing
//             opens the fare page).
// ◀ ▶ appear only when the row is wider than its box. A flight with one fare
// shows one card, no scroller.
// ─────────────────────────────────────────────────────────────────────────────

type Verdict = 'green' | 'amber' | 'red'

const inr = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`
export const fareAmountOf = (f: FareOption) => f.sellEstimate ?? f.totalFare
export const fareName = (f: FareOption, i: number) => f.brandedFareName || f.fareType || `Fare ${i + 1}`

// The adult's fee as the airline sends it ("INR3000", "0"); null when it sent
// nothing useful ("Not Available" means the rules were not returned).
function fee(lines: PenaltyLine[] | undefined): string | null {
  const line = lines?.find(l => l.paxType === 'ADT') ?? lines?.[0]
  const text = line?.text?.trim()
  if (!text || text.toLowerCase() === 'not available') return null
  const n = /^(?:INR\s*)?(\d+(?:\.\d+)?)$/i.exec(text)
  if (n) return Number(n[1]) === 0 ? 'free' : inr(Number(n[1]))
  return text
}

// The airline shouts its inclusions ("FREE CHECKED BAGGAGE"); only the case changes.
const sentence = (v: string) => v.charAt(0).toUpperCase() + v.slice(1).toLowerCase()

const Arrow = ({ dir }: { dir: -1 | 1 }) => (
  <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
    <path d={dir < 0 ? 'M7.5 2.5 4 6l3.5 3.5' : 'M4.5 2.5 8 6 4.5 9.5'} />
  </svg>
)
const Tick = () => (
  <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m2.5 6.2 2.3 2.3 4.7-5" />
  </svg>
)

export interface FareRowProps {
  flight: FlatFlightResult
  mode: 'select' | 'choose'
  onPick: (fare: FareOption, index: number) => void
  // 'select': the chosen fare's pricing key.
  selectedKey?: string | null
  // The verdict to show per fare, when the page knows better than search did
  // (the fare page judges each fare as priced). Default: the search's verdict.
  verdictOf?: (fare: FareOption, index: number) => Verdict | null | undefined
  // Meal included, per fare, when the page knows better (priced).
  mealOf?: (fare: FareOption, index: number) => boolean | undefined
  busy?: boolean
  // 'choose': the card being opened shows this on its button.
  busyKey?: string | null
  label?: string
  // The line above the row; default "N fares".
  caption?: string
}

export default function FareRow({
  flight, mode, onPick, selectedKey = null, verdictOf, mealOf, busy = false, busyKey = null, label = 'Fares', caption,
}: FareRowProps) {
  const track = useRef<HTMLDivElement>(null)
  const [edges, setEdges] = useState({ overflow: false, start: true, end: true })
  const fares = flight.fareOptions
  const single = fares.length === 1

  const measure = useCallback(() => {
    const el = track.current
    if (!el) return
    setEdges({
      overflow: el.scrollWidth > el.clientWidth + 4,
      start: el.scrollLeft < 4,
      end: el.scrollLeft + el.clientWidth >= el.scrollWidth - 4,
    })
  }, [])

  useEffect(() => {
    const el = track.current
    if (!el) return
    measure()
    el.addEventListener('scroll', measure, { passive: true })
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
    ro?.observe(el)
    return () => { el.removeEventListener('scroll', measure); ro?.disconnect() }
  }, [measure, fares.length])

  // The chosen card in view, inside the row only (never scrolling the page).
  useEffect(() => {
    const el = track.current
    if (!el || !selectedKey) return
    const card = el.querySelector<HTMLElement>(`[data-key="${CSS.escape(selectedKey)}"]`)
    if (!card) return
    const left = card.offsetLeft - el.offsetLeft
    if (left < el.scrollLeft || left + card.offsetWidth > el.scrollLeft + el.clientWidth) {
      el.scrollTo({ left: Math.max(0, left - 2) })
    }
  }, [selectedKey])

  const page = (dir: -1 | 1) => {
    const el = track.current
    if (el) el.scrollBy({ left: dir * Math.max(264, el.clientWidth - 80) })
  }

  // Arrow keys move the choice (a radio group's keyboard), and focus with it.
  function onKey(e: React.KeyboardEvent, i: number) {
    if (mode !== 'select' || busy) return
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
    if (!step) return
    e.preventDefault()
    const next = (i + step + fares.length) % fares.length
    onPick(fares[next], next)
    track.current?.querySelectorAll<HTMLElement>('[role="radio"]')[next]?.focus()
  }

  const chosenIndex = fares.findIndex(f => f.pricingKey === selectedKey)
  const bag = flight.checkInBaggageKg ? `${flight.checkInBaggageKg} kg check-in` : flight.checkInBaggagePieces ? `${flight.checkInBaggagePieces} check-in` : null
  const cabinBag = flight.cabinBaggageKg ? `${flight.cabinBaggageKg} kg cabin` : null

  return (
    <div className={css.row}>
      <div className={css.head}>
        <span>{caption ?? (single ? '1 fare' : `${fares.length} fares`)}</span>
        {edges.overflow && (
          <div className={css.arrows}>
            <button type="button" onClick={() => page(-1)} disabled={edges.start} aria-label="Earlier fares"><Arrow dir={-1} /></button>
            <button type="button" onClick={() => page(1)} disabled={edges.end} aria-label="More fares"><Arrow dir={1} /></button>
          </div>
        )}
      </div>
      <div ref={track} className={`${css.track} ${single ? css.single : ''}`}
        role={mode === 'select' ? 'radiogroup' : 'list'} aria-label={label}>
        {fares.map((fare, i) => {
          const chosen = mode === 'select' && fare.pricingKey === selectedKey
          const amount = fareAmountOf(fare)
          const name = fareName(fare, i)
          const cancel = fee(fare.cancelPenalties)
          const change = fee(fare.changePenalties)
          const v = verdictOf ? verdictOf(fare, i) : fare.policy
          const verdict = v ? VERDICT_META[v] : null
          const meal = mealOf?.(fare, i) ?? fare.mealIncluded
          const opening = busyKey !== null && busyKey === fare.pricingKey
          const body = (
            <>
              <div className={css.top}>
                <div className={css.name}>
                  <b title={name}>{name}</b>
                  {mode === 'select' && <span className={css.tick}><Tick /></span>}
                </div>
                <div className={css.amount}>{amount !== undefined ? inr(amount) : '—'}<small>you pay</small></div>
                {verdict && (
                  <span className={css.verdict} style={{ color: verdict.color, background: verdict.bg, borderColor: verdict.border }}>
                    <i />{verdict.label}
                  </span>
                )}
              </div>
              <ul className={css.lines}>
                <li className={fare.refundable ? '' : css.no}>
                  {fare.refundable ? `Refundable${cancel ? `, cancellation ${cancel}` : ''}` : 'Non-refundable'}
                </li>
                {change && <li>Change {change}</li>}
                {(bag || cabinBag) && <li>{[bag, cabinBag].filter(Boolean).join(', ')}</li>}
                <li className={meal ? '' : css.no}>{meal ? 'Meal included' : 'Meal not included'}</li>
                {(fare.brandedServices ?? []).slice(0, 4).map(sv => <li key={sv}>{sentence(sv)}</li>)}
              </ul>
            </>
          )

          if (mode === 'choose') {
            return (
              <div key={fare.pricingKey || i} data-key={fare.pricingKey} className={css.card} role="listitem">
                {body}
                <button type="button" className={css.action} disabled={busy} onClick={() => onPick(fare, i)}>
                  {opening ? 'Opening…' : 'Choose'}
                </button>
              </div>
            )
          }
          return (
            <div
              key={fare.pricingKey || i} data-key={fare.pricingKey}
              className={`${css.card} ${css.selectable} ${chosen ? css.chosen : ''}`}
              role="radio" aria-checked={chosen} aria-disabled={busy || undefined} aria-label={`${name}, ${amount !== undefined ? inr(amount) : 'no price'}`}
              // One stop in the tab order: the chosen card (or the first).
              tabIndex={chosen || (chosenIndex === -1 && i === 0) ? 0 : -1}
              onClick={() => { if (!busy && !chosen) onPick(fare, i) }}
              onKeyDown={e => {
                if ((e.key === ' ' || e.key === 'Enter') && !busy && !chosen) { e.preventDefault(); onPick(fare, i); return }
                onKey(e, i)
              }}
            >
              {body}
              <span className={css.action} aria-hidden="true">{chosen ? 'Chosen' : 'Choose this fare'}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
