'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { flowStorage } from '@/app/lib/book/flowStorage'
import { FlatFlightResult, formatTime, formatDayLabel } from '@/app/lib/book/types'

interface PriceApiResult {
  ok: boolean
  reason?: string
  error?: string
  referenceNo?: string
  totalFare?: number
  baseFare?: number
  tax?: number
  currency?: string
  isRefundable?: boolean
  fareType?: string
  passengerBreakup?: {
    PaxType: string
    BaseFare: number
    Tax: number
    TotalFare: number
  }[]
}

export default function PriceConfirmPage() {
  const router = useRouter()
  const params = useParams<{ flightKey: string }>()
  const flightKey = decodeURIComponent(params.flightKey)

  const [flight, setFlight] = useState<FlatFlightResult | null>(null)
  const [pricing, setPricing] = useState<PriceApiResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [continuing, setContinuing] = useState(false)

  useEffect(() => {
    const stored = flowStorage.findResultByFlightKey(flightKey)

    if (!stored) {
      // sessionStorage doesn't have this — either a stale link/refresh long
      // after the tab's results expired, or the flightKey is just wrong.
      // Either way, there's no flight data to price, so send back to search
      // rather than showing a broken page.
      setError('This flight is no longer available to price. Please search again.')
      setLoading(false)
      return
    }

    setFlight(stored)
    runPricing(stored)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flightKey])

  async function runPricing(flightResult: FlatFlightResult) {
    setLoading(true)
    setError('')

    const searchData = flowStorage.getSearchResults()

    if (!searchData?.availabilityKey || !searchData?.sessionId || !flightResult.pricingKey) {
  setError('Missing pricing details for this flight — please search again.')
  setLoading(false)
  return
}

    try {
      const res = await fetch('/api/book/price', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    key: flightResult.flightKey,
    pricingKey: flightResult.pricingKey,
    provider: flightResult.provider,
    resultIndex: flightResult.itemNo,
    sessionId: searchData.sessionId,   // NEW
  }),
})
      const data: PriceApiResult = await res.json()

      if (!data.ok) {
        setError(data.error || 'This fare is no longer available. Please select a different flight.')
        setPricing(null)
        return
      }

      setPricing(data)

      // Save the priced fare — passengers page needs referenceNo, totalFare,
      // etc. and shouldn't have to re-price to get them.
      flowStorage.savePricedFare({
        flightKey: flightResult.flightKey,
        pricingKey: flightResult.pricingKey!,
        provider: flightResult.provider,
        referenceNo: data.referenceNo!,
        totalFare: data.totalFare!,
        baseFare: data.baseFare!,
        tax: data.tax!,
        currency: data.currency!,
        isRefundable: data.isRefundable!,
        fareType: data.fareType!,
        passengerBreakup: data.passengerBreakup,
        isNdc: flightResult.isNdc,
        searchKey: searchData.availabilityKey ?? undefined,
      })
    } catch {
      setError('Something went wrong confirming this fare. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  function handleContinue() {
    setContinuing(true)
    router.push(`/book/passengers/${encodeURIComponent(flightKey)}`)
  }

  return (
    <div style={s.page}>
      <div style={s.root}>
        <Link href="/book" style={s.backLink}>← Back to results</Link>

        <div style={s.header}>
          <h1 style={s.heading}>Confirm your fare</h1>
          <p style={s.sub}>Prices can change between search and booking — this locks in the real fare for this flight.</p>
        </div>

        {loading && (
          <div style={s.loadingCard}>
            <div style={s.spinner} />
            <p style={s.loadingText}>Confirming live price with the airline…</p>
          </div>
        )}

        {!loading && error && (
          <div style={s.errorCard}>
            <p style={s.errorTitle}>⚠ {error}</p>
            <Link href="/book" style={s.errorLink}>← Search again</Link>
          </div>
        )}

        {!loading && !error && flight && pricing?.ok && (
          <>
            {/* ── Flight summary ─────────────────────────────────────── */}
            <div style={s.card}>
              <div style={s.cardHeader}>
                <div style={s.airlineBlock}>
                  <div style={s.airlineAvatar}>{flight.airline?.name?.[0] ?? '✈'}</div>
                  <div>
                    <div style={s.airlineName}>{flight.airline?.name ?? 'Unknown airline'}</div>
                    <div style={s.airlineMeta}>
                      {flight.airline?.code} · {flight.cabin ?? 'Economy'}
                      {flight.isNdc && <span style={s.ndcTag}>NDC fare</span>}
                    </div>
                  </div>
                </div>
              </div>

              <div style={s.routeRow}>
                <div style={s.routePoint}>
                  <span style={s.routeTime}>{formatTime(flight.origin?.dateTime)}</span>
                  <span style={s.routeCode}>{flight.origin?.code}</span>
                  <span style={s.routeDay}>{formatDayLabel(flight.origin?.dateTime)}</span>
                </div>
                <div style={s.routeMiddle}>
                  <span style={s.routeDuration}>{flight.duration ?? ''}</span>
                  <div style={s.routeLine} />
                  <span style={s.routeStops}>
                    {flight.stopCount === 0 ? 'Non-stop' : flight.stops.map(st => `via ${st.city}`).join(', ')}
                  </span>
                </div>
                <div style={{ ...s.routePoint, alignItems: 'flex-end' as const }}>
                  <span style={s.routeTime}>{formatTime(flight.destination?.dateTime)}</span>
                  <span style={s.routeCode}>{flight.destination?.code}</span>
                  <span style={s.routeDay}>{formatDayLabel(flight.destination?.dateTime)}</span>
                </div>
              </div>

              <div style={s.metaTags}>
                <span style={{ ...s.tag, ...(flight.isLcc ? s.tagBudget : s.tagFullService) }}>
                  {flight.isLcc ? 'Budget carrier' : 'Full-service'}
                </span>
                {flight.checkInBaggageKg && <span style={s.tag}>{flight.checkInBaggageKg}kg check-in</span>}
              </div>
            </div>

            {/* ── Fare breakdown ─────────────────────────────────────── */}
            <div style={s.card}>
              <h2 style={s.cardTitle}>Fare breakdown</h2>

              <div style={s.fareRow}>
                <span style={s.fareLabel}>Base fare</span>
                <span style={s.fareValue}>{pricing.currency} {pricing.baseFare?.toLocaleString('en-IN')}</span>
              </div>
              <div style={s.fareRow}>
                <span style={s.fareLabel}>Taxes & fees</span>
                <span style={s.fareValue}>{pricing.currency} {pricing.tax?.toLocaleString('en-IN')}</span>
              </div>
              <div style={{ ...s.fareRow, ...s.fareRowTotal }}>
                <span style={s.fareTotalLabel}>Total fare</span>
                <span style={s.fareTotalValue}>{pricing.currency} {pricing.totalFare?.toLocaleString('en-IN')}</span>
              </div>

              {pricing.passengerBreakup && pricing.passengerBreakup.length > 1 && (
                <div style={s.paxBreakup}>
                  <p style={s.paxBreakupTitle}>Per passenger</p>
                  {pricing.passengerBreakup.map((pax, i) => (
                    <div key={i} style={s.paxRow}>
                      <span style={s.paxType}>{pax.PaxType}</span>
                      <span style={s.paxFare}>{pricing.currency} {pax.TotalFare?.toLocaleString('en-IN')}</span>
                    </div>
                  ))}
                </div>
              )}

              <div style={s.fareTags}>
                <span style={{ ...s.tag, color: pricing.isRefundable ? '#065F46' : '#9CA3AF', background: pricing.isRefundable ? '#ECFDF5' : '#F3F4F6' }}>
                  {pricing.isRefundable ? 'Refundable' : 'Non-refundable'}
                </span>
                {pricing.fareType && <span style={s.tag}>{pricing.fareType}</span>}
              </div>
            </div>

            <button
              type="button"
              onClick={handleContinue}
              disabled={continuing}
              style={{ ...s.continueBtn, opacity: continuing ? 0.7 : 1 }}
            >
              {continuing ? 'Opening…' : 'Continue to passenger details →'}
            </button>
          </>
        )}
      </div>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  page: { background: '#F9FAFB', minHeight: '100vh' },
  root: { fontFamily: "'Inter', -apple-system, sans-serif", maxWidth: '640px', margin: '0 auto', padding: '32px 24px 64px' },

  backLink: { fontSize: '13px', color: '#6B7280', textDecoration: 'none', display: 'inline-block', marginBottom: '16px' },

  header: { marginBottom: '20px' },
  heading: { fontSize: '22px', fontWeight: 700, color: '#0A0A14', margin: '0 0 6px', letterSpacing: '-0.4px' },
  sub: { fontSize: '13px', color: '#6B7280', margin: 0, lineHeight: 1.5 },

  loadingCard: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '14px', padding: '56px 20px', background: '#fff', border: '1px solid #E5E7EB', borderRadius: '14px' },
  spinner: { width: '22px', height: '22px', border: '2.5px solid #E5E7EB', borderTopColor: '#000835', borderRadius: '50%' },
  loadingText: { fontSize: '13px', color: '#6B7280', margin: 0 },

  errorCard: { padding: '20px', background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: '14px' },
  errorTitle: { fontSize: '13px', color: '#DC2626', margin: '0 0 10px', lineHeight: 1.5 },
  errorLink: { fontSize: '13px', color: '#DC2626', fontWeight: 600, textDecoration: 'underline' },

  card: { background: '#fff', border: '1px solid #E5E7EB', borderRadius: '14px', padding: '20px', marginBottom: '16px' },
  cardHeader: { marginBottom: '14px' },
  cardTitle: { fontSize: '14px', fontWeight: 600, color: '#111827', margin: '0 0 16px' },

  airlineBlock: { display: 'flex', alignItems: 'center', gap: '10px' },
  airlineAvatar: { width: '34px', height: '34px', borderRadius: '9px', background: '#EEF2FF', color: '#3730A3', fontSize: '14px', fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  airlineName: { fontSize: '13px', fontWeight: 600, color: '#111827' },
  airlineMeta: { fontSize: '11px', color: '#9CA3AF', display: 'flex', alignItems: 'center', gap: '6px', marginTop: '2px' },
  ndcTag: { fontSize: '9px', fontWeight: 700, color: '#3730A3', background: '#EEF2FF', padding: '1px 6px', borderRadius: '4px', letterSpacing: '0.3px' },

  routeRow: { display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '14px', padding: '14px 0', borderTop: '1px solid #F3F4F6', borderBottom: '1px solid #F3F4F6' },
  routePoint: { display: 'flex', flexDirection: 'column', gap: '2px', flex: '0 0 auto', minWidth: '58px' },
  routeTime: { fontSize: '16px', fontWeight: 700, color: '#111827' },
  routeCode: { fontSize: '11px', fontWeight: 600, color: '#6B7280' },
  routeDay: { fontSize: '10px', color: '#9CA3AF' },
  routeMiddle: { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px' },
  routeDuration: { fontSize: '10px', color: '#9CA3AF', fontWeight: 500 },
  routeLine: { width: '100%', height: '1px', background: '#D1D5DB' },
  routeStops: { fontSize: '10px', color: '#9CA3AF' },

  metaTags: { display: 'flex', gap: '6px', flexWrap: 'wrap' as const },
  tag: { fontSize: '10px', color: '#6B7280', background: '#F3F4F6', padding: '3px 9px', borderRadius: '5px', fontWeight: 500 },
  tagBudget: { color: '#7C2D12', background: '#FFF7ED' },
  tagFullService: { color: '#14532D', background: '#F0FDF4' },

  fareRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0' },
  fareLabel: { fontSize: '13px', color: '#6B7280' },
  fareValue: { fontSize: '13px', color: '#111827', fontWeight: 500 },
  fareRowTotal: { borderTop: '1px solid #F3F4F6', marginTop: '4px', paddingTop: '12px' },
  fareTotalLabel: { fontSize: '14px', fontWeight: 700, color: '#111827' },
  fareTotalValue: { fontSize: '18px', fontWeight: 700, color: '#0A0A14' },

  paxBreakup: { marginTop: '12px', paddingTop: '12px', borderTop: '1px dashed #E5E7EB' },
  paxBreakupTitle: { fontSize: '11px', fontWeight: 600, color: '#9CA3AF', textTransform: 'uppercase', letterSpacing: '0.4px', margin: '0 0 8px' },
  paxRow: { display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: '12px' },
  paxType: { color: '#6B7280' },
  paxFare: { color: '#111827', fontWeight: 500 },

  fareTags: { display: 'flex', gap: '6px', marginTop: '14px' },

  continueBtn: {
    height: '48px', width: '100%', background: '#000835', color: '#fff', fontSize: '14px', fontWeight: 700,
    border: 'none', borderRadius: '10px', cursor: 'pointer', letterSpacing: '0.2px',
  },
}