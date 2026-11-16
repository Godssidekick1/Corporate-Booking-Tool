'use client'

import AirlineMark from '@/app/components/AirlineMark'
import {
  activeCount, airlineOf, arriveBucket, countIf, departBucket, emptyFilters, flip, hasWithin, isRefundable, stopsOf, youPay,
  type Bucket, type Filters, type Group,
} from '@/app/lib/book/resultFilters'
import type { FlatFlightResult } from '@/app/lib/book/types'
import css from './FlightResults.module.css'

// ── The filters beside the results ───────────────────────────────────────────
// One-way results and a domestic round trip's two columns use the same panel
// (app/lib/book/resultFilters.ts does the filtering and counting). For a round
// trip every group applies to both columns, except the times: each column has
// its own Departs and Arrives, headed with `timeLabels`.
// ─────────────────────────────────────────────────────────────────────────────

const BUCKETS: { key: Bucket; label: string; path: string }[] = [
  { key: 'early', label: 'Before 6', path: 'M4 18h16M7 14a5 5 0 0 1 10 0' },
  { key: 'morning', label: '6 – 12', path: 'M12 3v2M5 12H3m18 0h-2M6.3 6.3 4.9 4.9m12.8 1.4 1.4-1.4M8 12a4 4 0 0 1 8 0' },
  { key: 'afternoon', label: '12 – 6', path: 'M12 2v2m0 16v2M2 12h2m16 0h2M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10' },
  { key: 'evening', label: 'After 6', path: 'M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5' },
]
const STOPS: { key: number; label: string }[] = [{ key: 0, label: 'Non-stop' }, { key: 1, label: '1 stop' }, { key: 2, label: '2+ stops' }]

const inr = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`

export interface FilterPanelProps {
  // One list (one way), or two (onward, return).
  lists: FlatFlightResult[][]
  filters: Filters
  onChange: (next: Filters) => void
  hiddenByPolicy?: { code: string; name: string }[]
  // The heading of each list's Departs / Arrives: ['Departs'] for one way,
  // ['Onward · departs', 'Return · departs'] for two columns.
  departLabels: string[]
  arriveLabels: string[]
  priceLabel?: string
  // Shown on narrow screens (behind the results' Filters button).
  shown: boolean
}

export default function FilterPanel({
  lists, filters, onChange, hiddenByPolicy = [], departLabels, arriveLabels, priceLabel = 'Price, up to', shown,
}: FilterPanelProps) {
  const all = lists.flat()
  const prices = all.map(youPay).filter((n): n is number => typeof n === 'number')
  const lo = prices.length ? Math.floor(Math.min(...prices)) : 0
  const hi = prices.length ? Math.ceil(Math.max(...prices)) : 0
  const judged = all.some(r => r.fareOptions.some(o => o.policy))
  const codes = [...new Set(all.map(airlineOf).filter(Boolean))]
  const nameOf = (code: string) => all.find(r => airlineOf(r) === code)?.airline?.name ?? code
  const active = activeCount(filters)
  const count = (group: Group, pred: (f: FlatFlightResult) => boolean) => countIf(lists, filters, group, pred)
  const set = (patch: Partial<Filters>) => onChange({ ...filters, ...patch })

  const bucketButtons = (list: number, which: 'dep' | 'arr') => {
    const chosen = filters.times[list]?.[which] ?? new Set<Bucket>()
    const of = which === 'dep' ? departBucket : arriveBucket
    return BUCKETS.map(b => {
      const n = count(`${which}${list}`, f => of(f) === b.key)
      const on = chosen.has(b.key)
      return (
        <button key={b.key} type="button" aria-pressed={on} disabled={!n && !on} title={`${n} flight${n === 1 ? '' : 's'}`}
          onClick={() => set({ times: filters.times.map((t, i) => (i === list ? { ...t, [which]: flip(chosen, b.key) } : t)) })}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true"><path d={b.path} /></svg>
          {b.label}
        </button>
      )
    })
  }

  return (
    <aside className={`${css.filters} ${shown ? css.filtersShown : ''}`} aria-label="Filters">
      <div className={css.filtersHead}>
        <b>Filters</b>
        {active > 0 && <button type="button" className={css.linkBtn} onClick={() => onChange(emptyFilters(lists.length))}>Clear all ({active})</button>}
      </div>

      {judged && (
        <label className={css.toggle}>
          <span>Within policy only <small>({count('within', hasWithin)})</small></span>
          <input type="checkbox" checked={filters.withinOnly} onChange={e => set({ withinOnly: e.target.checked })} />
        </label>
      )}

      <div className={css.group}>
        <h4>Stops</h4>
        <div className={css.chips}>
          {STOPS.map(st => {
            const n = count('stops', f => Math.min(stopsOf(f), 2) === st.key)
            const on = filters.stops.has(st.key)
            return (
              <button key={st.key} type="button" className={css.chip} aria-pressed={on} disabled={!n && !on}
                onClick={() => set({ stops: flip(filters.stops, st.key) })}>
                {st.label}<small>{n}</small>
              </button>
            )
          })}
        </div>
      </div>

      {lists.map((_, i) => (
        <div key={i} className={css.timeGroups}>
          <div className={css.group}>
            <h4>{departLabels[i]}</h4>
            <div className={css.tod}>{bucketButtons(i, 'dep')}</div>
          </div>
          <div className={css.group}>
            <h4>{arriveLabels[i]}</h4>
            <div className={css.tod}>{bucketButtons(i, 'arr')}</div>
          </div>
        </div>
      ))}

      <div className={css.group}>
        <h4>Airlines</h4>
        {codes.map(code => (
          <label key={code} className={css.airlineOpt}>
            <input type="checkbox" checked={filters.airlines.has(code)} onChange={() => set({ airlines: flip(filters.airlines, code) })} />
            <span className={css.airlineName}><AirlineMark code={code} name={nameOf(code)} size={22} /><span>{nameOf(code)}</span></span>
            <small>{count('airlines', f => airlineOf(f) === code)}</small>
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
          <h4>{priceLabel}</h4>
          <div className={css.range}>
            <input type="range" min={lo} max={hi} step={10} value={filters.maxPrice ?? hi} aria-label="Highest price"
              onChange={e => { const v = Number(e.target.value); set({ maxPrice: v >= hi ? null : v }) }} />
            <div className={css.rangeEnds}><span>{inr(lo)}</span><b>{inr(filters.maxPrice ?? hi)}</b></div>
          </div>
        </div>
      )}

      <label className={css.toggle}>
        <span>Refundable fares only <small>({count('refundable', isRefundable)})</small></span>
        <input type="checkbox" checked={filters.refundable} onChange={e => set({ refundable: e.target.checked })} />
      </label>
    </aside>
  )
}
