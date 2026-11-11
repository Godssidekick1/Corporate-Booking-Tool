'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import AirlineMark from '@/app/components/AirlineMark'
import { flowStorage, type PricedFare, type RoundTripPair } from '@/app/lib/book/flowStorage'
import { priceFare, previewPolicy, type PolicyPreview, type PricedLine } from '@/app/lib/book/priceFare'
import { VERDICT_META } from '@/app/lib/policy/verdictLabels'
import { journeysOf, type FareOption, type FlatFlightResult } from '@/app/lib/book/types'

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
}

const inr = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`
const clock = (iso?: string) => /T(\d{2}:\d{2})/.exec(iso ?? '')?.[1] ?? '—'
const day = (iso?: string) => {
  const d = /^(\d{4}-\d{2}-\d{2})/.exec(iso ?? '')?.[1]
  return d ? new Date(`${d}T00:00:00`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' }) : ''
}
const fareName = (o: FareOption, i: number) => o.brandedFareName || o.fareType || `Fare ${i + 1}`

export default function RoundTripFarePage() {
  const router = useRouter()
  const [sides, setSides] = useState<Record<Dir, Side> | null>(null)

  const patch = useCallback((dir: Dir, change: Partial<Side>) =>
    setSides(prev => (prev ? { ...prev, [dir]: { ...prev[dir], ...change } } : prev)), [])

  const price = useCallback(async (dir: Dir, flight: FlatFlightResult, pricingKey: string) => {
    patch(dir, { loading: true, error: '', priced: null, verdict: null, pricingKey })
    const fare = flight.fareOptions.find(o => o.pricingKey === pricingKey) ?? flight.fareOptions[0]
    const outcome = await priceFare(flight, fare)
    if (!outcome.ok) { patch(dir, { loading: false, error: outcome.error }); return }
    patch(dir, { loading: false, priced: outcome.priced, lines: outcome.lines })
    patch(dir, { verdict: await previewPolicy(flight, outcome.priced) })
  }, [patch])

  useEffect(() => {
    const pair = flowStorage.getPair()
    const onward = pair && flowStorage.findResultByFlightKey(pair.onward.flightKey)
    const back = pair && flowStorage.findResultByFlightKey(pair.return.flightKey)
    // Only reachable by picking both flights on the results page.
    if (!pair || !onward || !back) { router.replace('/book/flights'); return }
    const side = (flight: FlatFlightResult, pricingKey: string): Side =>
      ({ flight, pricingKey, loading: true, error: '', priced: null, lines: [], verdict: null })
    // Seeding this page's state from what the results page kept, once.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSides({ onward: side(onward, pair.onward.pricingKey), return: side(back, pair.return.pricingKey) })
    price('onward', onward, pair.onward.pricingKey)
    price('return', back, pair.return.pricingKey)
  }, [router, price])

  function changeFare(dir: Dir, pricingKey: string) {
    if (!sides) return
    const pair = flowStorage.getPair()
    if (pair) flowStorage.savePair({ ...pair, [dir]: { ...pair[dir], pricingKey } } as RoundTripPair)
    price(dir, sides[dir].flight, pricingKey)
  }

  if (!sides) return <div style={s.page}><div style={s.root}><p style={s.sub}>Loading your flights…</p></div></div>

  const ready = sides.onward.priced && sides.return.priced
  const total = (sides.onward.priced?.sellTotal ?? 0) + (sides.return.priced?.sellTotal ?? 0)
  const busy = sides.onward.loading || sides.return.loading

  function continueToPassengers() {
    router.push(`/book/details/${encodeURIComponent(sides!.onward.flight.flightKey)}?pair=1`)
  }

  return (
    <div style={s.page}>
      <div style={s.root}>
        <Link href="/book/flights" style={s.backLink}>← Back to results</Link>
        <div style={{ marginBottom: 18 }}>
          <h1 style={s.heading}>Your round trip</h1>
          <p style={s.sub}>Two flights, each priced and booked on its own. You fill in passenger details once for both.</p>
        </div>

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
                <label style={s.fareSelect}>
                  <span>Fare</span>
                  <select value={side.pricingKey} disabled={side.loading} onChange={e => changeFare(dir, e.target.value)}>
                    {f.fareOptions.map((o, i) => (
                      <option key={o.pricingKey} value={o.pricingKey}>
                        {fareName(o, i)} · {inr(o.sellEstimate ?? o.totalFare ?? 0)}{o.refundable ? ' · refundable' : ''}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

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
            </section>
          )
        })}

        <div style={s.totalBar}>
          <div>
            <div style={s.totalLabel}>Total, 2 bookings</div>
            <div style={s.totalAmount}>{ready ? inr(total) : '—'}</div>
          </div>
          <button type="button" onClick={continueToPassengers} disabled={!ready || busy} style={{ ...s.primaryBtn, opacity: !ready || busy ? 0.5 : 1 }}>
            Continue to passengers
          </button>
        </div>
        <p style={s.note}>
          One approval covers both flights. Each is ticketed on its own, and either can be cancelled later without the other.
        </p>
      </div>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  page: { background: '#F9FAFB', minHeight: '100vh' },
  root: { maxWidth: '820px', margin: '0 auto', padding: '32px 24px 64px' },
  backLink: { fontSize: '13px', color: '#6B7280', textDecoration: 'none', display: 'inline-block', marginBottom: '16px' },
  heading: { fontSize: '22px', fontWeight: 700, color: '#0A0A14', margin: '0 0 6px', letterSpacing: '-0.4px' },
  sub: { fontSize: '13px', color: '#6B7280', margin: 0, lineHeight: 1.5 },
  card: { background: '#fff', border: '1px solid #E5E7EB', borderRadius: '14px', padding: '18px 20px', marginBottom: '14px', display: 'flex', flexDirection: 'column', gap: 12 },
  cardTop: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' },
  carrier: { display: 'flex', gap: 12, alignItems: 'center', minWidth: 0 },
  dirLabel: { fontSize: 10.5, fontWeight: 700, color: '#9CA3AF', textTransform: 'uppercase', letterSpacing: '0.5px' },
  flightLine: { fontSize: 14, fontWeight: 600, color: '#111827', marginTop: 2 },
  timeLine: { fontSize: 13, color: '#374151', marginTop: 2, fontVariantNumeric: 'tabular-nums' },
  fareSelect: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, fontWeight: 600, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.4px', minWidth: 220 },
  muted: { fontSize: 13, color: '#6B7280', margin: 0 },
  error: { fontSize: 13, color: '#B91C1C', background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8, padding: '9px 12px' },
  lines: { display: 'flex', flexDirection: 'column', gap: 4, borderTop: '1px solid #F3F4F6', paddingTop: 10 },
  line: { display: 'flex', justifyContent: 'space-between', fontSize: 13, color: '#374151', fontVariantNumeric: 'tabular-nums' },
  lineTotal: { fontWeight: 700, color: '#111827', borderTop: '1px solid #F3F4F6', paddingTop: 6, marginTop: 2 },
  verdict: { fontSize: 12.5, border: '1px solid', borderRadius: 8, padding: '8px 12px', lineHeight: 1.45 },
  totalBar: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, background: '#000835', color: '#fff', borderRadius: 14, padding: '14px 20px', marginTop: 6, flexWrap: 'wrap' },
  totalLabel: { fontSize: 11, fontWeight: 600, color: '#AAB0D6', textTransform: 'uppercase', letterSpacing: '0.4px' },
  totalAmount: { fontSize: 22, fontWeight: 700, fontVariantNumeric: 'tabular-nums' },
  primaryBtn: { background: '#fff', color: '#000835', border: 0, borderRadius: 10, padding: '11px 20px', fontWeight: 700, fontSize: 14, cursor: 'pointer' },
  note: { fontSize: 12, color: '#6B7280', marginTop: 10, lineHeight: 1.5 },
}
