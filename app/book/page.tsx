'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import AirportDropdown from '@/app/components/AirportDropdown'

// ── Types ─────────────────────────────────────────────────────────────────────

type TripType = 'one_way' | 'return'
type CabinClass = '' | 'Economy' | 'Premium Economy' | 'Business' | 'First'

interface SearchForm {
  tripType: TripType
  origin: string
  destination: string
  departDate: string
  returnDate: string
  cabin: CabinClass
  adult: number
  child: number
  infant: number
  nonStop: boolean
}

interface FlightResult {
  ResultIndex: string
  Key: string
  PricingKey: string
  Provider: string
  TotalFare: number
  BaseFare: number
  Tax: number
  Currency: string
  IsRefundable: boolean
  FareType: string
  AirlineCode: string
  AirlineName: string
  FlightNumber: string
  Origin: string
  Destination: string
  DepartureDateTime: string
  ArrivalDateTime: string
  Duration: string
  Stops: number
  CabinClass: string
  BaggageAllowance: string
  SeatsAvailable: number
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function toAmadeusDate(iso: string): string {
  // "2026-10-20" → "20/10/2026"
  const [y, m, d] = iso.split('-')
  return `${d}/${m}/${y}`
}

function formatTime(dt: string): string {
  return new Date(dt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false })
}

function formatDate(dt: string): string {
  return new Date(dt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
}

function formatDuration(d: string): string {
  const [h, m] = d.split(':')
  return `${h}h ${m}m`
}

function formatFare(amount: number, currency: string): string {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 0 }).format(amount)
}

function todayISO(): string {
  return new Date().toISOString().split('T')[0]
}

const CABIN_OPTIONS: CabinClass[] = ['Economy', 'Premium Economy', 'Business', 'First']

const INITIAL_FORM: SearchForm = {
  tripType: 'one_way',
  origin: '',
  destination: '',
  departDate: '',
  returnDate: '',
  cabin: '',
  adult: 1,
  child: 0,
  infant: 0,
  nonStop: false,
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function BookPage() {
  const router = useRouter()
  const [form, setForm] = useState<SearchForm>(INITIAL_FORM)
  const [results, setResults] = useState<FlightResult[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState('')
  const [pricingId, setPricingId] = useState<string | null>(null)
  const [pricing, setPricing] = useState<{ referenceNo: string; totalFare: number; currency: string } | null>(null)
  const [pricingFlight, setPricingFlight] = useState<FlightResult | null>(null)
  const [pricingLoading, setPricingLoading] = useState(false)
  const [pricingError, setPricingError] = useState('')

  function setField<K extends keyof SearchForm>(key: K, value: SearchForm[K]) {
    setForm(prev => ({ ...prev, [key]: value }))
    setResults(null)
    setError('')
    setPricing(null)
    setPricingFlight(null)
  }

  function validate(): string {
    if (!form.origin) return 'Select a departure airport.'
    if (!form.destination) return 'Select a destination airport.'
    if (form.origin === form.destination) return 'Origin and destination cannot be the same.'
    if (!form.departDate) return 'Select a departure date.'
    if (form.departDate < todayISO()) return 'Departure date must be in the future.'
    if (form.tripType === 'return') {
      if (!form.returnDate) return 'Select a return date.'
      if (form.returnDate <= form.departDate) return 'Return date must be after departure.'
    }
    if (form.adult < 1) return 'At least 1 adult is required.'
    if (form.infant > form.adult) return 'Infants cannot exceed the number of adults.'
    return ''
  }

  async function handleSearch() {
    const validationError = validate()
    if (validationError) { setError(validationError); return }

    setSearching(true)
    setError('')
    setResults(null)
    setPricing(null)
    setPricingFlight(null)

    try {
      const segments = [
        { Origin: form.origin, Destination: form.destination, DepartDate: toAmadeusDate(form.departDate) },
        ...(form.tripType === 'return' && form.returnDate
          ? [{ Origin: form.destination, Destination: form.origin, DepartDate: toAmadeusDate(form.returnDate) }]
          : []),
      ]

      const res = await fetch('/api/book/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          segments,
          adult: form.adult,
          child: form.child,
          infant: form.infant,
          nonStop: form.nonStop,
          preferredClass: form.cabin,
        }),
      })

      const data = await res.json()

      if (!res.ok || !data.ok) {
        setError(data.error || 'Search failed. Please try again.')
        return
      }

      setResults(data.flights)
    } catch {
      setError('Something went wrong. Check your connection and try again.')
    } finally {
      setSearching(false)
    }
  }

  async function handleSelectFlight(flight: FlightResult) {
    setPricingId(flight.ResultIndex)
    setPricingLoading(true)
    setPricingError('')
    setPricing(null)
    setPricingFlight(flight)

    try {
      const res = await fetch('/api/book/price', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key: flight.Key,
          pricingKey: flight.PricingKey,
          provider: flight.Provider,
          resultIndex: flight.ResultIndex,
        }),
      })

      const data = await res.json()

      if (!res.ok || !data.ok) {
        setPricingError(data.error || 'Pricing failed. Please try again.')
        setPricingId(null)
        return
      }

      setPricing({
        referenceNo: data.referenceNo,
        totalFare: data.totalFare,
        currency: data.currency,
      })
    } catch {
      setPricingError('Pricing failed. Please try again.')
      setPricingId(null)
    } finally {
      setPricingLoading(false)
    }
  }

  function handleProceed() {
    if (!pricing || !pricingFlight) return
    // Store in sessionStorage for the passenger details page
    sessionStorage.setItem('pending_booking', JSON.stringify({
      flight: pricingFlight,
      pricing,
      form: { adult: form.adult, child: form.child, infant: form.infant },
    }))
    router.push('/book/passenger')
  }

  const hasResults = results !== null && results.length > 0
  const noResults = results !== null && results.length === 0

  return (
    <div style={s.root}>
      {/* ── Page title ──────────────────────────────────────────────────── */}
      <div style={s.pageHeader}>
        <h1 style={s.heading}>Book travel</h1>
        <p style={s.sub}>Search flights within your company's travel policy.</p>
      </div>

      {/* ── Search form ──────────────────────────────────────────────────── */}
      <div style={s.formCard}>
        {/* Trip type toggle */}
        <div style={s.tripToggle}>
          {(['one_way', 'return'] as TripType[]).map(t => (
            <button
              key={t}
              onClick={() => setField('tripType', t)}
              style={{
                ...s.tripBtn,
                background: form.tripType === t ? '#000835' : 'transparent',
                color: form.tripType === t ? '#fff' : '#6B7280',
                borderColor: form.tripType === t ? '#000835' : '#E5E7EB',
              }}
            >
              {t === 'one_way' ? 'One way' : 'Return'}
            </button>
          ))}
        </div>

        {/* Route row */}
        <div style={s.routeRow}>
          <div style={s.fieldWrap}>
            <AirportDropdown
              id="origin"
              label="From"
              value={form.origin}
              onChange={v => setField('origin', v)}
              exclude={form.destination}
            />
          </div>

          <button
            style={s.swapBtn}
            title="Swap airports"
            onClick={() => {
              setForm(prev => ({ ...prev, origin: prev.destination, destination: prev.origin }))
              setResults(null)
            }}
          >
            ⇄
          </button>

          <div style={s.fieldWrap}>
            <AirportDropdown
              id="destination"
              label="To"
              value={form.destination}
              onChange={v => setField('destination', v)}
              exclude={form.origin}
            />
          </div>
        </div>

        {/* Date + options row */}
        <div style={s.optionsRow}>
          <div style={s.field}>
            <label style={s.label} htmlFor="departDate">Departure</label>
            <input
              id="departDate"
              type="date"
              min={todayISO()}
              value={form.departDate}
              onChange={e => setField('departDate', e.target.value)}
              style={s.input}
            />
          </div>

          {form.tripType === 'return' && (
            <div style={s.field}>
              <label style={s.label} htmlFor="returnDate">Return</label>
              <input
                id="returnDate"
                type="date"
                min={form.departDate || todayISO()}
                value={form.returnDate}
                onChange={e => setField('returnDate', e.target.value)}
                style={s.input}
              />
            </div>
          )}

          <div style={s.field}>
            <label style={s.label} htmlFor="cabin">Cabin class</label>
            <select
              id="cabin"
              value={form.cabin}
              onChange={e => setField('cabin', e.target.value as CabinClass)}
              style={s.input}
            >
              <option value="">Any cabin</option>
              {CABIN_OPTIONS.map(c => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>

          <div style={s.field}>
            <label style={s.label}>Passengers</label>
            <div style={s.paxRow}>
              {(['adult', 'child', 'infant'] as const).map(type => (
                <div key={type} style={s.paxField}>
                  <label style={s.paxLabel}>{type.charAt(0).toUpperCase() + type.slice(1)}</label>
                  <div style={s.paxStepper}>
                    <button
                      style={s.stepperBtn}
                      onClick={() => setField(type, Math.max(type === 'adult' ? 1 : 0, form[type] - 1))}
                    >−</button>
                    <span style={s.stepperVal}>{form[type]}</span>
                    <button
                      style={s.stepperBtn}
                      onClick={() => setField(type, Math.min(9, form[type] + 1))}
                    >+</button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div style={s.field}>
            <label style={s.label}>Options</label>
            <label style={s.checkLabel}>
              <input
                type="checkbox"
                checked={form.nonStop}
                onChange={e => setField('nonStop', e.target.checked)}
                style={{ marginRight: 7 }}
              />
              Non-stop only
            </label>
          </div>
        </div>

        {error && <p style={s.errorText}>{error}</p>}

        <div style={s.formFooter}>
          <button
            onClick={handleSearch}
            disabled={searching}
            style={{ ...s.searchBtn, opacity: searching ? 0.7 : 1 }}
          >
            {searching ? 'Searching…' : 'Search flights'}
          </button>
        </div>
      </div>

      {/* ── Results ──────────────────────────────────────────────────────── */}
      {searching && (
        <div style={s.loadingWrap}>
          <div style={s.spinner} />
          <p style={s.loadingText}>Searching available flights…</p>
        </div>
      )}

      {noResults && !searching && (
        <div style={s.emptyState}>
          <p style={s.emptyIcon}>✈</p>
          <p style={s.emptyTitle}>No flights found</p>
          <p style={s.emptyDesc}>Try different dates, a nearby airport, or remove the non-stop filter.</p>
        </div>
      )}

      {pricingError && (
        <div style={s.errorBanner}>⚠ {pricingError}</div>
      )}

      {hasResults && !searching && (
        <div style={s.resultsSection}>
          <p style={s.resultsCount}>{results!.length} flight{results!.length !== 1 ? 's' : ''} found</p>

          <div style={s.resultsList}>
            {results!.map(flight => {
              const isSelected = pricingId === flight.ResultIndex
              const isPriced = isSelected && pricing !== null
              const isLoading = isSelected && pricingLoading

              return (
                <div
                  key={flight.ResultIndex}
                  style={{
                    ...s.flightCard,
                    borderColor: isSelected ? '#000835' : '#E5E7EB',
                    boxShadow: isSelected ? '0 0 0 2px rgba(0,8,53,0.1)' : 'none',
                  }}
                >
                  {/* Airline + flight number */}
                  <div style={s.flightTop}>
                    <div style={s.airlineWrap}>
                      <div style={s.airlineLogo}>{flight.AirlineCode}</div>
                      <div>
                        <p style={s.airlineName}>{flight.AirlineName}</p>
                        <p style={s.flightNumber}>{flight.FlightNumber} · {flight.CabinClass}</p>
                      </div>
                    </div>

                    <div style={s.fareWrap}>
                      <p style={s.fareAmount}>{formatFare(flight.TotalFare, flight.Currency)}</p>
                      <p style={s.fareBreakdown}>Base {formatFare(flight.BaseFare, flight.Currency)} + Tax {formatFare(flight.Tax, flight.Currency)}</p>
                    </div>
                  </div>

                  {/* Route + timing */}
                  <div style={s.routeStrip}>
                    <div style={s.routeEndpoint}>
                      <p style={s.routeTime}>{formatTime(flight.DepartureDateTime)}</p>
                      <p style={s.routeDate}>{formatDate(flight.DepartureDateTime)}</p>
                      <p style={s.routeCode}>{flight.Origin}</p>
                    </div>

                    <div style={s.routeMiddle}>
                      <p style={s.routeDuration}>{formatDuration(flight.Duration)}</p>
                      <div style={s.routeLine}>
                        <div style={s.routeDot} />
                        <div style={s.routeTrack} />
                        <div style={s.routeDot} />
                      </div>
                      <p style={s.routeStops}>
                        {flight.Stops === 0 ? 'Non-stop' : `${flight.Stops} stop${flight.Stops > 1 ? 's' : ''}`}
                      </p>
                    </div>

                    <div style={{ ...s.routeEndpoint, textAlign: 'right' as const }}>
                      <p style={s.routeTime}>{formatTime(flight.ArrivalDateTime)}</p>
                      <p style={s.routeDate}>{formatDate(flight.ArrivalDateTime)}</p>
                      <p style={s.routeCode}>{flight.Destination}</p>
                    </div>
                  </div>

                  {/* Tags */}
                  <div style={s.tagsRow}>
                    {flight.IsRefundable && <span style={{ ...s.tag, ...s.tagGreen }}>Refundable</span>}
                    {!flight.IsRefundable && <span style={{ ...s.tag, ...s.tagGray }}>Non-refundable</span>}
                    {flight.Stops === 0 && <span style={{ ...s.tag, ...s.tagBlue }}>Non-stop</span>}
                    <span style={{ ...s.tag, ...s.tagGray }}>{flight.BaggageAllowance}</span>
                    <span style={{ ...s.tag, ...s.tagGray }}>{flight.SeatsAvailable} seat{flight.SeatsAvailable !== 1 ? 's' : ''} left</span>
                  </div>

                  {/* Priced fare confirmation */}
                  {isPriced && pricing && (
                    <div style={s.pricedBanner}>
                      <div>
                        <p style={s.pricedLabel}>Confirmed fare</p>
                        <p style={s.pricedFare}>{formatFare(pricing.totalFare, pricing.currency)}</p>
                        <p style={s.pricedRef}>Ref: {pricing.referenceNo}</p>
                      </div>
                      <button onClick={handleProceed} style={s.proceedBtn}>
                        Continue to passenger details →
                      </button>
                    </div>
                  )}

                  {/* Select button */}
                  {!isSelected && (
                    <div style={s.cardFooter}>
                      <button
                        onClick={() => handleSelectFlight(flight)}
                        style={s.selectBtn}
                      >
                        Select
                      </button>
                    </div>
                  )}

                  {isLoading && (
                    <div style={s.cardFooter}>
                      <div style={s.spinnerSmall} />
                      <span style={s.loadingText}>Confirming price…</span>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  root: {
    fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
    paddingBottom: 80,
  },
  pageHeader: { marginBottom: 20 },
  heading: { fontSize: 22, fontWeight: 700, color: '#0A0A14', margin: '0 0 4px', letterSpacing: '-0.4px' },
  sub: { fontSize: 13, color: '#6B7280', margin: 0 },

  formCard: {
    background: '#fff', border: '1px solid #E5E7EB', borderRadius: 12,
    padding: 24, marginBottom: 24,
  },
  tripToggle: { display: 'flex', gap: 8, marginBottom: 20 },
  tripBtn: {
    height: 32, padding: '0 16px', fontSize: 12, fontWeight: 500,
    border: '1px solid', borderRadius: 6, cursor: 'pointer', transition: 'all 0.15s',
  },

  routeRow: { display: 'flex', alignItems: 'flex-end', gap: 8, marginBottom: 16 },
  fieldWrap: { flex: 1 },
  swapBtn: {
    height: 38, width: 38, flexShrink: 0, background: '#F9FAFB',
    border: '1px solid #E5E7EB', borderRadius: 7, cursor: 'pointer',
    fontSize: 16, color: '#6B7280', display: 'flex', alignItems: 'center',
    justifyContent: 'center', marginBottom: 0,
  },

  optionsRow: { display: 'flex', gap: 16, flexWrap: 'wrap' as const, alignItems: 'flex-start', marginBottom: 16 },
  field: { display: 'flex', flexDirection: 'column', gap: 6, minWidth: 140 },
  label: { fontSize: 11, fontWeight: 600, color: '#6B7280', textTransform: 'uppercase' as const, letterSpacing: '0.6px' },
  input: {
    height: 38, padding: '0 10px', fontSize: 13, color: '#111827',
    background: '#fff', border: '1px solid #D1D5DB', borderRadius: 7, outline: 'none',
  },

  paxRow: { display: 'flex', gap: 12 },
  paxField: { display: 'flex', flexDirection: 'column' as const, alignItems: 'center', gap: 4 },
  paxLabel: { fontSize: 10, color: '#9CA3AF', fontWeight: 500 },
  paxStepper: { display: 'flex', alignItems: 'center', gap: 6 },
  stepperBtn: {
    width: 24, height: 24, borderRadius: 4, border: '1px solid #E5E7EB',
    background: '#F9FAFB', cursor: 'pointer', fontSize: 14, color: '#374151',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  stepperVal: { fontSize: 13, fontWeight: 600, color: '#111827', minWidth: 16, textAlign: 'center' as const },

  checkLabel: { display: 'flex', alignItems: 'center', fontSize: 13, color: '#374151', cursor: 'pointer', marginTop: 4 },

  errorText: { fontSize: 12, color: '#DC2626', margin: '0 0 12px', padding: '8px 12px', background: '#FEF2F2', borderRadius: 6 },
  formFooter: { display: 'flex', justifyContent: 'flex-end' },
  searchBtn: {
    height: 40, padding: '0 28px', background: '#000835', color: '#fff',
    fontSize: 13, fontWeight: 600, border: 'none', borderRadius: 8, cursor: 'pointer',
  },

  loadingWrap: { display: 'flex', alignItems: 'center', gap: 12, padding: '32px 0' },
  spinner: {
    width: 20, height: 20, border: '2px solid #E5E7EB',
    borderTopColor: '#000835', borderRadius: '50%',
    animation: 'spin 0.8s linear infinite',
  },
  spinnerSmall: {
    width: 14, height: 14, border: '2px solid #E5E7EB',
    borderTopColor: '#000835', borderRadius: '50%',
    animation: 'spin 0.8s linear infinite',
  },
  loadingText: { fontSize: 13, color: '#6B7280' },

  emptyState: { textAlign: 'center' as const, padding: '48px 0' },
  emptyIcon: { fontSize: 32, margin: '0 0 12px' },
  emptyTitle: { fontSize: 15, fontWeight: 600, color: '#374151', margin: '0 0 6px' },
  emptyDesc: { fontSize: 13, color: '#9CA3AF', margin: 0 },

  errorBanner: {
    background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8,
    padding: '10px 14px', fontSize: 12, color: '#DC2626', marginBottom: 16,
  },

  resultsSection: { marginTop: 8 },
  resultsCount: { fontSize: 12, color: '#6B7280', margin: '0 0 12px', fontWeight: 500 },
  resultsList: { display: 'flex', flexDirection: 'column' as const, gap: 12 },

  flightCard: {
    background: '#fff', border: '1.5px solid #E5E7EB',
    borderRadius: 12, padding: 20, transition: 'all 0.15s',
  },

  flightTop: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 },
  airlineWrap: { display: 'flex', alignItems: 'center', gap: 12 },
  airlineLogo: {
    width: 40, height: 40, borderRadius: 8, background: '#F0F4FF',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontSize: 11, fontWeight: 700, color: '#3730A3', flexShrink: 0,
  },
  airlineName: { fontSize: 13, fontWeight: 600, color: '#111827', margin: '0 0 2px' },
  flightNumber: { fontSize: 11, color: '#9CA3AF', margin: 0 },

  fareWrap: { textAlign: 'right' as const },
  fareAmount: { fontSize: 18, fontWeight: 700, color: '#111827', margin: '0 0 2px', letterSpacing: '-0.3px' },
  fareBreakdown: { fontSize: 10, color: '#9CA3AF', margin: 0 },

  routeStrip: { display: 'flex', alignItems: 'center', gap: 16, marginBottom: 14 },
  routeEndpoint: { minWidth: 60 },
  routeTime: { fontSize: 20, fontWeight: 700, color: '#111827', margin: '0 0 2px', letterSpacing: '-0.5px' },
  routeDate: { fontSize: 11, color: '#9CA3AF', margin: '0 0 2px' },
  routeCode: { fontSize: 11, fontWeight: 600, color: '#6B7280', margin: 0 },

  routeMiddle: { flex: 1, display: 'flex', flexDirection: 'column' as const, alignItems: 'center', gap: 4 },
  routeDuration: { fontSize: 11, color: '#6B7280', margin: 0 },
  routeLine: { display: 'flex', alignItems: 'center', width: '100%', gap: 0 },
  routeDot: { width: 6, height: 6, borderRadius: '50%', background: '#D1D5DB', flexShrink: 0 },
  routeTrack: { flex: 1, height: 1, background: '#E5E7EB' },
  routeStops: { fontSize: 10, color: '#9CA3AF', margin: 0 },

  tagsRow: { display: 'flex', flexWrap: 'wrap' as const, gap: 6, marginBottom: 14 },
  tag: { display: 'inline-block', padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 500 },
  tagGreen: { background: '#ECFDF5', color: '#065F46' },
  tagBlue: { background: '#EEF2FF', color: '#3730A3' },
  tagGray: { background: '#F3F4F6', color: '#6B7280' },

  pricedBanner: {
    background: '#F0FDF4', border: '1px solid #A7F3D0', borderRadius: 8,
    padding: '14px 16px', display: 'flex', alignItems: 'center',
    justifyContent: 'space-between', marginTop: 4,
  },
  pricedLabel: { fontSize: 10, fontWeight: 600, color: '#065F46', textTransform: 'uppercase' as const, letterSpacing: '0.5px', margin: '0 0 3px' },
  pricedFare: { fontSize: 18, fontWeight: 700, color: '#065F46', margin: '0 0 2px' },
  pricedRef: { fontSize: 10, color: '#6B7280', margin: 0 },
  proceedBtn: {
    height: 38, padding: '0 20px', background: '#065F46', color: '#fff',
    fontSize: 13, fontWeight: 600, border: 'none', borderRadius: 7, cursor: 'pointer',
    whiteSpace: 'nowrap' as const,
  },

  cardFooter: { display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'flex-end', marginTop: 4 },
  selectBtn: {
    height: 36, padding: '0 20px', background: '#000835', color: '#fff',
    fontSize: 13, fontWeight: 600, border: 'none', borderRadius: 7, cursor: 'pointer',
  },
}