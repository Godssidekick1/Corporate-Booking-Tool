'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import AirportDropdown from '@/app/components/AirportDropdown'
import { flowStorage } from '@/app/lib/book/flowStorage'
import { FlatFlightResult, formatTime, formatDayLabel } from '@/app/lib/book/types'

function toApiDate(input: string) {
  const [y, m, d] = input.split('-')
  return `${d}/${m}/${y}`
}

function toDisplayDate(input: string) {
  if (!input) return ''
  const d = new Date(input)
  return d.toLocaleDateString('en-IN', { weekday: 'short', day: '2-digit', month: 'short' })
}

function durationMinutes(duration: string | undefined): number {
  if (!duration) return Infinity
  const [h, m] = duration.split(':').map(Number)
  return (h || 0) * 60 + (m || 0)
}

type DeparturePeriod = 'morning' | 'afternoon' | 'evening' | 'night'

// Morning 5am–12pm, Afternoon 12pm–5pm, Evening 5pm–9pm, Night 9pm–5am —
// standard airline-search buckets, based on local departure time from the
// ISO dateTime string (same field formatTime() already renders from).
function departurePeriod(iso: string | undefined): DeparturePeriod | null {
  if (!iso) return null
  const hour = new Date(iso).getHours()
  if (hour >= 5 && hour < 12) return 'morning'
  if (hour >= 12 && hour < 17) return 'afternoon'
  if (hour >= 17 && hour < 21) return 'evening'
  return 'night'
}

const STOP_FILTERS = [
  { key: 'nonstop', label: 'Non-stop', test: (f: FlatFlightResult) => f.stopCount === 0 },
  { key: '1stop', label: '1 stop', test: (f: FlatFlightResult) => f.stopCount === 1 },
  { key: '2plusstop', label: '2+ stops', test: (f: FlatFlightResult) => f.stopCount >= 2 },
] as const

const FARE_TYPE_FILTERS = [
  { key: 'ndc', label: 'NDC', test: (f: FlatFlightResult) => Boolean(f.isNdc) },
  { key: 'nonndc', label: 'Non-NDC', test: (f: FlatFlightResult) => !f.isNdc },
] as const

const DEPARTURE_FILTERS = [
  { key: 'morning', label: 'Morning', sub: '5am–12pm' },
  { key: 'afternoon', label: 'Afternoon', sub: '12pm–5pm' },
  { key: 'evening', label: 'Evening', sub: '5pm–9pm' },
  { key: 'night', label: 'Night', sub: '9pm–5am' },
] as const

export default function BookFlightsSearchPage() {
  const router = useRouter()

  const [origin, setOrigin] = useState('')
  const [destination, setDestination] = useState('')
  const [departDate, setDepartDate] = useState('')
  const [adult, setAdult] = useState(1)
  const [child, setChild] = useState(0)
  const [infant, setInfant] = useState(0)
  const [travelersOpen, setTravelersOpen] = useState(false)
  const [cabinPref, setCabinPref] = useState<'Economy' | 'Premium Economy' | 'Business' | 'First'>('Economy')

  const [searching, setSearching] = useState(false)
  const [hasSearched, setHasSearched] = useState(false)
  const [results, setResults] = useState<FlatFlightResult[]>([])
  const [error, setError] = useState('')
  const [sortBy, setSortBy] = useState<'price' | 'duration' | 'departure'>('price')
  const [navigatingKey, setNavigatingKey] = useState<string | null>(null)

  // Filters are multi-select within each group, OR'd within a group and
  // AND'd across groups — e.g. selecting "Non-stop" + "1 stop" shows either,
  // but selecting "Non-stop" + "Morning" shows only non-stop morning flights.
  const [stopFilters, setStopFilters] = useState<Set<string>>(new Set())
  const [fareTypeFilters, setFareTypeFilters] = useState<Set<string>>(new Set())
  const [departureFilters, setDepartureFilters] = useState<Set<string>>(new Set())

  function toggleFilter(setter: React.Dispatch<React.SetStateAction<Set<string>>>, key: string) {
    setter(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function clearAllFilters() {
    setStopFilters(new Set())
    setFareTypeFilters(new Set())
    setDepartureFilters(new Set())
  }

  function swapOriginDestination() {
    setOrigin(destination)
    setDestination(origin)
  }

  function handleSelectFlight(flight: FlatFlightResult) {
    // Nothing to price here anymore — that's the next page's job. This page's
    // only responsibility is: remember what was searched/found, then hand
    // off to /book/price/[flightKey] via the URL, which is the one thing
    // that needs to survive a refresh or a shared link.
    setNavigatingKey(flight.flightKey)
    router.push(`/book/price/${encodeURIComponent(flight.flightKey)}`)
  }

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault()
    if (infant > adult) {
      setError('Each infant must travel with an adult. Please adjust traveler counts.')
      return
    }
    setSearching(true)
    setError('')
    setHasSearched(false)
    try {
      const res = await fetch('/api/book/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          origin, destination,
          departDate: toApiDate(departDate),
          adult, child, infant,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        const diagnostic = data.requestId
          ? ` Request ID: ${data.requestId}.${data.details?.Error?.Description ? ` Provider: ${data.details.Error.Description}` : ''}`
          : ''
        setError(`${data.error || 'Search failed.'}${diagnostic}`)
        return
      }

      const foundResults: FlatFlightResult[] = data.results ?? []
      setResults(foundResults)
      setHasSearched(true)

      // Save results + search context to sessionStorage so /book/price/[flightKey]
      // can look up the exact result the user picked without re-searching, and
      // so the "back to results" link on later pages has something to return to.
      flowStorage.saveSearchResults(
  foundResults,
  { origin, destination, departDate: toDisplayDate(departDate), adult, child, infant },
  data.availabilityKey ?? null,
)
    } catch {
      setError('Something went wrong. Please try again.')
    } finally {
      setSearching(false)
    }
  }

  const filteredResults = results.filter(flight => {
    if (stopFilters.size > 0) {
      const matchesStop = STOP_FILTERS.some(f => stopFilters.has(f.key) && f.test(flight))
      if (!matchesStop) return false
    }
    if (fareTypeFilters.size > 0) {
      const matchesFareType = FARE_TYPE_FILTERS.some(f => fareTypeFilters.has(f.key) && f.test(flight))
      if (!matchesFareType) return false
    }
    if (departureFilters.size > 0) {
      const period = departurePeriod(flight.origin?.dateTime)
      if (!period || !departureFilters.has(period)) return false
    }
    return true
  })

  const sortedResults = [...filteredResults].sort((a, b) => {
    if (sortBy === 'price') return (a.totalFare ?? Infinity) - (b.totalFare ?? Infinity)
    if (sortBy === 'duration') return durationMinutes(a.duration) - durationMinutes(b.duration)
    return (a.origin?.dateTime ?? '').localeCompare(b.origin?.dateTime ?? '')
  })

  const activeFilterCount = stopFilters.size + fareTypeFilters.size + departureFilters.size

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

              <div style={{ ...s.field, position: 'relative' }}>
                <label style={s.label}>Travelers</label>
                <button
                  type="button"
                  onClick={() => setTravelersOpen(o => !o)}
                  style={{ ...s.input, textAlign: 'left' as const, cursor: 'pointer', display: 'flex', alignItems: 'center' }}
                >
                  {adult + child + infant} traveler{adult + child + infant === 1 ? '' : 's'}
                </button>

                {travelersOpen && (
                  <div style={s.travelersPopover}>
                    {([
                      { key: 'adult', label: 'Adults', sub: '12+ years', value: adult, setValue: setAdult, min: 1 },
                      { key: 'child', label: 'Children', sub: '2–11 years', value: child, setValue: setChild, min: 0 },
                      { key: 'infant', label: 'Infants', sub: 'Under 2 years', value: infant, setValue: setInfant, min: 0 },
                    ] as const).map(row => (
                      <div key={row.key} style={s.travelerRow}>
                        <div>
                          <div style={s.travelerRowLabel}>{row.label}</div>
                          <div style={s.travelerRowSub}>{row.sub}</div>
                        </div>
                        <div style={s.travelerStepper}>
                          <button
                            type="button"
                            onClick={() => row.setValue(Math.max(row.min, row.value - 1))}
                            disabled={row.value <= row.min}
                            style={{ ...s.stepperBtn, opacity: row.value <= row.min ? 0.4 : 1 }}
                          >
                            −
                          </button>
                          <span style={s.stepperValue}>{row.value}</span>
                          <button
                            type="button"
                            onClick={() => row.setValue(Math.min(9, row.value + 1))}
                            disabled={adult + child + infant >= 9}
                            style={{ ...s.stepperBtn, opacity: adult + child + infant >= 9 ? 0.4 : 1 }}
                          >
                            +
                          </button>
                        </div>
                      </div>
                    ))}
                    {infant > adult && (
                      <p style={s.travelerNote}>Each infant must travel with an adult.</p>
                    )}
                    <button type="button" onClick={() => setTravelersOpen(false)} style={s.travelersDoneBtn}>
                      Done
                    </button>
                  </div>
                )}
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
              {/* ── Filters ──────────────────────────────────────────── */}
              <div style={s.filterBar}>
                <div style={s.filterGroup}>
                  <span style={s.filterGroupLabel}>Stops</span>
                  <div style={s.filterChips}>
                    {STOP_FILTERS.map(f => (
                      <button
                        key={f.key}
                        type="button"
                        onClick={() => toggleFilter(setStopFilters, f.key)}
                        style={{ ...s.filterChip, ...(stopFilters.has(f.key) ? s.filterChipActive : {}) }}
                      >
                        {f.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div style={s.filterGroup}>
                  <span style={s.filterGroupLabel}>Fare type</span>
                  <div style={s.filterChips}>
                    {FARE_TYPE_FILTERS.map(f => (
                      <button
                        key={f.key}
                        type="button"
                        onClick={() => toggleFilter(setFareTypeFilters, f.key)}
                        style={{ ...s.filterChip, ...(fareTypeFilters.has(f.key) ? s.filterChipActive : {}) }}
                      >
                        {f.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div style={s.filterGroup}>
                  <span style={s.filterGroupLabel}>Departure time</span>
                  <div style={s.filterChips}>
                    {DEPARTURE_FILTERS.map(f => (
                      <button
                        key={f.key}
                        type="button"
                        onClick={() => toggleFilter(setDepartureFilters, f.key)}
                        style={{ ...s.filterChip, ...(departureFilters.has(f.key) ? s.filterChipActive : {}) }}
                        title={f.sub}
                      >
                        {f.label}
                      </button>
                    ))}
                  </div>
                </div>

                {activeFilterCount > 0 && (
                  <button type="button" onClick={clearAllFilters} style={s.clearFiltersBtn}>
                    Clear filters ({activeFilterCount})
                  </button>
                )}
              </div>

              {sortedResults.length === 0 ? (
                <div style={s.emptyState}>
                  <p style={s.emptyTitle}>No flights match your filters</p>
                  <p style={s.emptyDesc}>Try clearing a filter to see more results.</p>
                  <button type="button" onClick={clearAllFilters} style={s.clearFiltersBtnInline}>
                    Clear all filters
                  </button>
                </div>
              ) : (
              <>
              <div style={s.resultsHeader}>
                <p style={s.resultsCount}>
                  <strong>{sortedResults.length}</strong> fare{sortedResults.length === 1 ? '' : 's'} found
                  {activeFilterCount > 0 && <span style={s.resultsCountMuted}> (of {results.length})</span>} · {origin} → {destination}
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
                  const isNavigating = navigatingKey === flight.flightKey
                  return (
                    <div
                      key={`${flight.flightKey}-${flight.pricingKey}-${i}`}
                      style={s.resultCard}
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

                      {/* ── Route strip ──────────────────────────────── */}
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
                            {flight.stopCount === 0 ? (
                              <div style={s.routeLine} />
                            ) : (
                              <>
                                <div style={{ flex: 1, height: '1px', background: '#D1D5DB' }} />
                                {flight.stops.map((stop, si) => (
                                  <div key={si} style={s.routeStopDot} />
                                ))}
                                <div style={{ flex: 1, height: '1px', background: '#D1D5DB' }} />
                              </>
                            )}
                            <div style={s.routeDot} />
                          </div>
                          <span style={s.routeStops}>
                            {flight.stopCount === 0
                              ? 'Non-stop'
                              : flight.stops.map(st => `via ${st.city}`).join(', ')}
                          </span>
                        </div>

                        <div style={{ ...s.routePoint, alignItems: 'flex-end' as const }}>
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
                          onClick={() => handleSelectFlight(flight)}
                          disabled={isNavigating}
                          style={s.selectBtn}
                        >
                          {isNavigating ? 'Opening…' : 'Select →'}
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
              </>
              )}
            </div>
          )
        )}
      </div>
    </div>
  )
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
  resultsCountMuted: { color: '#9CA3AF' },
  sortRow: { display: 'flex', alignItems: 'center', gap: '6px' },
  sortLabel: { fontSize: '11px', color: '#9CA3AF', marginRight: '2px' },
  sortBtn: { fontSize: '11px', fontWeight: 500, color: '#6B7280', background: '#fff', border: '1px solid #E5E7EB', borderRadius: '7px', padding: '5px 10px', cursor: 'pointer' },
  sortBtnActive: { color: '#fff', background: '#000835', borderColor: '#000835' },

  filterBar: {
    display: 'flex', flexWrap: 'wrap' as const, alignItems: 'flex-start', gap: '20px',
    background: '#fff', border: '1px solid #E5E7EB', borderRadius: '14px', padding: '14px 16px',
  },
  filterGroup: { display: 'flex', flexDirection: 'column' as const, gap: '6px' },
  filterGroupLabel: { fontSize: '10px', fontWeight: 700, color: '#9CA3AF', textTransform: 'uppercase' as const, letterSpacing: '0.4px' },
  filterChips: { display: 'flex', flexWrap: 'wrap' as const, gap: '6px' },
  filterChip: {
    fontSize: '12px', fontWeight: 500, color: '#374151', background: '#F9FAFB',
    border: '1px solid #E5E7EB', borderRadius: '8px', padding: '6px 11px', cursor: 'pointer',
  },
  filterChipActive: { color: '#fff', background: '#000835', borderColor: '#000835', fontWeight: 600 },
  clearFiltersBtn: {
    fontSize: '12px', fontWeight: 600, color: '#DC2626', background: 'none', border: 'none',
    cursor: 'pointer', alignSelf: 'flex-start', marginLeft: 'auto', marginTop: '18px',
  },
  clearFiltersBtnInline: {
    fontSize: '13px', fontWeight: 600, color: '#fff', background: '#000835',
    border: 'none', borderRadius: '8px', padding: '8px 16px', cursor: 'pointer', marginTop: '8px',
  },

  resultsList: { display: 'flex', flexDirection: 'column', gap: '12px' },
  resultCard: { background: '#fff', border: '1px solid #E5E7EB', borderRadius: '14px', padding: '18px', transition: 'border-color 0.15s' },

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
  routeStopDot: { width: '7px', height: '7px', borderRadius: '50%', background: '#6B7280', flexShrink: 0, border: '1.5px solid #fff', boxShadow: '0 0 0 1.5px #9CA3AF' },
  routeLine: { flex: 1, height: '1px', background: '#D1D5DB' },
  routeStops: { fontSize: '10px', color: '#9CA3AF' },

  resultBottom: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  metaTags: { display: 'flex', gap: '6px', flexWrap: 'wrap' as const },
  tag: { fontSize: '10px', color: '#6B7280', background: '#F3F4F6', padding: '3px 9px', borderRadius: '5px', fontWeight: 500 },
  tagBudget: { color: '#7C2D12', background: '#FFF7ED' },
  tagFullService: { color: '#14532D', background: '#F0FDF4' },

  selectBtn: { height: '34px', padding: '0 18px', background: '#000835', color: '#fff', fontSize: '12px', fontWeight: 600, border: 'none', borderRadius: '8px', cursor: 'pointer' },

  travelersPopover: {
    position: 'absolute' as const, top: 'calc(100% + 6px)', left: 0, right: 0, zIndex: 10,
    background: '#fff', border: '1px solid #E5E7EB', borderRadius: '12px', padding: '14px',
    boxShadow: '0 8px 24px rgba(0,0,0,0.08)',
  },
  travelerRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0' },
  travelerRowLabel: { fontSize: '13px', fontWeight: 600, color: '#111827' },
  travelerRowSub: { fontSize: '11px', color: '#9CA3AF' },
  travelerStepper: { display: 'flex', alignItems: 'center', gap: '10px' },
  stepperBtn: {
    width: '26px', height: '26px', borderRadius: '50%', border: '1px solid #D1D5DB', background: '#fff',
    color: '#000835', fontSize: '14px', fontWeight: 700, cursor: 'pointer', display: 'flex',
    alignItems: 'center', justifyContent: 'center', lineHeight: 1,
  },
  stepperValue: { fontSize: '13px', fontWeight: 600, color: '#111827', minWidth: '16px', textAlign: 'center' as const },
  travelerNote: { fontSize: '11px', color: '#DC2626', margin: '8px 0 0' },
  travelersDoneBtn: {
    width: '100%', height: '34px', marginTop: '10px', background: '#000835', color: '#fff',
    fontSize: '12px', fontWeight: 600, border: 'none', borderRadius: '8px', cursor: 'pointer',
  },
}