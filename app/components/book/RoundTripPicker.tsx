'use client'

import { useState } from 'react'
import AirlineMark from '@/app/components/AirlineMark'
import FlightResults, { youPay } from '@/app/components/book/FlightResults'
import { VERDICT_META } from '@/app/lib/policy/verdictLabels'
import { journeysOf, type FareOption, type FlatFlightResult } from '@/app/lib/book/types'
import type { RoundTripPair, SplitResults } from '@/app/lib/book/flowStorage'
import css from './RoundTripPicker.module.css'

// ── RoundTripPicker ──────────────────────────────────────────────────────────
// A domestic round trip: the onward and the return as two columns of one-way
// flights, one picked from each, adding up in the bar below. Each pick is
// priced and booked on its own (two linked bookings, one checkout).
//
// The airlines' special return fares (one price for both flights, one
// booking: the RTF search) are offered above the columns when there are any,
// and named in the bar when the two picks also come as one. Opening them shows
// the usual results list, each card both flights at one price.
// ─────────────────────────────────────────────────────────────────────────────

const inr = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`
const clock = (iso?: string) => /T(\d{2}:\d{2})/.exec(iso ?? '')?.[1] ?? '—'
const dayOf = (iso?: string) => /^(\d{4}-\d{2}-\d{2})/.exec(iso ?? '')?.[1] ?? ''
const hourOf = (iso?: string) => Number(/T(\d{2})/.exec(iso ?? '')?.[1] ?? NaN)
function minutes(d?: string) { const m = /^(\d+):(\d{2})/.exec(d ?? ''); return m ? Number(m[1]) * 60 + Number(m[2]) : 0 }
const hm = (mins: number) => `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`
const airlineOf = (f: FlatFlightResult) => (f.airline?.code ?? f.legs?.[0]?.airlineCode ?? '').toUpperCase()
const amountOf = (o: FareOption) => o.sellEstimate ?? o.totalFare ?? Infinity
// The fare a pick starts with: the cheapest. Another fare can be chosen on the
// next page.
const cheapestFare = (f: FlatFlightResult) => f.fareOptions.reduce((a, b) => (amountOf(b) < amountOf(a) ? b : a), f.fareOptions[0])
// The flight numbers of one direction, to match a pick to a return fare.
const numbersOf = (legs: { airlineCode?: string; flightNumber?: string }[] | undefined) =>
  (legs ?? []).map(l => `${l.airlineCode ?? ''}${l.flightNumber ?? ''}`).join('|')

type SortKey = 'cheapest' | 'earliest' | 'fastest'
type Quick = 'nonstop' | 'morning' | 'evening' | 'refundable' | 'within'
const QUICK: { key: Quick; label: string; test: (f: FlatFlightResult) => boolean }[] = [
  { key: 'nonstop', label: 'Non-stop', test: f => (journeysOf(f)[0]?.stopCount ?? 0) === 0 },
  { key: 'morning', label: 'Morning', test: f => { const h = hourOf(journeysOf(f)[0]?.origin?.dateTime); return h >= 6 && h < 12 } },
  { key: 'evening', label: 'Evening', test: f => hourOf(journeysOf(f)[0]?.origin?.dateTime) >= 18 },
  { key: 'refundable', label: 'Refundable', test: f => f.fareOptions.some(o => o.refundable) },
  { key: 'within', label: 'Within policy', test: f => f.fareOptions.some(o => o.policy === 'green') },
]

function Column({ title, list, selected, onPick }: {
  title: string
  list: FlatFlightResult[]
  selected: string | null
  // null: the pick taken back (clicking the chosen row again, or its × below).
  onPick: (f: FlatFlightResult | null) => void
}) {
  const [sort, setSort] = useState<SortKey>('cheapest')
  const [quick, setQuick] = useState<Set<Quick>>(new Set())
  const first = list[0] ? journeysOf(list[0])[0] : undefined
  const route = first ? `${first.origin?.code} → ${first.destination?.code}` : ''
  const date = first?.origin?.dateTime
    ? new Date(`${dayOf(first.origin.dateTime)}T00:00:00`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })
    : ''
  const judged = list.some(f => f.fareOptions.some(o => o.policy))

  const rows = list
    .filter(f => [...quick].every(k => QUICK.find(q => q.key === k)!.test(f)))
    .sort((a, b) => {
      if (sort === 'cheapest') return (youPay(a) ?? Infinity) - (youPay(b) ?? Infinity)
      const ja = journeysOf(a)[0], jb = journeysOf(b)[0]
      if (sort === 'fastest') return minutes(ja?.totalDuration ?? ja?.duration) - minutes(jb?.totalDuration ?? jb?.duration)
      return (ja?.origin?.dateTime ?? '').localeCompare(jb?.origin?.dateTime ?? '')
    })

  function flip(k: Quick) {
    const next = new Set(quick)
    if (next.has(k)) next.delete(k)
    else next.add(k)
    setQuick(next)
  }

  return (
    <section className={css.col} aria-label={`${title} flights`}>
      <div className={css.colHead}>
        <div className={css.colTitle}><b>{title} · {route}</b><span>{date}{date ? ' · ' : ''}{list.length} flight{list.length === 1 ? '' : 's'}</span></div>
        <div className={css.ctrl}>
          <select value={sort} onChange={e => setSort(e.target.value as SortKey)} aria-label={`Sort ${title.toLowerCase()} flights`}>
            <option value="cheapest">Cheapest first</option>
            <option value="earliest">Earliest first</option>
            <option value="fastest">Fastest first</option>
          </select>
          {QUICK.filter(q => q.key !== 'within' || judged).map(q => (
            <button key={q.key} type="button" className={css.chip} aria-pressed={quick.has(q.key)} onClick={() => flip(q.key)}>{q.label}</button>
          ))}
        </div>
      </div>
      <div className={css.rows} role="radiogroup" aria-label={`${title} flights`}>
        {rows.length === 0 ? (
          <div className={css.empty}>{list.length === 0 ? 'No flights found for this direction.' : 'No flights match. Clear a filter.'}</div>
        ) : rows.map(f => {
          const j = journeysOf(f)[0]
          const fare = cheapestFare(f)
          const verdict = fare?.policy
          const nextDay = dayOf(j?.destination?.dateTime) > dayOf(j?.origin?.dateTime)
          const stops = j?.stopCount ?? 0
          const isSel = selected === f.flightKey
          const numbers = [...new Set((f.legs ?? []).map(l => `${l.airlineCode ?? ''} ${l.flightNumber ?? ''}`.trim()))].join(' · ')
          return (
            <label key={f.flightKey} className={`${css.row} ${isSel ? css.rowSelected : ''}`}>
              {/* A radio cannot be unchecked by clicking it, so a click on the
                  chosen row takes the pick back (the label forwards its click). */}
              <input type="radio" name={`pick-${title}`} checked={isSel} onChange={() => onPick(f)}
                onClick={() => { if (isSel) onPick(null) }} />
              <AirlineMark code={airlineOf(f)} name={f.airline?.name} size={26} />
              <span className={css.times}>
                <b>{clock(j?.origin?.dateTime)} → {clock(j?.destination?.dateTime)}{nextDay && <sup>+1</sup>}</b>
                <span>{f.airline?.name ?? airlineOf(f)} {numbers} · {hm(minutes(j?.totalDuration ?? j?.duration))} · {stops === 0 ? 'Non-stop' : `${stops} stop${stops > 1 ? 's' : ''}`}</span>
              </span>
              <span className={css.rowPrice}>
                <b>{inr(amountOf(fare))}</b>
                {verdict && (
                  <small><span className={css.dot} style={{ background: VERDICT_META[verdict].color }} />{VERDICT_META[verdict].label}</small>
                )}
              </span>
            </label>
          )
        })}
      </div>
    </section>
  )
}

export interface RoundTripPickerProps {
  split: SplitResults
  // The two picks: the page goes on to price both.
  onContinue: (pair: RoundTripPair) => void
  // A special return fare chosen: booked as one, like any combined result.
  onChooseSpecial: (flight: FlatFlightResult, fare: FareOption) => void
  navigatingKey: string | null
}

export default function RoundTripPicker({ split, onContinue, onChooseSpecial, navigatingKey }: RoundTripPickerProps) {
  const onward = split.onward?.results ?? []
  const back = split.return?.results ?? []
  const special = split.specialReturn?.results ?? []
  const [onPick, setOnPick] = useState<FlatFlightResult | null>(null)
  const [retPick, setRetPick] = useState<FlatFlightResult | null>(null)
  const [showSpecial, setShowSpecial] = useState(false)

  // The return fare that is these exact two flights, if the airline sells one.
  const matching = onPick && retPick ? special.find(s => {
    const [jo, jr] = journeysOf(s)
    return jo && jr && numbersOf(jo.legs) === numbersOf(journeysOf(onPick)[0]?.legs) && numbersOf(jr.legs) === numbersOf(journeysOf(retPick)[0]?.legs)
  }) : undefined
  const total = onPick && retPick ? amountOf(cheapestFare(onPick)) + amountOf(cheapestFare(retPick)) : null
  const matchingPrice = matching ? youPay(matching) : undefined

  // The offer: the cheapest return fare, against the cheapest separate picks
  // on the same airline. Shown only when it is actually cheaper.
  const bestSpecial = special.reduce<FlatFlightResult | null>((m, s) => (m === null || (youPay(s) ?? Infinity) < (youPay(m) ?? Infinity) ? s : m), null)
  const offerAirline = bestSpecial ? airlineOf(bestSpecial) : ''
  const cheapestOn = (list: FlatFlightResult[]) => Math.min(...list.filter(f => airlineOf(f) === offerAirline).map(f => youPay(f) ?? Infinity))
  const separate = bestSpecial ? cheapestOn(onward) + cheapestOn(back) : Infinity
  const bestPrice = bestSpecial ? youPay(bestSpecial) ?? Infinity : Infinity
  const offerSaves = Number.isFinite(separate) && bestPrice < separate ? separate - bestPrice : 0

  if (showSpecial) {
    return (
      <div className={css.wrap}>
        <div className={css.specialHead}>
          <div>
            <h2>Return fares</h2>
            <p>One price for both flights, booked as one. It changes and cancels as a pair.</p>
          </div>
          <button type="button" className={css.ghostBtn} onClick={() => setShowSpecial(false)}>Back to picking separately</button>
        </div>
        <FlightResults
          results={special}
          hiddenByPolicy={split.specialReturn?.hiddenByPolicy ?? []}
          onChoose={onChooseSpecial}
          navigatingKey={navigatingKey}
        />
      </div>
    )
  }

  const pickLine = (label: string, f: FlatFlightResult | null, clear: () => void) => {
    if (!f) return <div className={`${css.pick} ${css.pickEmpty}`}><div><small>{label}</small><b>Pick a flight</b></div></div>
    const j = journeysOf(f)[0]
    return (
      <div className={css.pick}>
        <AirlineMark code={airlineOf(f)} name={f.airline?.name} size={26} />
        <div>
          <small>{label}</small>
          <b>{f.airline?.name ?? airlineOf(f)} {f.legs?.[0]?.flightNumber ?? ''}</b>
          <span>{clock(j?.origin?.dateTime)} → {clock(j?.destination?.dateTime)} · {inr(amountOf(cheapestFare(f)))}</span>
        </div>
        <button type="button" className={css.clearPick} onClick={clear} aria-label={`Remove the ${label.toLowerCase()} flight`} title="Remove">×</button>
      </div>
    )
  }

  return (
    <div className={css.wrap}>
      {split.notes.length > 0 && (
        <div className={css.notes} role="status">{split.notes.map(n => <p key={n}>{n}</p>)}</div>
      )}

      {special.length > 0 && bestSpecial && (
        <div className={css.offer}>
          <AirlineMark code={offerAirline} name={bestSpecial.airline?.name} />
          <div className={css.offerText}>
            <b>{bestSpecial.airline?.name ?? offerAirline} return fare from {inr(bestPrice)} for both flights</b>
            <small>
              {offerSaves > 0
                ? `${inr(offerSaves)} less than picking the same airline's flights separately. One fare, one booking; it changes and cancels as a pair.`
                : 'One fare, one booking; it changes and cancels as a pair.'}
            </small>
          </div>
          <button type="button" className={css.ghostBtn} onClick={() => setShowSpecial(true)}>
            See {special.length} return fare{special.length === 1 ? '' : 's'}
          </button>
        </div>
      )}

      <div className={css.cols}>
        <Column title="Onward" list={onward} selected={onPick?.flightKey ?? null} onPick={setOnPick} />
        <Column title="Return" list={back} selected={retPick?.flightKey ?? null} onPick={setRetPick} />
      </div>

      <div className={css.bar}>
        {pickLine('Onward', onPick, () => setOnPick(null))}
        {pickLine('Return', retPick, () => setRetPick(null))}
        <div className={css.total}>
          <div><small>Total, 2 bookings</small><b>{total !== null ? inr(total) : '—'}</b></div>
          <button
            type="button" className={css.continueBtn} disabled={!onPick || !retPick || navigatingKey !== null}
            onClick={() => onPick && retPick && onContinue({
              onward: { flightKey: onPick.flightKey, pricingKey: cheapestFare(onPick).pricingKey },
              return: { flightKey: retPick.flightKey, pricingKey: cheapestFare(retPick).pricingKey },
            })}
          >
            {navigatingKey ? 'Opening…' : 'Continue'}
          </button>
        </div>
        {matching && matchingPrice !== undefined && total !== null && matchingPrice < total && (
          <div className={css.hint}>
            These two flights also come as a {matching.airline?.name ?? airlineOf(matching)} return fare for {inr(matchingPrice)}, saving {inr(total - matchingPrice)}.{' '}
            <button type="button" onClick={() => onChooseSpecial(matching, cheapestFare(matching))}>Use the return fare</button>
          </div>
        )}
        <p className={css.barNote}>Each flight is priced and booked on its own: passenger details once, one approval for both, and either can be cancelled alone.</p>
      </div>
    </div>
  )
}
