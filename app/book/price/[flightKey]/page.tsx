'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { flowStorage } from '@/app/lib/book/flowStorage'
import { FlatFlightResult, FareOption, formatTime, formatDayLabel } from '@/app/lib/book/types'

// ── /book/price/[flightKey] — Step 2: Select fare ─────────────────────────────
// Merges what used to be two separate concepts into one screen:
//   1. Fare details already available from the Availability response
//      (baggage, fare basis, terminals, cancellation/change penalties, fare
//      type, refundability) — shown immediately, no extra API call.
//   2. Pricing — locks the live fare with the airline (unchanged from
//      before: same /api/book/price call, same flowStorage.savePricedFare).
//
// These run at the same time rather than gating one behind the other: fare
// details render the instant the page loads (from sessionStorage), while
// Pricing confirms in the background. If Pricing comes back with a
// different total than what search showed, the live number wins — search
// results are always provisional, Pricing is the source of truth.
//
// Fare options: today's real Amadeus responses only ever contain one
// PricingInfo per flight (confirmed against UAT), but the underlying shape
// is an array and production may return more than one — so this renders
// however many fareOptions actually exist, defaulting to the first when
// there's only one, rather than assuming there's exactly one.
// ─────────────────────────────────────────────────────────────────────────────

interface PriceApiResult {
  ok: boolean
  reason?: string
  error?: string
  key?: string
  referenceNo?: string
  totalFare?: number
  baseFare?: number
  tax?: number
  currency?: string
  isRefundable?: boolean
  fareType?: string
  fareBasis?: string
  changePenalties?: { paxType: string; text: string }[]
  cancelPenalties?: { paxType: string; text: string }[]
  passengerBreakup?: {
    PaxType: string
    BaseFare: number
    Tax: number
    TotalFare: number
  }[]
}

function penaltySummary(lines: { paxType: string; text: string }[] | undefined): string | null {
  if (!lines || lines.length === 0) return null
  // Real responses show the same penalty text repeated per PaxType (ADT/CHD
  // both "INR3000", INF "0") far more often than genuinely different
  // amounts per type — collapsing to the adult figure keeps this readable
  // instead of listing three near-identical lines for a single-traveler
  // search. If they DO differ, showing all of them would be the more
  // correct choice, but that's not been seen in any real response yet.
  const adult = lines.find(l => l.paxType === 'ADT')
  return (adult ?? lines[0]).text || '—'
}

export default function SelectFarePage() {
  const router = useRouter()
  const params = useParams<{ flightKey: string }>()
  const flightKey = decodeURIComponent(params.flightKey)

  const [flight, setFlight] = useState<FlatFlightResult | null>(null)
  const [selectedFareIndex, setSelectedFareIndex] = useState(0)
  const [pricing, setPricing] = useState<PriceApiResult | null>(null)
  const [pricingLoading, setPricingLoading] = useState(true)
  const [error, setError] = useState('')
  const [continuing, setContinuing] = useState(false)

  useEffect(() => {
    const stored = flowStorage.findResultByFlightKey(flightKey)

    if (!stored) {
      // sessionStorage doesn't have this — either a stale link/refresh long
      // after the tab's results expired, or the flightKey is just wrong.
      // Either way, there's no flight data to show, so send back to search
      // rather than showing a broken page.
      setError('This flight is no longer available. Please search again.')
      setPricingLoading(false)
      return
    }

    setFlight(stored)
    runPricing(stored, 0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flightKey])

  async function runPricing(flightResult: FlatFlightResult, fareIndex: number) {
    setPricingLoading(true)
    setError('')

    const searchData = flowStorage.getSearchResults()
    const fareOption = flightResult.fareOptions[fareIndex] as FareOption | undefined
    const pricingKey = fareOption?.pricingKey ?? flightResult.pricingKey

    if (!searchData?.availabilityKey || !pricingKey) {
      setError('Missing pricing details for this flight — please search again.')
      setPricingLoading(false)
      return
    }

    try {
      const res = await fetch('/api/book/price', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key: searchData.availabilityKey,
          pricingKey,
          provider: flightResult.provider,
          resultIndex: flightResult.itemNo,
        }),
      })
      const data: PriceApiResult = await res.json()

      if (!data.ok) {
        setError(data.error || 'This fare is no longer available. Please select a different flight.')
        setPricing(null)
        return
      }

      setPricing(data)

      // Save the priced fare — the next step needs referenceNo, totalFare,
      // etc. and shouldn't have to re-price to get them.
      flowStorage.savePricedFare({
        flightKey: flightResult.flightKey,
        key: data.key!,
        pricingKey: pricingKey!,
        provider: flightResult.provider,
        referenceNo: data.referenceNo!,
        totalFare: data.totalFare!,
        baseFare: data.baseFare!,
        tax: data.tax!,
        currency: data.currency!,
        isRefundable: data.isRefundable!,
        fareType: data.fareType!,
        passengerBreakup: data.passengerBreakup,
        isNdc: fareOption?.isNdc ?? flightResult.isNdc,
        searchKey: searchData.availabilityKey ?? undefined,
      })
    } catch {
      setError('Something went wrong confirming this fare. Please try again.')
    } finally {
      setPricingLoading(false)
    }
  }

  function handleSelectFareOption(index: number) {
    if (!flight || index === selectedFareIndex) return
    setSelectedFareIndex(index)
    runPricing(flight, index)
  }

  function handleContinue() {
    setContinuing(true)
    router.push(`/book/seats/${encodeURIComponent(flightKey)}`)
  }

  if (error && !flight) {
    return (
      <div style={s.page}>
        <div style={s.root}>
          <Link href="/book/flights" style={s.backLink}>← Back to results</Link>
          <div style={s.errorCard}>
            <p style={s.errorTitle}>⚠ {error}</p>
            <Link href="/book/flights" style={s.errorLink}>← Search again</Link>
          </div>
        </div>
      </div>
    )
  }

  if (!flight) {
    return (
      <div style={s.page}>
        <div style={s.root}>
          <div style={s.loadingCard}><div style={s.spinner} /></div>
        </div>
      </div>
    )
  }

  const hasMultipleFares = flight.fareOptions.length > 1
  const activeFare = flight.fareOptions[selectedFareIndex] as FareOption | undefined
  const changePenalty = penaltySummary(pricing?.changePenalties ?? activeFare?.changePenalties)
  const cancelPenalty = penaltySummary(pricing?.cancelPenalties ?? activeFare?.cancelPenalties)
  const fareBasis = pricing?.fareBasis ?? activeFare?.fareBasis

  return (
    <div style={s.page}>
      <div style={s.root}>
        <Link href="/book/flights" style={s.backLink}>← Back to results</Link>

        <div style={s.header}>
          <h1 style={s.heading}>Select your fare</h1>
          <p style={s.sub}>Review the fare details, then confirm to lock in the live price.</p>
        </div>

        {/* ── Flight summary — available instantly, no API call ─────── */}
        <div style={s.card}>
          <div style={s.cardHeader}>
            <div style={s.airlineBlock}>
              <div style={s.airlineAvatar}>{flight.airline?.name?.[0] ?? '✈'}</div>
              <div>
                <div style={s.airlineName}>{flight.airline?.name ?? 'Unknown airline'}</div>
                <div style={s.airlineMeta}>
                  {flight.airline?.code} · {flight.cabin ?? 'Economy'}
                  {(activeFare?.isNdc ?? flight.isNdc) && <span style={s.ndcTag}>NDC fare</span>}
                </div>
              </div>
            </div>
          </div>

          <div style={s.routeRow}>
            <div style={s.routePoint}>
              <span style={s.routeTime}>{formatTime(flight.origin?.dateTime)}</span>
              <span style={s.routeCode}>{flight.origin?.code}</span>
              {flight.origin?.terminal && <span style={s.routeTerminal}>Terminal {flight.origin.terminal}</span>}
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
              {flight.destination?.terminal && <span style={s.routeTerminal}>Terminal {flight.destination.terminal}</span>}
              <span style={s.routeDay}>{formatDayLabel(flight.destination?.dateTime)}</span>
            </div>
          </div>

          <div style={s.metaTags}>
            <span style={{ ...s.tag, ...(flight.isLcc ? s.tagBudget : s.tagFullService) }}>
              {flight.isLcc ? 'Budget carrier' : 'Full-service'}
            </span>
            {flight.checkInBaggageKg && <span style={s.tag}>{flight.checkInBaggageKg}kg check-in baggage</span>}
            {flight.availableSeats != null && <span style={s.tag}>{flight.availableSeats} seats left</span>}
          </div>
        </div>

        {/* ── Fare option picker — only shown if more than one exists ── */}
        {hasMultipleFares && (
          <div style={s.card}>
            <h2 style={s.cardTitle}>Choose a fare</h2>
            <div style={s.fareOptionList}>
              {flight.fareOptions.map((fare, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => handleSelectFareOption(i)}
                  style={{ ...s.fareOptionCard, ...(i === selectedFareIndex ? s.fareOptionCardActive : {}) }}
                >
                  <span style={s.fareOptionType}>{fare.fareType ?? `Fare ${i + 1}`}</span>
                  <span style={s.fareOptionPrice}>{fare.currency} {fare.totalFare?.toLocaleString('en-IN')}</span>
                  <span style={{ ...s.fareOptionRefund, color: fare.refundable ? '#166534' : '#9CA3AF' }}>
                    {fare.refundable ? 'Refundable' : 'Non-refundable'}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* ── Fare rules — fare basis, baggage, penalties ─────────────── */}
        <div style={s.card}>
          <h2 style={s.cardTitle}>Fare rules</h2>
          <div style={s.rulesGrid}>
            {fareBasis && (
              <div style={s.ruleRow}>
                <span style={s.ruleLabel}>Fare basis</span>
                <span style={s.ruleValue}>{fareBasis}</span>
              </div>
            )}
            <div style={s.ruleRow}>
              <span style={s.ruleLabel}>Check-in baggage</span>
              <span style={s.ruleValue}>{flight.checkInBaggageKg ? `${flight.checkInBaggageKg}kg` : 'Not specified'}</span>
            </div>
            <div style={s.ruleRow}>
              <span style={s.ruleLabel}>Change penalty</span>
              <span style={s.ruleValue}>{changePenalty ?? 'Not specified'}</span>
            </div>
            <div style={s.ruleRow}>
              <span style={s.ruleLabel}>Cancellation penalty</span>
              <span style={s.ruleValue}>{cancelPenalty ?? 'Not specified'}</span>
            </div>
          </div>
          <p style={s.rulesNote}>Penalties are set by the airline and shown as provided — they may vary by fare rule.</p>
        </div>

        {/* ── Fare breakdown — live from Pricing ──────────────────────── */}
        <div style={s.card}>
          <h2 style={s.cardTitle}>Fare breakdown</h2>

          {pricingLoading && (
            <div style={s.pricingLoadingRow}>
              <div style={s.spinnerSmall} />
              <span style={s.pricingLoadingText}>Confirming live price with the airline…</span>
            </div>
          )}

          {!pricingLoading && error && (
            <div style={s.inlineError}>
              <p style={s.inlineErrorText}>⚠ {error}</p>
            </div>
          )}

          {!pricingLoading && !error && pricing?.ok && (
            <>
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
            </>
          )}
        </div>

        <button
          type="button"
          onClick={handleContinue}
          disabled={continuing || pricingLoading || !pricing?.ok}
          style={{ ...s.continueBtn, opacity: (continuing || pricingLoading || !pricing?.ok) ? 0.6 : 1 }}
        >
          {continuing ? 'Opening…' : 'Select this fare →'}
        </button>
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

  loadingCard: { display: 'flex', justifyContent: 'center', padding: '80px 0' },
  spinner: { width: '22px', height: '22px', border: '2.5px solid #E5E7EB', borderTopColor: '#000835', borderRadius: '50%' },
  spinnerSmall: { width: '16px', height: '16px', border: '2px solid #E5E7EB', borderTopColor: '#000835', borderRadius: '50%' },

  errorCard: { padding: '20px', background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: '14px' },
  errorTitle: { fontSize: '13px', color: '#DC2626', margin: '0 0 10px', lineHeight: 1.5 },
  errorLink: { fontSize: '13px', color: '#DC2626', fontWeight: 600, textDecoration: 'underline' },

  inlineError: { padding: '12px 14px', background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: '10px' },
  inlineErrorText: { fontSize: '12.5px', color: '#DC2626', margin: 0 },

  pricingLoadingRow: { display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 0' },
  pricingLoadingText: { fontSize: '12.5px', color: '#6B7280' },

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
  routeTerminal: { fontSize: '9.5px', color: '#9CA3AF' },
  routeDay: { fontSize: '10px', color: '#9CA3AF' },
  routeMiddle: { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px' },
  routeDuration: { fontSize: '10px', color: '#9CA3AF', fontWeight: 500 },
  routeLine: { width: '100%', height: '1px', background: '#D1D5DB' },
  routeStops: { fontSize: '10px', color: '#9CA3AF' },

  metaTags: { display: 'flex', gap: '6px', flexWrap: 'wrap' as const },
  tag: { fontSize: '10px', color: '#6B7280', background: '#F3F4F6', padding: '3px 9px', borderRadius: '5px', fontWeight: 500 },
  tagBudget: { color: '#7C2D12', background: '#FFF7ED' },
  tagFullService: { color: '#14532D', background: '#F0FDF4' },

  fareOptionList: { display: 'flex', flexDirection: 'column' as const, gap: '8px' },
  fareOptionCard: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%',
    padding: '12px 14px', background: '#F9FAFB', border: '1.5px solid #E5E7EB', borderRadius: '10px', cursor: 'pointer',
    textAlign: 'left' as const,
  },
  fareOptionCardActive: { background: '#EEF2FF', borderColor: '#000835' },
  fareOptionType: { fontSize: '12.5px', fontWeight: 600, color: '#111827', flex: 1 },
  fareOptionPrice: { fontSize: '13px', fontWeight: 700, color: '#0A0A14', marginRight: '10px' },
  fareOptionRefund: { fontSize: '10.5px', fontWeight: 600 },

  rulesGrid: { display: 'flex', flexDirection: 'column' as const, gap: '2px' },
  ruleRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid #F9FAFB' },
  ruleLabel: { fontSize: '12.5px', color: '#6B7280' },
  ruleValue: { fontSize: '12.5px', color: '#111827', fontWeight: 600 },
  rulesNote: { fontSize: '10.5px', color: '#9CA3AF', margin: '12px 0 0', lineHeight: 1.5 },

  fareRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0' },
  fareLabel: { fontSize: '13px', color: '#6B7280' },
  fareValue: { fontSize: '13px', color: '#111827', fontWeight: 500 },
  fareRowTotal: { borderTop: '1px solid #F3F4F6', marginTop: '4px', paddingTop: '12px' },
  fareTotalLabel: { fontSize: '14px', fontWeight: 700, color: '#111827' },
  fareTotalValue: { fontSize: '18px', fontWeight: 700, color: '#0A0A14' },

  paxBreakup: { marginTop: '12px', paddingTop: '12px', borderTop: '1px dashed #E5E7EB' },
  paxBreakupTitle: { fontSize: '11px', fontWeight: 600, color: '#9CA3AF', textTransform: 'uppercase' as const, letterSpacing: '0.4px', margin: '0 0 8px' },
  paxRow: { display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: '12px' },
  paxType: { color: '#6B7280' },
  paxFare: { color: '#111827', fontWeight: 500 },

  fareTags: { display: 'flex', gap: '6px', marginTop: '14px' },

  continueBtn: {
    height: '48px', width: '100%', background: '#000835', color: '#fff', fontSize: '14px', fontWeight: 700,
    border: 'none', borderRadius: '10px', cursor: 'pointer', letterSpacing: '0.2px',
  },
} 