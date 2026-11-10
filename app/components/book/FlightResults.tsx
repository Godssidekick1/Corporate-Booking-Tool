'use client'

import { Fragment, useMemo, useState } from 'react'
import AirlineMark from '@/app/components/AirlineMark'
import { VERDICT_META } from '@/app/lib/policy/verdictLabels'
import { journeysOf, type FareOption, type FlatFlightResult, type Journey } from '@/app/lib/book/types'
import css from './FlightResults.module.css'

// ── FlightResults ────────────────────────────────────────────────────────────
// The list of flights a search found: filters on the left, a lowest-price-by-
// airline strip and the sort above, one card per flight. A card shows the
// airline's logo, the times, duration and stops of each direction, what the
// company pays for its cheapest fare, and ONE chip: the traveller's policy
// verdict (user, 2026-11-10: baggage, refundability and the rest belong in the
// fare options, not on the card). The fare options open inside the card;
// choosing one goes to the fare page with that fare selected.
//
// Every figure shown is the sell estimate (what the company pays), the one the
// policy judges. A round trip priced together is one card with both directions.
// ─────────────────────────────────────────────────────────────────────────────

type Verdict = 'green' | 'amber' | 'red'
type Bucket = 'early' | 'morning' | 'afternoon' | 'evening'
type SortKey = 'cheapest' | 'fastest' | 'earliest' | 'latest'

const BUCKETS: { key: Bucket; label: string; path: string }[] = [
  { key: 'early', label: 'Before 6', path: 'M4 18h16M7 14a5 5 0 0 1 10 0' },
  { key: 'morning', label: '6 – 12', path: 'M12 3v2M5 12H3m18 0h-2M6.3 6.3 4.9 4.9m12.8 1.4 1.4-1.4M8 12a4 4 0 0 1 8 0' },
  { key: 'afternoon', label: '12 – 6', path: 'M12 2v2m0 16v2M2 12h2m16 0h2M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10' },
  { key: 'evening', label: 'After 6', path: 'M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5' },
]
const STOPS: { key: number; label: string }[] = [{ key: 0, label: 'Non-stop' }, { key: 1, label: '1 stop' }, { key: 2, label: '2+ stops' }]

const inr = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`

// "2030-11-10T08:05:00" -> "08:05", read from the string: the provider sends
// local airport times with no zone, so parsing to a Date would shift them.
const clock = (iso?: string) => /T(\d{2}:\d{2})/.exec(iso ?? '')?.[1] ?? '—'
const dayOf = (iso?: string) => /^(\d{4}-\d{2}-\d{2})/.exec(iso ?? '')?.[1] ?? ''
const hourOf = (iso?: string) => Number(/T(\d{2})/.exec(iso ?? '')?.[1] ?? NaN)
function bucketOf(iso?: string): Bucket | null {
  const h = hourOf(iso)
  if (!Number.isFinite(h)) return null
  return h < 6 ? 'early' : h < 12 ? 'morning' : h < 18 ? 'afternoon' : 'evening'
}
function minutes(duration?: string): number {
  const m = /^(\d+):(\d{2})/.exec(duration ?? '')
  return m ? Number(m[1]) * 60 + Number(m[2]) : 0
}
const hm = (mins: number) => `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`

const fareAmount = (f: FareOption) => f.sellEstimate ?? f.totalFare
const airlineOf = (f: FlatFlightResult) => (f.airline?.code ?? f.legs?.[0]?.airlineCode ?? '').toUpperCase()
const stopsOf = (f: FlatFlightResult) => Math.max(...journeysOf(f).map(j => j.stopCount ?? 0))
const durationOf = (f: FlatFlightResult) => journeysOf(f).reduce((sum, j) => sum + minutes(j.totalDuration ?? j.duration), 0)

// What the company pays for the cheapest fare.
export function youPay(f: FlatFlightResult): number | undefined {
  const amounts = f.fareOptions.map(fareAmount).filter((n): n is number => typeof n === 'number')
  return amounts.length ? Math.min(...amounts) : f.sellEstimate ?? f.totalFare
}

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
const hasWithin = (f: FlatFlightResult) => f.fareOptions.some(o => o.policy === 'green')

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

const Chevron = () => (
  <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m3 4.5 3 3 3-3" /></svg>
)

export interface FlightResultsProps {
  results: FlatFlightResult[]
  // Airlines the traveller's policy left out of these results, by name.
  hiddenByPolicy?: { code: string; name: string }[]
  // The flight and fare chosen; the page goes on to the fare page.
  onChoose: (flight: FlatFlightResult, fare: FareOption) => void
  navigatingKey: string | null
}

export default function FlightResults({ results, hiddenByPolicy = [], onChoose, navigatingKey }: FlightResultsProps) {
  const [sort, setSort] = useState<SortKey>('cheapest')
  const [airlines, setAirlines] = useState<Set<string>>(new Set())
  const [stops, setStops] = useState<Set<number>>(new Set())
  const [dep, setDep] = useState<Set<Bucket>>(new Set())
  const [arr, setArr] = useState<Set<Bucket>>(new Set())
  const [refundable, setRefundable] = useState(false)
  const [withinOnly, setWithinOnly] = useState(false)
  const [maxPrice, setMaxPrice] = useState<number | null>(null)
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [showFilters, setShowFilters] = useState(false)

  const prices = results.map(youPay).filter((n): n is number => typeof n === 'number')
  const lo = prices.length ? Math.floor(Math.min(...prices)) : 0
  const hi = prices.length ? Math.ceil(Math.max(...prices)) : 0
  const judged = results.some(r => r.fareOptions.some(o => o.policy))
  const roundTrip = results.some(r => journeysOf(r).length > 1)

  // Each filter's test on its own, so a group's counts can be worked out with
  // every OTHER group applied: a chip's number is what clicking it would show.
  const tests = useMemo(() => ({
    airlines: (f: FlatFlightResult) => airlines.size === 0 || airlines.has(airlineOf(f)),
    stops: (f: FlatFlightResult) => stops.size === 0 || stops.has(Math.min(stopsOf(f), 2)),
    dep: (f: FlatFlightResult) => dep.size === 0 || dep.has(bucketOf(journeysOf(f)[0]?.origin?.dateTime) as Bucket),
    arr: (f: FlatFlightResult) => arr.size === 0 || arr.has(bucketOf(journeysOf(f)[0]?.destination?.dateTime) as Bucket),
    refundable: (f: FlatFlightResult) => !refundable || f.fareOptions.some(o => o.refundable),
    within: (f: FlatFlightResult) => !withinOnly || hasWithin(f),
    price: (f: FlatFlightResult) => maxPrice === null || (youPay(f) ?? Infinity) <= maxPrice,
  }), [airlines, stops, dep, arr, refundable, withinOnly, maxPrice])
  type Group = keyof typeof tests
  const passes = (f: FlatFlightResult, except?: Group) =>
    (Object.keys(tests) as Group[]).every(k => k === except || tests[k](f))
  const countIf = (group: Group, pred: (f: FlatFlightResult) => boolean) => results.filter(f => passes(f, group) && pred(f)).length

  const shown = results.filter(f => passes(f)).sort((a, b) => {
    if (sort === 'cheapest') return (youPay(a) ?? Infinity) - (youPay(b) ?? Infinity)
    if (sort === 'fastest') return durationOf(a) - durationOf(b)
    const da = journeysOf(a)[0]?.origin?.dateTime ?? '', db = journeysOf(b)[0]?.origin?.dateTime ?? ''
    return sort === 'earliest' ? da.localeCompare(db) : db.localeCompare(da)
  })

  const codes = [...new Set(results.map(airlineOf).filter(Boolean))]
  const nameOf = (code: string) => results.find(r => airlineOf(r) === code)?.airline?.name ?? code
  const cheapest = prices.length ? Math.min(...prices) : undefined
  const fastest = results.length ? Math.min(...results.map(durationOf)) : 0
  const active = airlines.size + stops.size + dep.size + arr.size + (refundable ? 1 : 0) + (withinOnly ? 1 : 0) + (maxPrice !== null ? 1 : 0)

  function flip<T>(set: Set<T>, value: T, update: (s: Set<T>) => void) {
    const next = new Set(set)
    if (next.has(value)) next.delete(value)
    else next.add(value)
    update(next)
  }
  function clearAll() {
    setAirlines(new Set()); setStops(new Set()); setDep(new Set()); setArr(new Set())
    setRefundable(false); setWithinOnly(false); setMaxPrice(null)
  }

  const bucketButtons = (which: 'dep' | 'arr') => {
    const set = which === 'dep' ? dep : arr
    const setter = which === 'dep' ? setDep : setArr
    return BUCKETS.map(b => {
      const count = countIf(which, f => bucketOf(journeysOf(f)[0]?.[which === 'dep' ? 'origin' : 'destination']?.dateTime) === b.key)
      const on = set.has(b.key)
      return (
        <button key={b.key} type="button" aria-pressed={on} disabled={!count && !on} title={`${count} flight${count === 1 ? '' : 's'}`}
          onClick={() => flip(set, b.key, setter)}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true"><path d={b.path} /></svg>
          {b.label}
        </button>
      )
    })
  }

  return (
    <div className={css.body}>
      <aside className={`${css.filters} ${showFilters ? css.filtersShown : ''}`} aria-label="Filters">
        <div className={css.filtersHead}>
          <b>Filters</b>
          {active > 0 && <button type="button" className={css.linkBtn} onClick={clearAll}>Clear all ({active})</button>}
        </div>

        {judged && (
          <label className={css.toggle}>
            <span>Within policy only <small>({countIf('within', hasWithin)})</small></span>
            <input type="checkbox" checked={withinOnly} onChange={e => setWithinOnly(e.target.checked)} />
          </label>
        )}

        <div className={css.group}>
          <h4>Stops</h4>
          <div className={css.chips}>
            {STOPS.map(s => {
              const count = countIf('stops', f => Math.min(stopsOf(f), 2) === s.key)
              const on = stops.has(s.key)
              return (
                <button key={s.key} type="button" className={css.chip} aria-pressed={on} disabled={!count && !on}
                  onClick={() => flip(stops, s.key, setStops)}>
                  {s.label}<small>{count}</small>
                </button>
              )
            })}
          </div>
        </div>

        <div className={css.group}>
          <h4>Departs{roundTrip ? ' (outbound)' : ''}</h4>
          <div className={css.tod}>{bucketButtons('dep')}</div>
        </div>
        <div className={css.group}>
          <h4>Arrives{roundTrip ? ' (outbound)' : ''}</h4>
          <div className={css.tod}>{bucketButtons('arr')}</div>
        </div>

        <div className={css.group}>
          <h4>Airlines</h4>
          {codes.map(code => (
            <label key={code} className={css.airlineOpt}>
              <input type="checkbox" checked={airlines.has(code)} onChange={() => flip(airlines, code, setAirlines)} />
              <span className={css.airlineName}><AirlineMark code={code} name={nameOf(code)} size={22} /><span>{nameOf(code)}</span></span>
              <small>{countIf('airlines', f => airlineOf(f) === code)}</small>
            </label>
          ))}
          {hiddenByPolicy.length > 0 && (
            <div className={css.hiddenNote}>
              {hiddenByPolicy.map(h => h.name).join(', ')} {hiddenByPolicy.length === 1 ? 'isn’t' : 'aren’t'} shown: the travel policy doesn&apos;t allow {hiddenByPolicy.length === 1 ? 'it' : 'them'}.
            </div>
          )}
        </div>

        {hi > lo && (
          <div className={css.group}>
            <h4>Price, up to</h4>
            <div className={css.range}>
              <input type="range" min={lo} max={hi} step={10} value={maxPrice ?? hi} aria-label="Highest price"
                onChange={e => { const v = Number(e.target.value); setMaxPrice(v >= hi ? null : v) }} />
              <div className={css.rangeEnds}><span>{inr(lo)}</span><b>{inr(maxPrice ?? hi)}</b></div>
            </div>
          </div>
        )}

        <label className={css.toggle}>
          <span>Refundable fares only <small>({countIf('refundable', f => f.fareOptions.some(o => o.refundable))})</small></span>
          <input type="checkbox" checked={refundable} onChange={e => setRefundable(e.target.checked)} />
        </label>
      </aside>

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
                <button key={code} type="button" aria-pressed={airlines.has(code)} onClick={() => flip(airlines, code, setAirlines)}>
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
          const isOpen = open.has(flight.flightKey)
          const chip = cardVerdict(flight)
          const price = youPay(flight)
          const numbers = [...new Set((flight.legs ?? []).map(l => `${l.airlineCode ?? code} ${l.flightNumber ?? ''}`.trim()))].join(' · ')
          const navigating = navigatingKey === flight.flightKey
          return (
            <article key={flight.flightKey} className={`${css.card} ${isOpen ? css.cardOpen : ''}`}>
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
                    {journeys.length > 1 ? 'both flights' : flight.fareOptions.length > 1 ? 'from' : ''}
                    {flight.fareOptions.length > 1 ? `${journeys.length > 1 ? ', ' : ' · '}${flight.fareOptions.length} fares` : ''}
                  </span>
                  <button type="button" className={css.faresBtn} aria-expanded={isOpen}
                    onClick={() => flip(open, flight.flightKey, setOpen)}>
                    {isOpen ? 'Hide fares' : 'View fares'} <Chevron />
                  </button>
                </div>
              </div>

              {chip && <div className={css.tags}><Chip verdict={chip.verdict} from={chip.from} /></div>}

              {isOpen && (
                <div className={css.fareGrid}>
                  {flight.fareOptions.map((fare, i) => {
                    const amount = fareAmount(fare)
                    const name = fare.brandedFareName || fare.fareType || `Fare ${i + 1}`
                    return (
                      <div key={fare.pricingKey || i} className={css.fare}
                        style={fare.policy && fare.policy !== 'green' ? { borderColor: VERDICT_META[fare.policy].border } : undefined}>
                        <div className={css.fareTop}><b title={name}>{name}</b><span>{amount !== undefined ? inr(amount) : '—'}</span></div>
                        {fare.policy && <div><Chip verdict={fare.policy} /></div>}
                        <ul>
                          <li className={fare.refundable ? '' : css.fareNo}>{fare.refundable ? 'Refundable' : 'Non-refundable'}</li>
                          {flight.checkInBaggageKg && <li>{flight.checkInBaggageKg} kg check-in{flight.cabinBaggageKg ? `, ${flight.cabinBaggageKg} kg cabin` : ''}</li>}
                          {!flight.checkInBaggageKg && flight.checkInBaggagePieces && <li>{flight.checkInBaggagePieces} check-in</li>}
                          <li className={fare.mealIncluded ? '' : css.fareNo}>{fare.mealIncluded ? 'Meal included' : 'Meal not included'}</li>
                          {(fare.brandedServices ?? []).slice(0, 3).map(s => <li key={s}>{s}</li>)}
                        </ul>
                        <button type="button" className={css.chooseBtn} disabled={navigating} onClick={() => onChoose(flight, fare)}>
                          {navigating ? 'Opening…' : 'Choose'}
                        </button>
                      </div>
                    )
                  })}
                </div>
              )}
            </article>
          )
        })}
      </section>
    </div>
  )
}
