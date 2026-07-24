'use client'

import { useState } from 'react'
import AirportDropdown from '@/app/components/AirportDropdown'

interface FlatFlightResult {
  flightKey: string
  provider: string
  isLcc: boolean
  itemNo: string
  cabin?: string
  bookingCode?: string
  origin?: { code: string; name: string; city: string; dateTime: string }
  destination?: { code: string; name: string; city: string; dateTime: string }
  airline?: { code: string; name: string }
  stops: number
  duration?: string
  availableSeats?: number
  checkInBaggageKg?: string
  pricingKey?: string
  currency?: string
  totalFare?: number
  baseFare?: number
  isNdc?: boolean
  refundable?: boolean
}

function formatTime(iso: string | undefined) {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })
  } catch {
    return '—'
  }
}

function formatDayLabel(iso: string | undefined) {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })
  } catch {
    return ''
  }
}

function toApiDate(input: string) {
  // <input type="date"> gives YYYY-MM-DD, Amadeus wants DD/MM/YYYY
  const [y, m, d] = input.split('-')
  return `${d}/${m}/${y}`
}

function toDisplayDate(input: string) {
  if (!input) return ''
  const d = new Date(input)
  return d.toLocaleDateString('en-IN', { weekday: 'short', day: '2-digit', month: 'short' })
}



export default function BookFlightsPage() {
  const [origin, setOrigin] = useState('')
  const [destination, setDestination] = useState('')
  const [departDate, setDepartDate] = useState('')
  const [adult, setAdult] = useState(1)
  const [cabinPref, setCabinPref] = useState<'Economy' | 'Premium Economy' | 'Business' | 'First'>('Economy')

  const [searching, setSearching] = useState(false)
  const [hasSearched, setHasSearched] = useState(false)
  const [results, setResults] = useState<FlatFlightResult[]>([])
  const [error, setError] = useState('')
  const [sortBy, setSortBy] = useState<'price' | 'duration' | 'departure'>('price')
  const [selectedKey, setSelectedKey] = useState<string | null>(null)

  function swapOriginDestination() {
    setOrigin(destination)
    setDestination(origin)
  }

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault()
    setSearching(true)
    setError('')
    setHasSearched(false)
    setSelectedKey(null)
    try {
      const res = await fetch('/api/book/flights/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          origin, destination,
          departDate: toApiDate(departDate),
          adult,
        }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error || 'Search failed.'); return }
      setResults(data.results ?? [])
      setHasSearched(true)
    } catch {
      setError('Something went wrong. Please try again.')
    } finally {
      setSearching(false)
    }
  }

  const sortedResults = [...results].sort((a, b) => {
    if (sortBy === 'price') return (a.totalFare ?? Infinity) - (b.totalFare ?? Infinity)
    if (sortBy === 'duration') return durationMinutes(a.duration) - durationMinutes(b.duration)
    return (a.origin?.dateTime ?? '').localeCompare(b.origin?.dateTime ?? '')
  })

  return (
    <div style={s.page}>
      <div style={s.root}>
        {/* ── Header ─────────────────────────────────────────────────── */}
        <div style={s.header}>
          <h1 style={s.heading}>Book a flight</h1>
          <p style={s.sub}>Search live fares — your travel policy is checked automatically before you book.</p>
        </div>

        {/* ── Search card ────────────────────────────────────────────── */}
        <form onSubmit={handleSearch} style={s.searchCard}>
          <div style={s.tripTypeRow}>
            <span style={s.tripTypePill}>One way</span>
            <span style={s.tripTypeMuted}>Round trip and multi-city coming soon</span>
          </div>

          <div style={s.routeFieldsWrap}>
            <div style={s.routeFields}>
              <div style={s.routeField}>
                <label style={s.label}>From</label>
                <AirportDropdown
                  value={origin}
                  onChange={setOrigin}
                  exclude={destination}
                  dropdownStyle={s.codeDropdown}
                />
              </div>

              <button type="button" onClick={swapOriginDestination} style={s.swapBtn} title="Swap origin and destination" aria-label="Swap origin and destination">
                ⇄
              </button>

              <div style={s.routeField}>
                <label style={s.label}>To</label>
                <AirportDropdown
                  value={destination}
                  onChange={setDestination}
                  exclude={origin}
                  dropdownStyle={s.codeDropdown}
                />
              </div>
            </div>

            <div style={s.secondaryFields}>
              <div style={s.field}>
                <label style={s.label}>Departure</label>
                <input
                  type="date" required value={departDate}
                  onChange={e => setDepartDate(e.target.value)}
                  min={new Date().toISOString().split('T')[0]}
                  style={s.input}
                />
                {departDate && <span style={s.airportHint}>{toDisplayDate(departDate)}</span>}
              </div>

              <div style={s.field}>
                <label style={s.label}>Travelers</label>
                <input
                  type="number" required min={1} max={9} value={adult}
                  onChange={e => setAdult(Number(e.target.value))}
                  style={s.input}
                />
              </div>

              <div style={s.field}>
                <label style={s.label}>Cabin</label>
                <select value={cabinPref} onChange={e => setCabinPref(e.target.value as 'Economy' | 'Premium Economy' | 'Business' | 'First')} style={s.input}>
                  <option value="Economy">Economy</option>
                  <option value="Premium Economy">Premium Economy</option>
                  <option value="Business">Business</option>
                  <option value="First">First</option>
                </select>
              </div>
            </div>
          </div>

          <button type="submit" disabled={searching} style={{ ...s.searchBtn, opacity: searching ? 0.7 : 1 }}>
            {searching ? (
              <>
                <span style={s.spinner} />
                Searching…
              </>
            ) : (
              'Search flights →'
            )}
          </button>
        </form>

        {error && (
          <div style={s.errorBanner}>
            <span style={s.bannerIcon}>⚠</span> {error}
          </div>
        )}

        {/* ── Results ────────────────────────────────────────────────── */}
        {searching && (
          <div style={s.loadingState}>
            {[0, 1, 2].map(i => <div key={i} style={s.skeletonCard} />)}
          </div>
        )}

        {hasSearched && !searching && (
          results.length === 0 ? (
            <div style={s.emptyState}>
              <p style={s.emptyTitle}>No flights found</p>
              <p style={s.emptyDesc}>Try a different date or route.</p>
            </div>
          ) : (
            <div style={s.resultsWrap}>
              <div style={s.resultsHeader}>
                <p style={s.resultsCount}>
                  <strong>{results.length}</strong> fare{results.length === 1 ? '' : 's'} found · {origin} → {destination}
                </p>
                <div style={s.sortRow}>
                  <span style={s.sortLabel}>Sort by</span>
                  {(['price', 'duration', 'departure'] as const).map(key => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setSortBy(key)}
                      style={{ ...s.sortBtn, ...(sortBy === key ? s.sortBtnActive : {}) }}
                    >
                      {key === 'price' ? 'Price' : key === 'duration' ? 'Duration' : 'Departure'}
                    </button>
                  ))}
                </div>
              </div>

              <div style={s.resultsList}>
                {sortedResults.map((flight, i) => {
                  const isSelected = selectedKey === `${flight.flightKey}-${flight.pricingKey}`
                  return (
                    <div
                      key={`${flight.flightKey}-${flight.pricingKey}-${i}`}
                      style={{ ...s.resultCard, ...(isSelected ? s.resultCardSelected : {}) }}
                    >
                      <div style={s.resultTop}>
                        <div style={s.airlineBlock}>
                          <div style={s.airlineAvatar}>{flight.airline?.name?.[0] ?? '✈'}</div>
                          <div>
                            <div style={s.airlineName}>{flight.airline?.name ?? 'Unknown airline'}</div>
                            <div style={s.airlineMeta}>
                              {flight.airline?.code} · {flight.cabin ?? cabinPref}
                              {flight.isNdc && <span style={s.ndcTag}>NDC fare</span>}
                            </div>
                          </div>
                        </div>

                        <div style={s.fareBlock}>
                          <span style={s.fareAmount}>₹{flight.totalFare?.toLocaleString('en-IN') ?? '—'}</span>
                          <span style={{ ...s.refundBadge, color: flight.refundable ? '#065F46' : '#9CA3AF', background: flight.refundable ? '#ECFDF5' : '#F3F4F6' }}>
                            {flight.refundable ? 'Refundable' : 'Non-refundable'}
                          </span>
                        </div>
                      </div>

                      <div style={s.routeRow}>
                        <div style={s.routePoint}>
                          <span style={s.routeTime}>{formatTime(flight.origin?.dateTime)}</span>
                          <span style={s.routeCode}>{flight.origin?.code ?? origin}</span>
                          <span style={s.routeDay}>{formatDayLabel(flight.origin?.dateTime)}</span>
                        </div>

                        <div style={s.routeMiddle}>
                          <span style={s.routeDuration}>{flight.duration ?? ''}</span>
                          <div style={s.routeLineWrap}>
                            <div style={s.routeDot} />
                            <div style={s.routeLine} />
                            {flight.stops > 0 && <div style={s.routeStopDot} />}
                            <div style={s.routeDot} />
                          </div>
                          <span style={s.routeStops}>
                            {flight.stops === 0 ? 'Non-stop' : `${flight.stops} stop${flight.stops === 1 ? '' : 's'}`}
                          </span>
                        </div>

                        <div style={s.routePoint}>
                          <span style={s.routeTime}>{formatTime(flight.destination?.dateTime)}</span>
                          <span style={s.routeCode}>{flight.destination?.code ?? destination}</span>
                          <span style={s.routeDay}>{formatDayLabel(flight.destination?.dateTime)}</span>
                        </div>
                      </div>

                      <div style={s.resultBottom}>
                        <div style={s.metaTags}>
                          <span style={{ ...s.tag, ...(flight.isLcc ? s.tagBudget : s.tagFullService) }}>
                            {flight.isLcc ? 'Budget carrier' : 'Full-service'}
                          </span>
                          {flight.checkInBaggageKg && <span style={s.tag}>{flight.checkInBaggageKg}kg check-in</span>}
                          {flight.availableSeats !== undefined && flight.availableSeats <= 4 && (
                            <span style={{ ...s.tag, color: '#92400E', background: '#FEF3C7' }}>
                              Only {flight.availableSeats} left
                            </span>
                          )}
                        </div>
                        <button
                          type="button"
                          onClick={() => setSelectedKey(`${flight.flightKey}-${flight.pricingKey}`)}
                          style={isSelected ? s.selectBtnActive : s.selectBtn}
                        >
                          {isSelected ? '✓ Selected' : 'Select →'}
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )
        )}
      </div>
    </div>
  )
}

function durationMinutes(duration: string | undefined): number {
  if (!duration) return Infinity
  const [h, m] = duration.split(':').map(Number)
  return (h || 0) * 60 + (m || 0)
}

const s: Record<string, React.CSSProperties> = {
  page: { background: '#F9FAFB', minHeight: '100vh' },
  root: { fontFamily: "'Inter', -apple-system, sans-serif", maxWidth: '820px', margin: '0 auto', padding: '32px 24px 64px' },

  header: { marginBottom: '20px' },
  heading: { fontSize: '24px', fontWeight: 700, color: '#0A0A14', margin: '0 0 6px', letterSpacing: '-0.4px' },
  sub: { fontSize: '14px', color: '#6B7280', margin: 0 },

  searchCard: { background: '#fff', border: '1px solid #E5E7EB', borderRadius: '16px', padding: '20px 20px 16px', marginBottom: '20px', boxShadow: '0 1px 3px rgba(0,0,0,0.04)' },
  tripTypeRow: { display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '16px' },
  tripTypePill: { fontSize: '12px', fontWeight: 600, color: '#fff', background: '#000835', padding: '5px 12px', borderRadius: '999px' },
  tripTypeMuted: { fontSize: '11px', color: '#9CA3AF' },

  routeFieldsWrap: { display: 'flex', flexDirection: 'column', gap: '12px', marginBottom: '16px' },
  routeFields: { display: 'flex', alignItems: 'center', gap: '0', position: 'relative', background: '#F9FAFB', border: '1px solid #E5E7EB', borderRadius: '12px', padding: '4px' },
  routeField: { flex: 1, display: 'flex', flexDirection: 'column', gap: '2px', padding: '10px 16px' },
  swapBtn: {
    width: '36px', height: '36px', flexShrink: 0, borderRadius: '50%', background: '#fff',
    border: '1.5px solid #E5E7EB', color: '#000835', fontSize: '15px', cursor: 'pointer',
    display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1,
  },
  label: { fontSize: '10px', fontWeight: 700, color: '#9CA3AF', textTransform: 'uppercase', letterSpacing: '0.5px' },
  codeInput: { border: 'none', background: 'transparent', outline: 'none', fontSize: '22px', fontWeight: 700, color: '#111827', padding: '2px 0', width: '100%', letterSpacing: '0.5px' },
  codeDropdown: { border: 'none', background: 'transparent', outline: 'none', fontSize: '13px', fontWeight: 600, color: '#111827', padding: '2px 0', width: '100%' },
  airportHint: { fontSize: '11px', color: '#9CA3AF' },

  secondaryFields: { display: 'grid', gridTemplateColumns: '1.4fr 1fr 1fr', gap: '10px' },
  field: { display: 'flex', flexDirection: 'column', gap: '5px' },
  input: { height: '42px', padding: '0 12px', fontSize: '13px', fontWeight: 500, color: '#111827', background: '#F9FAFB', border: '1px solid #E5E7EB', borderRadius: '9px', outline: 'none' },

  searchBtn: {
    height: '46px', width: '100%', background: '#000835', color: '#fff', fontSize: '14px', fontWeight: 700,
    border: 'none', borderRadius: '10px', cursor: 'pointer', display: 'flex', alignItems: 'center',
    justifyContent: 'center', gap: '8px', letterSpacing: '0.2px',
  },
  spinner: { width: '13px', height: '13px', border: '2px solid rgba(255,255,255,0.4)', borderTopColor: '#fff', borderRadius: '50%', display: 'inline-block' },

  errorBanner: { display: 'flex', alignItems: 'center', gap: '8px', background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: '10px', padding: '11px 14px', fontSize: '13px', color: '#DC2626', marginBottom: '16px' },
  bannerIcon: { fontSize: '14px' },

  loadingState: { display: 'flex', flexDirection: 'column', gap: '12px' },
  skeletonCard: { height: '128px', borderRadius: '14px', background: 'linear-gradient(90deg, #F3F4F6 25%, #E5E7EB 37%, #F3F4F6 63%)', backgroundSize: '400% 100%' },

  emptyState: { textAlign: 'center' as const, padding: '56px 20px', background: '#fff', border: '1px solid #E5E7EB', borderRadius: '14px' },
  emptyTitle: { fontSize: '15px', fontWeight: 600, color: '#374151', margin: '0 0 6px' },
  emptyDesc: { fontSize: '13px', color: '#9CA3AF', margin: 0 },

  resultsWrap: { display: 'flex', flexDirection: 'column', gap: '14px' },
  resultsHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap' as const, gap: '10px' },
  resultsCount: { fontSize: '13px', color: '#6B7280', margin: 0 },
  sortRow: { display: 'flex', alignItems: 'center', gap: '6px' },
  sortLabel: { fontSize: '11px', color: '#9CA3AF', marginRight: '2px' },
  sortBtn: { fontSize: '11px', fontWeight: 500, color: '#6B7280', background: '#fff', border: '1px solid #E5E7EB', borderRadius: '7px', padding: '5px 10px', cursor: 'pointer' },
  sortBtnActive: { color: '#fff', background: '#000835', borderColor: '#000835' },

  resultsList: { display: 'flex', flexDirection: 'column', gap: '12px' },
  resultCard: { background: '#fff', border: '1px solid #E5E7EB', borderRadius: '14px', padding: '18px', transition: 'border-color 0.15s' },
  resultCardSelected: { borderColor: '#000835', boxShadow: '0 0 0 2px rgba(0,8,53,0.1)' },

  resultTop: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '16px' },
  airlineBlock: { display: 'flex', alignItems: 'center', gap: '10px' },
  airlineAvatar: { width: '34px', height: '34px', borderRadius: '9px', background: '#EEF2FF', color: '#3730A3', fontSize: '14px', fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  airlineName: { fontSize: '13px', fontWeight: 600, color: '#111827' },
  airlineMeta: { fontSize: '11px', color: '#9CA3AF', display: 'flex', alignItems: 'center', gap: '6px', marginTop: '2px' },
  ndcTag: { fontSize: '9px', fontWeight: 700, color: '#3730A3', background: '#EEF2FF', padding: '1px 6px', borderRadius: '4px', letterSpacing: '0.3px' },

  fareBlock: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '4px' },
  fareAmount: { fontSize: '19px', fontWeight: 700, color: '#0A0A14', letterSpacing: '-0.2px' },
  refundBadge: { fontSize: '10px', fontWeight: 600, padding: '2px 8px', borderRadius: '4px' },

  routeRow: { display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '16px', padding: '14px 0', borderTop: '1px solid #F3F4F6', borderBottom: '1px solid #F3F4F6' },
  routePoint: { display: 'flex', flexDirection: 'column', gap: '2px', flex: '0 0 auto', minWidth: '58px' },
  routeTime: { fontSize: '16px', fontWeight: 700, color: '#111827' },
  routeCode: { fontSize: '11px', fontWeight: 600, color: '#6B7280' },
  routeDay: { fontSize: '10px', color: '#9CA3AF' },
  routeMiddle: { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px' },
  routeDuration: { fontSize: '10px', color: '#9CA3AF', fontWeight: 500 },
  routeLineWrap: { display: 'flex', alignItems: 'center', width: '100%', gap: '2px' },
  routeDot: { width: '5px', height: '5px', borderRadius: '50%', background: '#D1D5DB', flexShrink: 0 },
  routeStopDot: { width: '5px', height: '5px', borderRadius: '50%', background: '#9CA3AF', flexShrink: 0 },
  routeLine: { flex: 1, height: '1px', background: '#D1D5DB' },
  routeStops: { fontSize: '10px', color: '#9CA3AF' },

  resultBottom: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  metaTags: { display: 'flex', gap: '6px', flexWrap: 'wrap' as const },
  tag: { fontSize: '10px', color: '#6B7280', background: '#F3F4F6', padding: '3px 9px', borderRadius: '5px', fontWeight: 500 },
  tagBudget: { color: '#7C2D12', background: '#FFF7ED' },
  tagFullService: { color: '#14532D', background: '#F0FDF4' },

  selectBtn: { height: '34px', padding: '0 18px', background: '#000835', color: '#fff', fontSize: '12px', fontWeight: 600, border: 'none', borderRadius: '8px', cursor: 'pointer' },
  selectBtnActive: { height: '34px', padding: '0 18px', background: '#ECFDF5', color: '#065F46', fontSize: '12px', fontWeight: 700, border: '1px solid #A7F3D0', borderRadius: '8px', cursor: 'pointer' },
}