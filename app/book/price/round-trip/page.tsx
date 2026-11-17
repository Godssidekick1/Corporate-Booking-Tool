'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import AirlineMark from '@/app/components/AirlineMark'
import FareRow, { fareName } from '@/app/components/book/FareRow'
import FareRulesPanel from '@/app/components/book/FareRulesPanel'
import lay from '../FarePage.module.css'
import { PageLoader } from '@/app/components/book/Takeoff'
import type { FareRules } from '@/app/lib/book/fareRules'
import { flowStorage, type PricedFare, type RoundTripPair } from '@/app/lib/book/flowStorage'
import { useResultsHref } from '@/app/components/book/search/useResultsHref'
import { fetchRulesFor, priceFare, previewPolicy, type PolicyPreview, type PricedLine } from '@/app/lib/book/priceFare'
import { VERDICT_META } from '@/app/lib/policy/verdictLabels'
import { journeysOf, type FlatFlightResult } from '@/app/lib/book/types'

// ── /book/price/round-trip ───────────────────────────────────────────────────
// A domestic round trip's two picks, priced side by side: each flight is its
// own one-way fare, priced and (later) booked on its own, as two linked
// bookings. Each direction can switch to another of its fares, which prices
// that one again. The policy is judged per flight. Continue goes to one
// passenger form for both.
// ─────────────────────────────────────────────────────────────────────────────

type Dir = 'onward' | 'return'
interface Side {
  flight: FlatFlightResult
  pricingKey: string
  loading: boolean
  error: string
  priced: PricedFare | null
  lines: PricedLine[]
  verdict: PolicyPreview | null
  fareRules: FareRules | null
  // The rules are asked after the price (fetchRulesFor), and why none came.
  rulesLoading?: boolean
  rulesProblem?: 'timeout' | 'error' | 'none' | null
}

const inr = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`
const clock = (iso?: string) => /T(\d{2}:\d{2})/.exec(iso ?? '')?.[1] ?? '—'
const day = (iso?: string) => {
  const d = /^(\d{4}-\d{2}-\d{2})/.exec(iso ?? '')?.[1]
  return d ? new Date(`${d}T00:00:00`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' }) : ''
}

export default function RoundTripFarePage() {
  const router = useRouter()
  const resultsHref = useResultsHref()
  const [sides, setSides] = useState<Record<Dir, Side> | null>(null)

  const patch = useCallback((dir: Dir, change: Partial<Side>) =>
    setSides(prev => (prev ? { ...prev, [dir]: { ...prev[dir], ...change } } : prev)), [])

  const price = useCallback(async (dir: Dir, flight: FlatFlightResult, pricingKey: string) => {
    patch(dir, { loading: true, error: '', priced: null, verdict: null, fareRules: null, pricingKey })
    const fare = flight.fareOptions.find(o => o.pricingKey === pricingKey) ?? flight.fareOptions[0]
    const outcome = await priceFare(flight, fare)
    if (!outcome.ok) { patch(dir, { loading: false, error: outcome.error }); return }
    patch(dir, { loading: false, priced: outcome.priced, lines: outcome.lines, fareRules: null, rulesLoading: true })
    // The fare rules on their own request (they take 7-12 s); kept only if
    // this side still has the same fare when they arrive.
    askRules(dir, outcome.priced)
    patch(dir, { verdict: await previewPolicy(flight, outcome.priced) })
  }, [patch])

  useEffect(() => {
    const pair = flowStorage.getPair()
    const onward = pair && flowStorage.findResultByFlightKey(pair.onward.flightKey)
    const back = pair && flowStorage.findResultByFlightKey(pair.return.flightKey)
    // Only reachable by picking both flights on the results page.
    if (!pair || !onward || !back) { router.replace('/book/flights'); return }
    const side = (flight: FlatFlightResult, pricingKey: string): Side =>
      ({ flight, pricingKey, loading: true, error: '', priced: null, lines: [], verdict: null, fareRules: null })
    // Seeding this page's state from what the results page kept, once.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSides({ onward: side(onward, pair.onward.pricingKey), return: side(back, pair.return.pricingKey) })
    price('onward', onward, pair.onward.pricingKey)
    price('return', back, pair.return.pricingKey)
  }, [router, price])

  // One side's fare rules; kept only if that side still has the same fare.
  function askRules(dir: Dir, priced: PricedFare) {
    const ref = priced.referenceNo
    setSides(prev => (prev ? { ...prev, [dir]: { ...prev[dir], rulesLoading: true, rulesProblem: null } } : prev))
    fetchRulesFor(priced).then(answer => setSides(prev => (
      prev && prev[dir].priced?.referenceNo === ref
        ? { ...prev, [dir]: { ...prev[dir], fareRules: answer.rules, rulesLoading: false, rulesProblem: answer.problem } }
        : prev)))
  }

  function changeFare(dir: Dir, pricingKey: string) {
    if (!sides) return
    const pair = flowStorage.getPair()
    if (pair) flowStorage.savePair({ ...pair, [dir]: { ...pair[dir], pricingKey } } as RoundTripPair)
    price(dir, sides[dir].flight, pricingKey)
  }

  if (!sides) return <div style={s.page}><div className={lay.root}><PageLoader label="Opening your flights" /></div></div>

  const ready = sides.onward.priced && sides.return.priced
  const total = (sides.onward.priced?.sellTotal ?? 0) + (sides.return.priced?.sellTotal ?? 0)
  const busy = sides.onward.loading || sides.return.loading

  function continueToPassengers() {
    router.push(`/book/details/${encodeURIComponent(sides!.onward.flight.flightKey)}?pair=1`)
  }

  return (
    <div style={s.page}>
      <div className={lay.root}>
        <Link href={resultsHref} style={s.backLink}>← Back to results</Link>
        <div style={{ marginBottom: 18 }}>
          <h1 style={s.heading}>Your round trip</h1>
          <p style={s.sub}>Two flights, each priced and booked on its own. You fill in passenger details once for both.</p>
        </div>

        <div className={lay.layout}>
        <div className={lay.main}>
        {(['onward', 'return'] as const).map(dir => {
          const side = sides[dir]
          const f = side.flight
          const j = journeysOf(f)[0]
          const code = (f.airline?.code ?? f.legs?.[0]?.airlineCode ?? '').toUpperCase()
          const meta = side.verdict?.ok && side.verdict.verdict ? VERDICT_META[side.verdict.verdict] : null
          return (
            <section key={dir} style={s.card} aria-label={dir === 'onward' ? 'Onward flight' : 'Return flight'}>
              <div style={s.cardTop}>
                <div style={s.carrier}>
                  <AirlineMark code={code} name={f.airline?.name} />
                  <div>
                    <div style={s.dirLabel}>{dir === 'onward' ? 'Onward' : 'Return'} · {day(j?.origin?.dateTime)}</div>
                    <div style={s.flightLine}>
                      {f.airline?.name ?? code} {(f.legs ?? []).map(l => `${l.airlineCode ?? ''} ${l.flightNumber ?? ''}`.trim()).join(' · ')}
                    </div>
                    <div style={s.timeLine}>
                      {clock(j?.origin?.dateTime)} {j?.origin?.code} → {clock(j?.destination?.dateTime)} {j?.destination?.code}
                      {' · '}{(j?.stopCount ?? 0) === 0 ? 'Non-stop' : `${j?.stopCount} stop${(j?.stopCount ?? 0) > 1 ? 's' : ''}`}
                    </div>
                  </div>
                </div>
              </div>

              {/* Every fare of this flight, with what it includes; choosing one prices it. */}
              <FareRow flight={f} selectedKey={side.pricingKey} busy={side.loading}
                label={`${dir === 'onward' ? 'Onward' : 'Return'} fares`}
                onPick={o => { if (o.pricingKey !== side.pricingKey) changeFare(dir, o.pricingKey) }} />

              {side.loading && <p style={s.muted}>Confirming the live fare with the airline…</p>}
              {side.error && <div style={s.error}>{side.error}</div>}
              {side.priced && (
                <div style={s.lines}>
                  <div style={s.line}><span>Fare</span><span>{inr(side.priced.totalFare)}</span></div>
                  {side.lines.map(l => (
                    <div key={l.source} style={s.line}><span>{l.label}</span><span>{l.sign < 0 ? '−' : '+'}{inr(l.amount)}</span></div>
                  ))}
                  <div style={{ ...s.line, ...s.lineTotal }}><span>You pay for this flight</span><span>{inr(side.priced.sellTotal ?? side.priced.totalFare)}</span></div>
                </div>
              )}
              {meta && (
                <div style={{ ...s.verdict, color: meta.color, background: meta.bg, borderColor: meta.border }}>
                  <b>{meta.label}</b>{side.verdict?.reason && side.verdict.verdict !== 'green' ? ` · ${side.verdict.reason}` : ''}
                </div>
              )}
              {/* This flight's own rules: each booking of the pair is cancelled on its own. */}
              {(side.loading || side.priced) && (
                <FareRulesPanel rules={side.fareRules} loading={side.loading || !!side.rulesLoading} compact embedded
                  problem={side.rulesProblem ?? null}
                  onRetry={side.priced ? () => askRules(dir, side.priced!) : undefined} />
              )}
            </section>
          )
        })}

        </div>

        {/* The summary, in view while the two flights scroll. */}
        <aside className={lay.side} aria-label="Price summary">
          <div style={s.summary}>
            <h2 style={s.summaryTitle}>Price summary</h2>
            {(['onward', 'return'] as const).map(dir => {
              const side = sides[dir]
              const j = journeysOf(side.flight)[0]
              const fare = side.flight.fareOptions.findIndex(o => o.pricingKey === side.pricingKey)
              const meta = side.verdict?.ok && side.verdict.verdict ? VERDICT_META[side.verdict.verdict] : null
              return (
                <div key={dir} style={s.summaryFlight}>
                  <span style={s.dirLabel}>{dir === 'onward' ? 'Onward' : 'Return'} · {day(j?.origin?.dateTime)}</span>
                  <b style={s.summaryName}>
                    {side.flight.airline?.name ?? side.flight.airline?.code} · {fare >= 0 ? fareName(side.flight.fareOptions[fare], fare) : 'Fare'}
                  </b>
                  <div style={s.summaryLine}>
                    <span>{j?.origin?.code} → {j?.destination?.code} · {clock(j?.origin?.dateTime)}</span>
                    <span>{side.loading ? '…' : side.priced ? inr(side.priced.sellTotal ?? side.priced.totalFare) : '—'}</span>
                  </div>
                  {meta && <span style={{ ...s.summaryVerdict, color: meta.color, background: meta.bg, borderColor: meta.border }}>{meta.label}</span>}
                </div>
              )
            })}
            <div style={s.summaryTotal}>
              <span>Total, 2 bookings</span>
              <b>{ready ? inr(total) : '—'}</b>
            </div>
            <button type="button" onClick={continueToPassengers} disabled={!ready || busy} style={{ ...s.primaryBtn, opacity: !ready || busy ? 0.5 : 1 }}>
              Continue to passengers
            </button>
            <p style={s.note}>
              One approval covers both flights. Each is ticketed on its own, and either can be cancelled later without the other.
            </p>
          </div>
        </aside>
        </div>
      </div>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  page: { background: '#F9FAFB', minHeight: '100vh' },
  backLink: { fontSize: '13px', color: '#6B7280', textDecoration: 'none', display: 'inline-block', marginBottom: '16px' },
  heading: { fontSize: '24px', fontWeight: 700, color: '#0A0A14', margin: '0 0 6px', letterSpacing: '-0.4px' },
  sub: { fontSize: '13px', color: '#6B7280', margin: 0, lineHeight: 1.5 },
  card: { background: '#fff', border: '1px solid #E5E7EB', borderRadius: '14px', padding: '20px 22px', marginBottom: '16px', display: 'flex', flexDirection: 'column', gap: 14 },
  cardTop: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' },
  carrier: { display: 'flex', gap: 12, alignItems: 'center', minWidth: 0 },
  dirLabel: { fontSize: 10.5, fontWeight: 700, color: '#9CA3AF', textTransform: 'uppercase', letterSpacing: '0.5px' },
  flightLine: { fontSize: 15, fontWeight: 600, color: '#111827', marginTop: 2 },
  timeLine: { fontSize: 14, color: '#374151', marginTop: 2, fontVariantNumeric: 'tabular-nums' },
  muted: { fontSize: 13, color: '#6B7280', margin: 0 },
  error: { fontSize: 13, color: '#B91C1C', background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8, padding: '9px 12px' },
  lines: { display: 'flex', flexDirection: 'column', gap: 4, borderTop: '1px solid #F3F4F6', paddingTop: 10 },
  line: { display: 'flex', justifyContent: 'space-between', fontSize: 13, color: '#374151', fontVariantNumeric: 'tabular-nums' },
  lineTotal: { fontWeight: 700, color: '#111827', borderTop: '1px solid #F3F4F6', paddingTop: 6, marginTop: 2 },
  verdict: { fontSize: 12.5, border: '1px solid', borderRadius: 8, padding: '8px 12px', lineHeight: 1.45 },
  summary: { background: '#fff', border: '1px solid #E5E7EB', borderRadius: 14, padding: 20, display: 'flex', flexDirection: 'column', gap: 12 },
  summaryTitle: { fontSize: 15, fontWeight: 600, color: '#111827', margin: 0 },
  summaryFlight: { display: 'flex', flexDirection: 'column', gap: 3, paddingBottom: 12, borderBottom: '1px solid #F3F4F6' },
  summaryName: { fontSize: 13.5, color: '#111827' },
  summaryLine: { display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 13, color: '#374151', fontVariantNumeric: 'tabular-nums' },
  summaryVerdict: { alignSelf: 'flex-start', marginTop: 4, fontSize: 11.5, fontWeight: 600, borderWidth: 1, borderStyle: 'solid', borderRadius: 6, padding: '2px 8px' },
  summaryTotal: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, fontSize: 14.5, fontWeight: 700, color: '#111827' },
  primaryBtn: { height: 48, background: '#000835', color: '#fff', border: 0, borderRadius: 11, fontWeight: 700, fontSize: 15, cursor: 'pointer' },
  note: { fontSize: 12, color: '#6B7280', margin: 0, lineHeight: 1.5 },
}
