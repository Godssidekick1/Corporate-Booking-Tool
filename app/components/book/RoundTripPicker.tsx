'use client'

import { useState } from 'react'
import AirlineMark from '@/app/components/AirlineMark'
import FlightResults from '@/app/components/book/FlightResults'
import FilterPanel from '@/app/components/book/FilterPanel'
import { activeCount, applyFilters, defaultFare, emptyFilters, flip, youPay, type Filters } from '@/app/lib/book/resultFilters'
import rcss from './FlightResults.module.css'
import { VERDICT_META } from '@/app/lib/policy/verdictLabels'
import { journeysOf, type FareOption, type FlatFlightResult } from '@/app/lib/book/types'
import type { RoundTripPair, SplitResults } from '@/app/lib/book/flowStorage'
import css from './RoundTripPicker.module.css'

// ── RoundTripPicker ──────────────────────────────────────────────────────────
// A domestic round trip: the onward and the return as two columns of one-way
// flights, one picked from each, adding up in the bar below. Each pick is
// priced and booked on its own (two linked bookings, one checkout).
//
// The filters on the left are the one-way list's (FilterPanel): stops,
// airlines, price per flight, refundable and within policy apply to both
// columns; each column has its own departure and arrival times.
//
// The airlines' special return fares (one price for both flights, one
// booking: the RTF search) are offered above the columns when there are any,
// and named in the bar when the two picks also come as one. Opening them shows
// the usual results list, each card both flights at one price.
// ─────────────────────────────────────────────────────────────────────────────

const inr = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`
const clock = (iso?: string) => /T(\d{2}:\d{2})/.exec(iso ?? '')?.[1] ?? '—'
const dayOf = (iso?: string) => /^(\d{4}-\d{2}-\d{2})/.exec(iso ?? '')?.[1] ?? ''
function minutes(d?: string) { const m = /^(\d+):(\d{2})/.exec(d ?? ''); return m ? Number(m[1]) * 60 + Number(m[2]) : 0 }
const hm = (mins: number) => `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`
const airlineOf = (f: FlatFlightResult) => (f.airline?.code ?? f.legs?.[0]?.airlineCode ?? '').toUpperCase()
const amountOf = (o: FareOption) => o.sellEstimate ?? o.totalFare ?? Infinity
// The fare a pick starts with: the cheapest within policy, else the cheapest.
// Fares are chosen on the round trip's fare page.
const startFare = (f: FlatFlightResult) => defaultFare(f) ?? f.fareOptions[0]
// The flight numbers of one direction, to match a pick to a return fare.
const numbersOf = (legs: { airlineCode?: string; flightNumber?: string }[] | undefined) =>
  (legs ?? []).map(l => `${l.airlineCode ?? ''}${l.flightNumber ?? ''}`).join('|')

type SortKey = 'cheapest' | 'earliest' | 'fastest'

// A pick: the flight, and which of its fares (startFare until another is chosen).
interface Pick { flight: FlatFlightResult; pricingKey: string }

function Column({ title, list, visible, onClear, selected, onPick }: {
  title: string
  list: FlatFlightResult[]
  // The flights the filters leave.
  visible: FlatFlightResult[]
  onClear: () => void
  selected: Pick | null
  // null: the pick taken back (clicking the chosen row again, or its × below).
  onPick: (pick: Pick | null) => void
}) {
  const [sort, setSort] = useState<SortKey>('cheapest')
  const first = list[0] ? journeysOf(list[0])[0] : undefined
  const route = first ? `${first.origin?.code} → ${first.destination?.code}` : ''
  const date = first?.origin?.dateTime
    ? new Date(`${dayOf(first.origin.dateTime)}T00:00:00`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })
    : ''
  const rows = [...visible]
    .sort((a, b) => {
      if (sort === 'cheapest') return (youPay(a) ?? Infinity) - (youPay(b) ?? Infinity)
      const ja = journeysOf(a)[0], jb = journeysOf(b)[0]
      if (sort === 'fastest') return minutes(ja?.totalDuration ?? ja?.duration) - minutes(jb?.totalDuration ?? jb?.duration)
      return (ja?.origin?.dateTime ?? '').localeCompare(jb?.origin?.dateTime ?? '')
    })

  return (
    <section className={css.col} aria-label={`${title} flights`}>
      <div className={css.colHead}>
        <div className={css.colTitle}>
          <b>{title} · {route}</b>
          <span>{date}{date ? ' · ' : ''}{visible.length === list.length ? list.length : `${visible.length} of ${list.length}`} flight{list.length === 1 ? '' : 's'}</span>
        </div>
        <select className={css.sort} value={sort} onChange={e => setSort(e.target.value as SortKey)} aria-label={`Sort ${title.toLowerCase()} flights`}>
          <option value="cheapest">Cheapest first</option>
          <option value="earliest">Earliest first</option>
          <option value="fastest">Fastest first</option>
        </select>
      </div>
      <div className={css.rows} role="radiogroup" aria-label={`${title} flights`}>
        {rows.length === 0 ? (
          <div className={css.empty}>
            {list.length === 0 ? 'No flights found for this direction.' : (
              <>No {title.toLowerCase()} flights match these filters. <button type="button" className={css.linkBtn} onClick={onClear}>Clear all</button></>
            )}
          </div>
        ) : rows.map(f => {
          const j = journeysOf(f)[0]
          const isSel = selected?.flight.flightKey === f.flightKey
          // The chosen fare when this flight is picked, else the one it starts with.
          const fare = (isSel && f.fareOptions.find(o => o.pricingKey === selected?.pricingKey)) || startFare(f)
          const verdict = fare?.policy
          const nextDay = dayOf(j?.destination?.dateTime) > dayOf(j?.origin?.dateTime)
          const stops = j?.stopCount ?? 0
          const numbers = [...new Set((f.legs ?? []).map(l => `${l.airlineCode ?? ''} ${l.flightNumber ?? ''}`.trim()))].join(' · ')
          return (
            <label key={f.flightKey} className={`${css.row} ${isSel ? css.rowSelected : ''}`}>
              {/* A radio cannot be unchecked by clicking it, so a click on the
                  chosen row takes the pick back (the label forwards its click). */}
              <input type="radio" name={`pick-${title}`} checked={isSel}
                onChange={() => onPick({ flight: f, pricingKey: startFare(f).pricingKey })}
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
                {/* How many to choose from on the fare page. */}
                <span className={css.fareCount}>{f.fareOptions.length} fare{f.fareOptions.length === 1 ? '' : 's'}</span>
              </span>
            </label>
          )
        })}
      </div>
    </section>
  )
}

// Each airline flying both ways: its cheapest onward plus its cheapest return.
// A click filters both columns to that airline, as the one-way strip does.
function AirlineStrip({ onward, back, airlines, onAirlines }: {
  onward: FlatFlightResult[]
  back: FlatFlightResult[]
  airlines: Set<string>
  onAirlines: (next: Set<string>) => void
}) {
  const cheapestOn = (list: FlatFlightResult[], code: string) =>
    Math.min(...list.filter(f => airlineOf(f) === code).map(f => youPay(f) ?? Infinity))
  const both = [...new Set(onward.map(airlineOf))].filter(code => code && back.some(f => airlineOf(f) === code))
    .map(code => ({ code, name: onward.find(f => airlineOf(f) === code)?.airline?.name ?? code, from: cheapestOn(onward, code) + cheapestOn(back, code) }))
    .filter(a => Number.isFinite(a.from))
    .sort((a, b) => a.from - b.from)
  if (both.length < 2) return null
  return (
    <div className={rcss.strip} role="group" aria-label="Lowest price both ways, by airline">
      <button type="button" className={rcss.all} aria-pressed={airlines.size === 0} onClick={() => onAirlines(new Set())}>
        <b>All airlines</b><small>{onward.length + back.length} flights</small>
      </button>
      {both.map(a => (
        <button key={a.code} type="button" aria-pressed={airlines.has(a.code)} onClick={() => onAirlines(flip(airlines, a.code))}>
          <AirlineMark code={a.code} name={a.name} size={26} />
          <b>{inr(a.from)}</b>
          <small>{a.name} · both ways</small>
        </button>
      ))}
    </div>
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
  const [onSel, setOnSel] = useState<Pick | null>(null)
  const [retSel, setRetSel] = useState<Pick | null>(null)
  const onPick = onSel?.flight ?? null
  const retPick = retSel?.flight ?? null
  // The fare each pick carries.
  const fareOf = (s: Pick | null) => s ? s.flight.fareOptions.find(o => o.pricingKey === s.pricingKey) ?? startFare(s.flight) : null
  const [showSpecial, setShowSpecial] = useState(false)
  const [filters, setFilters] = useState<Filters>(() => emptyFilters(2))
  const [showFilters, setShowFilters] = useState(false)
  const [visibleOn, visibleBack] = applyFilters([onward, back], filters)
  const active = activeCount(filters)
  // Airlines the policy left out of either column, named once.
  const hidden = [...new Map([...(split.onward?.hiddenByPolicy ?? []), ...(split.return?.hiddenByPolicy ?? [])].map(h => [h.code, h])).values()]

  // The return fare that is these exact two flights, if the airline sells one.
  const matching = onPick && retPick ? special.find(s => {
    const [jo, jr] = journeysOf(s)
    return jo && jr && numbersOf(jo.legs) === numbersOf(journeysOf(onPick)[0]?.legs) && numbersOf(jr.legs) === numbersOf(journeysOf(retPick)[0]?.legs)
  }) : undefined
  const total = onSel && retSel ? amountOf(fareOf(onSel)!) + amountOf(fareOf(retSel)!) : null
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

  const pickLine = (label: string, sel: Pick | null, clear: () => void) => {
    const f = sel?.flight ?? null
    if (!f) return <div className={`${css.pick} ${css.pickEmpty}`}><div><small>{label}</small><b>Pick a flight</b></div></div>
    const j = journeysOf(f)[0]
    return (
      <div className={css.pick}>
        <AirlineMark code={airlineOf(f)} name={f.airline?.name} size={26} />
        <div>
          <small>{label}</small>
          <b>{f.airline?.name ?? airlineOf(f)} {f.legs?.[0]?.flightNumber ?? ''}</b>
          <span>{clock(j?.origin?.dateTime)} → {clock(j?.destination?.dateTime)} · {inr(amountOf(fareOf(sel)!))}</span>
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

      <div className={rcss.body}>
        <FilterPanel
          lists={[onward, back]} filters={filters} onChange={setFilters} shown={showFilters} hiddenByPolicy={hidden}
          departLabels={['Onward · departs', 'Return · departs']} arriveLabels={['Onward · arrives', 'Return · arrives']}
          priceLabel="Price per flight, up to"
        />
        <div className={css.main}>
          <AirlineStrip onward={onward} back={back} airlines={filters.airlines}
            onAirlines={airlines => setFilters(f => ({ ...f, airlines }))} />
          <div className={css.toolbar}>
            <span>Pick one flight each way. Filters apply to both columns; times to their own.</span>
            <button type="button" className={rcss.filtersToggle} onClick={() => setShowFilters(v => !v)} aria-expanded={showFilters}>
              Filters{active ? ` (${active})` : ''}
            </button>
          </div>
          <div className={css.cols}>
            <Column title="Onward" list={onward} visible={visibleOn} onClear={() => setFilters(emptyFilters(2))} selected={onSel} onPick={setOnSel} />
            <Column title="Return" list={back} visible={visibleBack} onClear={() => setFilters(emptyFilters(2))} selected={retSel} onPick={setRetSel} />
          </div>
        </div>
      </div>

      <div className={css.bar}>
        {pickLine('Onward', onSel, () => setOnSel(null))}
        {pickLine('Return', retSel, () => setRetSel(null))}
        <div className={css.total}>
          <div><small>Total, 2 bookings</small><b>{total !== null ? inr(total) : '—'}</b></div>
          <button
            type="button" className={css.continueBtn} disabled={!onPick || !retPick || navigatingKey !== null}
            onClick={() => onSel && retSel && onContinue({
              onward: { flightKey: onSel.flight.flightKey, pricingKey: onSel.pricingKey },
              return: { flightKey: retSel.flight.flightKey, pricingKey: retSel.pricingKey },
            })}
          >
            {navigatingKey ? 'Opening…' : 'Continue'}
          </button>
        </div>
        {matching && matchingPrice !== undefined && total !== null && matchingPrice < total && (
          <div className={css.hint}>
            These two flights also come as a {matching.airline?.name ?? airlineOf(matching)} return fare for {inr(matchingPrice)}, saving {inr(total - matchingPrice)}.{' '}
            <button type="button" onClick={() => onChooseSpecial(matching, startFare(matching))}>Use the return fare</button>
          </div>
        )}
        <p className={css.barNote}>You choose each flight&apos;s fare on the next page. Each is priced and booked on its own: passenger details once, one approval for both, and either can be cancelled alone.</p>
      </div>
    </div>
  )
}
