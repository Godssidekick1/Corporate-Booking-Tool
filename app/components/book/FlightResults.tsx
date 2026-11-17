'use client'

import { Fragment, useState } from 'react'
import AirlineMark from '@/app/components/AirlineMark'
import FilterPanel from '@/app/components/book/FilterPanel'
import { VERDICT_META } from '@/app/lib/policy/verdictLabels'
import { journeysOf, type FareOption, type FlatFlightResult, type Journey } from '@/app/lib/book/types'
import {
  activeCount, airlineOf, applyFilters, defaultFare, durationOf, emptyFilters, fareAmount, flip, minutes, stopsOf, youPay,
  type Filters,
} from '@/app/lib/book/resultFilters'
import css from './FlightResults.module.css'

// The cheapest fare's price, for callers that render flights themselves.
export { youPay }

// ── FlightResults ────────────────────────────────────────────────────────────
// The list of flights a search found: filters on the left, a lowest-price-by-
// airline strip and the sort above, one card per flight. A card shows the
// airline's logo, the times, duration and stops of each direction, what the
// company pays for its cheapest fare, and ONE chip: the traveller's policy
// verdict (user, 2026-11-10: baggage, refundability and the rest belong in the
// fare options, not on the card). Fares are chosen on the fare page (user,
// 2026-11-16): a card says how many there are and continues there, starting
// on the cheapest fare within policy.
//
// Every figure shown is the sell estimate (what the company pays), the one the
// policy judges. A round trip priced together is one card with both directions.
// ─────────────────────────────────────────────────────────────────────────────

type Verdict = 'green' | 'amber' | 'red'
type SortKey = 'cheapest' | 'fastest' | 'earliest' | 'latest'

const inr = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`

// "2030-11-10T08:05:00" -> "08:05", read from the string: the provider sends
// local airport times with no zone, so parsing to a Date would shift them.
const clock = (iso?: string) => /T(\d{2}:\d{2})/.exec(iso ?? '')?.[1] ?? '—'
const dayOf = (iso?: string) => /^(\d{4}-\d{2}-\d{2})/.exec(iso ?? '')?.[1] ?? ''
const hm = (mins: number) => `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`

// The card's one chip. The cheapest fare's verdict, unless a dearer fare on
// the same flight is within policy (a refundable fare where the policy asks
// for one): then "Within policy from ₹X", which is the more useful thing to
// know. None when search sent no verdicts (policy off or not set up).
function cardVerdict(f: FlatFlightResult): { verdict: Verdict; from?: number } | null {
  const judged = f.fareOptions.filter(o => o.policy && typeof fareAmount(o) === 'number')
  if (judged.length === 0) return null
  const cheapest = judged.reduce((a, b) => (fareAmount(b)! < fareAmount(a)! ? b : a))
  if (cheapest.policy === 'green') return { verdict: 'green' }
  const within = judged.filter(o => o.policy === 'green').map(o => fareAmount(o)!)
  if (within.length) return { verdict: 'green', from: Math.min(...within) }
  return { verdict: cheapest.policy! }
}

function Chip({ verdict, from }: { verdict: Verdict; from?: number }) {
  const meta = VERDICT_META[verdict]
  return (
    <span className={css.pill} style={{ color: meta.color, background: meta.bg, borderColor: meta.border }}>
      <i />{meta.label}{from !== undefined ? ` from ${inr(from)}` : ''}
    </span>
  )
}

function Track({ journey }: { journey: Journey }) {
  const stops = journey.stops ?? []
  const count = journey.stopCount ?? stops.length
  const label = count === 0 ? 'Non-stop' : `${count} stop${count > 1 ? 's' : ''}${stops.length ? ` · ${stops.map(s => s.code || s.city).join(', ')}` : ''}`
  return (
    <div className={css.track}>
      <span>{hm(minutes(journey.totalDuration ?? journey.duration))}</span>
      <div className={css.bar}>
        {stops.map((s, i) => <i key={i} className={css.stopDot} style={{ left: `${((i + 1) / (stops.length + 1)) * 100}%` }} />)}
      </div>
      <span className={`${css.stops} ${count === 0 ? css.nonStop : ''}`}>{label}</span>
    </div>
  )
}

function Leg({ journey }: { journey: Journey }) {
  const nextDay = dayOf(journey.destination?.dateTime) > dayOf(journey.origin?.dateTime)
  return (
    <div className={css.leg}>
      <div className={css.pt}><b>{clock(journey.origin?.dateTime)}</b><span>{journey.origin?.code}</span></div>
      <Track journey={journey} />
      <div className={`${css.pt} ${css.ptEnd}`}>
        <b>{clock(journey.destination?.dateTime)}{nextDay && <sup>+1</sup>}</b><span>{journey.destination?.code}</span>
      </div>
    </div>
  )
}

const Arrow = () => (
  <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M2.5 6h7M6.5 3l3 3-3 3" /></svg>
)

export interface FlightResultsProps {
  results: FlatFlightResult[]
  // Airlines the traveller's policy left out of these results, by name.
  hiddenByPolicy?: { code: string; name: string }[]
  // The flight, and the fare to start on; the page goes on to the fare page.
  onChoose: (flight: FlatFlightResult, fare: FareOption) => void
  navigatingKey: string | null
}

export default function FlightResults({ results, hiddenByPolicy = [], onChoose, navigatingKey }: FlightResultsProps) {
  const [sort, setSort] = useState<SortKey>('cheapest')
  const [filters, setFilters] = useState<Filters>(() => emptyFilters(1))
  const [showFilters, setShowFilters] = useState(false)

  const prices = results.map(youPay).filter((n): n is number => typeof n === 'number')
  const roundTrip = results.some(r => journeysOf(r).length > 1)
  const airlines = filters.airlines
  const setAirlines = (next: Set<string>) => setFilters(f => ({ ...f, airlines: next }))

  const shown = applyFilters([results], filters)[0].sort((a, b) => {
    if (sort === 'cheapest') return (youPay(a) ?? Infinity) - (youPay(b) ?? Infinity)
    if (sort === 'fastest') return durationOf(a) - durationOf(b)
    const da = journeysOf(a)[0]?.origin?.dateTime ?? '', db = journeysOf(b)[0]?.origin?.dateTime ?? ''
    return sort === 'earliest' ? da.localeCompare(db) : db.localeCompare(da)
  })

  const codes = [...new Set(results.map(airlineOf).filter(Boolean))]
  const nameOf = (code: string) => results.find(r => airlineOf(r) === code)?.airline?.name ?? code
  const cheapest = prices.length ? Math.min(...prices) : undefined
  const fastest = results.length ? Math.min(...results.map(durationOf)) : 0
  const active = activeCount(filters)

  return (
    <div className={css.body}>
      <FilterPanel
        lists={[results]} filters={filters} onChange={setFilters} hiddenByPolicy={hiddenByPolicy} shown={showFilters}
        departLabels={[`Departs${roundTrip ? ' (outbound)' : ''}`]} arriveLabels={[`Arrives${roundTrip ? ' (outbound)' : ''}`]}
      />

      <section className={css.results}>
        {codes.length > 1 && (
          <div className={css.strip} role="group" aria-label="Lowest price by airline">
            <button type="button" className={css.all} aria-pressed={airlines.size === 0} onClick={() => setAirlines(new Set())}>
              <b>All airlines</b><small>{results.length} flights</small>
            </button>
            {codes.map(code => {
              const mine = results.filter(r => airlineOf(r) === code)
              const from = Math.min(...mine.map(r => youPay(r) ?? Infinity))
              return (
                <button key={code} type="button" aria-pressed={airlines.has(code)} onClick={() => setAirlines(flip(airlines, code))}>
                  <AirlineMark code={code} name={nameOf(code)} size={26} />
                  <b>{Number.isFinite(from) ? inr(from) : '—'}</b>
                  <small>{nameOf(code)}{mine.some(r => stopsOf(r) === 0) ? ' · non-stop' : ''}</small>
                </button>
              )
            })}
          </div>
        )}

        <div className={css.toolbar}>
          <span className={css.count}>
            <b>{shown.length}</b> of {results.length} flights
            {hiddenByPolicy.length > 0 && ` · ${hiddenByPolicy.length} airline${hiddenByPolicy.length === 1 ? '' : 's'} hidden by policy`}
          </span>
          <div className={css.toolbarRight}>
            <button type="button" className={css.filtersToggle} onClick={() => setShowFilters(v => !v)} aria-expanded={showFilters}>
              Filters{active ? ` (${active})` : ''}
            </button>
            <div className={css.seg} role="group" aria-label="Sort">
              <button type="button" aria-pressed={sort === 'cheapest'} onClick={() => setSort('cheapest')}>
                Cheapest{cheapest !== undefined && <small>{inr(cheapest)}</small>}
              </button>
              <button type="button" aria-pressed={sort === 'fastest'} onClick={() => setSort('fastest')}>
                Fastest{fastest > 0 && <small>{hm(fastest)}</small>}
              </button>
              <button type="button" aria-pressed={sort === 'earliest'} onClick={() => setSort('earliest')}>Earliest</button>
              <button type="button" aria-pressed={sort === 'latest'} onClick={() => setSort('latest')}>Latest</button>
            </div>
          </div>
        </div>

        {shown.length === 0 ? (
          <div className={css.empty}>
            <b>No flights match these filters</b>
            Clear a filter to see more. {results.length} flight{results.length === 1 ? ' was' : 's were'} found.
          </div>
        ) : shown.map(flight => {
          const code = airlineOf(flight)
          const journeys = journeysOf(flight)
          const chip = cardVerdict(flight)
          const price = youPay(flight)
          const numbers = [...new Set((flight.legs ?? []).map(l => `${l.airlineCode ?? code} ${l.flightNumber ?? ''}`.trim()))].join(' · ')
          const navigating = navigatingKey === flight.flightKey
          return (
            <article key={flight.flightKey} className={css.card}>
              <div className={css.cardMain}>
                <div className={css.carrier}>
                  <AirlineMark code={code} name={flight.airline?.name} />
                  <div>
                    <b>
                      {flight.airline?.name ?? code}
                      {flight.preferred && <span className={css.star} title="Preferred airline in the travel policy" aria-label="Preferred airline">★</span>}
                    </b>
                    <span>{numbers || code}</span>
                  </div>
                </div>
                <div className={css.legs}>
                  {journeys.map((j, i) => (
                    <Fragment key={j.journeyNo}>
                      {journeys.length > 1 && <div className={css.dirLabel}>{i === 0 ? 'Outbound' : 'Return'} · {j.origin?.code} → {j.destination?.code}</div>}
                      <Leg journey={j} />
                    </Fragment>
                  ))}
                </div>
                <div className={css.price}>
                  <small>You pay</small>
                  <b>{price !== undefined ? inr(price) : '—'}</b>
                  <span className={css.priceSub}>
                    {journeys.length > 1 ? 'both flights' : flight.fareOptions.length > 1 ? 'cheapest fare' : ''}
                  </span>
                </div>
              </div>

              {/* The card's foot: the policy chip on the left, the way on to
                  the fares on the right, clear of the times above. */}
              <div className={css.foot}>
                <div className={css.tags}>{chip && <Chip verdict={chip.verdict} from={chip.from} />}</div>
                <button type="button" className={css.continueBtn} disabled={navigatingKey !== null}
                  onClick={() => { const fare = defaultFare(flight); if (fare) onChoose(flight, fare) }}>
                  {navigating ? 'Opening…' : <>Continue to see {flight.fareOptions.length} {flight.fareOptions.length === 1 ? 'fare' : 'fares'} <Arrow /></>}
                </button>
              </div>

            </article>
          )
        })}
      </section>
    </div>
  )
}
