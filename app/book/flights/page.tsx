'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import AirportDropdown from '@/app/components/AirportDropdown'
import { flowStorage } from '@/app/lib/book/flowStorage'
import { searchPreferences } from '@/app/lib/book/searchPreferences'
import { FlatFlightResult, formatTime, formatDayLabel, journeysOf } from '@/app/lib/book/types'

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

// Stops across EVERY direction, so a round trip is judged on the whole trip
// rather than on its outbound alone. `stopCount` is now per journey — a
// non-stop return is 0 and 0, and testing the flight-level alias would have
// filtered on the outbound only.
//
// Before journeys existed this read the flat segment list, so a non-stop round
// trip counted its own turnaround as a connection and reported `stopCount: 1` —
// which meant "Non-stop" would have hidden exactly the flights it was meant to
// show, the moment round trip shipped.
function maxStops(f: FlatFlightResult): number {
  if (!f.journeys?.length) return f.stopCount
  return Math.max(...f.journeys.map(j => j.stopCount))
}

const STOP_FILTERS = [
  { key: 'nonstop', label: 'Non-stop', test: (f: FlatFlightResult) => maxStops(f) === 0 },
  { key: '1stop', label: '1 stop', test: (f: FlatFlightResult) => maxStops(f) === 1 },
  { key: '2plusstop', label: '2+ stops', test: (f: FlatFlightResult) => maxStops(f) >= 2 },
] as const

// Fare type is a CHOICE, not a multi-select, and that is the whole fix here.
//
// Stops and departure times are genuine multi-selects: "non-stop or 1 stop" and
// "morning or evening" are things a person actually wants. NDC and Non-NDC are
// not like that — they are the two halves of a yes/no, so they are mutually
// exclusive AND exhaustive. Ticking both selected every flight, which is
// identical to ticking neither: the chips looked active, the count said two
// filters were on, and nothing was filtered.
//
// Modelled as one value with an explicit "All" rather than as a set, so the
// meaningless state cannot be represented at all.
type FareTypeChoice = 'all' | 'ndc' | 'nonndc'

const FARE_TYPE_CHOICES: { key: FareTypeChoice; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'ndc', label: 'NDC' },
  { key: 'nonndc', label: 'Non-NDC' },
]

function matchesFareType(flight: FlatFlightResult, choice: FareTypeChoice): boolean {
  if (choice === 'all') return true
  return choice === 'ndc' ? Boolean(flight.isNdc) : !flight.isNdc
}

const DEPARTURE_FILTERS = [
  { key: 'morning', label: 'Morning', sub: '5am–12pm' },
  { key: 'afternoon', label: 'Afternoon', sub: '12pm–5pm' },
  { key: 'evening', label: 'Evening', sub: '5pm–9pm' },
  { key: 'night', label: 'Night', sub: '9pm–5am' },
] as const

// Shown as one-click quick-search chips only for first-time users (no saved
// search history yet) — a common-route shortcut, not a permanent feature of
// the form once someone has a real search history to fall back on instead.
const POPULAR_ROUTES = [
  { origin: 'DEL', destination: 'BOM', label: 'Delhi → Mumbai' },
  { origin: 'DEL', destination: 'BLR', label: 'Delhi → Bengaluru' },
  { origin: 'BOM', destination: 'BLR', label: 'Mumbai → Bengaluru' },
  { origin: 'DEL', destination: 'GOI', label: 'Delhi → Goa' },
] as const

export default function BookFlightsSearchPage() {
  const router = useRouter()

  const [origin, setOrigin] = useState('')
  const [destination, setDestination] = useState('')
  const [departDate, setDepartDate] = useState(() => new Date().toISOString().split('T')[0])
  // The provider has no returnDate field — a round trip is a second segment
  // flying the route back, plus RTF: true. The API route builds that; this
  // form only has to collect the date.
  const [tripType, setTripType] = useState<'oneway' | 'return'>('oneway')
  const [returnDate, setReturnDate] = useState('')
  const [adult, setAdult] = useState(1)
  const [child, setChild] = useState(0)
  const [infant, setInfant] = useState(0)
  const [travelersOpen, setTravelersOpen] = useState(false)
  const travelersRef = useRef<HTMLDivElement>(null)
  const [cabinPref, setCabinPref] = useState<'Economy' | 'Premium Economy' | 'Business' | 'First'>('Economy')
  // Ticked by default — the common case is booking your own travel, and the
  // passengers page autofills slot 1 from the traveler profile whenever this
  // is true. Unticking it means "I'm booking for someone else," so slot 1
  // stays blank for manual entry instead of silently filling in the current
  // employee's own passport/DOB on a colleague's booking.
  const [bookingForSelf, setBookingForSelf] = useState(true)

  // Shown only until the person has searched at least once, ever — after
  // that, the remembered origin/destination (below) is more useful than a
  // generic popular-route suggestion.
  const [showPopularRoutes, setShowPopularRoutes] = useState(false)

  useEffect(() => {
    // Deliberately NOT using useSearchParams() here — Next.js 16's Cache
    // Components can serve a stale/delayed value through that hook right
    // after a client-side navigation (a known RSC-commit-ordering issue:
    // the URL bar is correct but the hook hasn't caught up yet), which was
    // silently dropping tripId on the "+ Add flight" -> /book/flights
    // handoff even though the link itself was correct. Reading the actual
    // browser URL directly sidesteps that — this only needs to run once,
    // on mount, so there's no ongoing-reactivity reason to prefer the hook.
    const tripId = new URLSearchParams(window.location.search).get('tripId')
    if (tripId) flowStorage.setTripId(tripId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const lastOrigin = searchPreferences.getLastOrigin()
    const lastDestination = searchPreferences.getLastDestination()
    const lastTravelers = searchPreferences.getLastTravelers()
    const lastCabin = searchPreferences.getLastCabinPref()

    if (lastOrigin) setOrigin(lastOrigin)
    if (lastDestination) setDestination(lastDestination)
    if (lastTravelers) {
      setAdult(lastTravelers.adult)
      setChild(lastTravelers.child)
      setInfant(lastTravelers.infant)
    }
    if (lastCabin) setCabinPref(lastCabin)

    setShowPopularRoutes(!searchPreferences.hasSearchedBefore())
  }, [])

  function applyPopularRoute(route: { origin: string; destination: string }) {
    setOrigin(route.origin)
    setDestination(route.destination)
    setShowPopularRoutes(false)
  }

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
  const [fareType, setFareType] = useState<FareTypeChoice>('all')
  const [departureFilters, setDepartureFilters] = useState<Set<string>>(new Set())

  // The travellers popover had exactly one way out: the Done button. Clicking
  // the page, pressing Escape and hitting Search all left it open — and since it
  // is absolutely positioned over the fields below it, an open popover is also
  // what stops the Search click from landing.
  //
  // Closed on mousedown rather than click, so that the popover is already gone
  // by the time the click resolves and the press reaches whatever was underneath
  // it. Closing on `click` would swallow that first press as a dismissal.
  useEffect(() => {
    if (!travelersOpen) return

    function handlePointerDown(e: MouseEvent) {
      if (travelersRef.current && !travelersRef.current.contains(e.target as Node)) {
        setTravelersOpen(false)
      }
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setTravelersOpen(false)
    }

    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [travelersOpen])

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
    setFareType('all')
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
    // Searching means they are done choosing travellers. Leaving it open would
    // float the popover over the results they just asked for.
    setTravelersOpen(false)
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
          tripType,
          // Sent only when it is actually a round trip, so switching back to
          // one way can't leave a stale return date behind in the request.
          returnDate: tripType === 'return' ? toApiDate(returnDate) : undefined,
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
      searchPreferences.saveLastSearch({ origin, destination, adult, child, infant, cabinPref })
      flowStorage.setGuestBooking(!bookingForSelf)

      // Save results + search context to sessionStorage so /book/price/[flightKey]
      // can look up the exact result the user picked without re-searching, and
      // so the "back to results" link on later pages has something to return to.
      flowStorage.saveSearchResults(
  foundResults,
  {
    origin, destination,
    departDate: toDisplayDate(departDate),
    tripType,
    returnDate: tripType === 'return' ? toDisplayDate(returnDate) : undefined,
    adult, child, infant,
  },
  data.availabilityKey ?? null,
)
    } catch {
      setError('Something went wrong. Please try again.')
    } finally {
      setSearching(false)
    }
  }

  // Each group's predicate, separately, so a group's own option counts can be
  // computed with every OTHER group applied. A chip reading "1 stop · 0" while a
  // morning filter is on is telling the truth about what clicking it would do;
  // counting against the unfiltered set would promise results that are not
  // there.
  const passesStops = (f: FlatFlightResult) =>
    stopFilters.size === 0 || STOP_FILTERS.some(sf => stopFilters.has(sf.key) && sf.test(f))
  const passesFareType = (f: FlatFlightResult) => matchesFareType(f, fareType)
  const passesDeparture = (f: FlatFlightResult) => {
    if (departureFilters.size === 0) return true
    const period = departurePeriod(f.origin?.dateTime)
    return Boolean(period && departureFilters.has(period))
  }

  const filteredResults = results.filter(f => passesStops(f) && passesFareType(f) && passesDeparture(f))

  const stopCounts = Object.fromEntries(
    STOP_FILTERS.map(sf => [
      sf.key,
      results.filter(f => sf.test(f) && passesFareType(f) && passesDeparture(f)).length,
    ])
  )
  const departureCounts = Object.fromEntries(
    DEPARTURE_FILTERS.map(df => [
      df.key,
      results.filter(f => departurePeriod(f.origin?.dateTime) === df.key && passesStops(f) && passesFareType(f)).length,
    ])
  )

  // The fare-type group is only worth showing when the results actually contain
  // both kinds. If every fare came back Non-NDC — which is the common case —
  // then "NDC" can only ever return an empty list, and "Non-NDC" can only ever
  // return what is already on screen. A control whose every option is a no-op
  // is noise, so it is hidden rather than rendered as three dead chips.
  const hasNdcMix = results.some(f => f.isNdc) && results.some(f => !f.isNdc)

  const sortedResults = [...filteredResults].sort((a, b) => {
    if (sortBy === 'price') return (a.totalFare ?? Infinity) - (b.totalFare ?? Infinity)
    if (sortBy === 'duration') return durationMinutes(a.duration) - durationMinutes(b.duration)
    return (a.origin?.dateTime ?? '').localeCompare(b.origin?.dateTime ?? '')
  })

  const activeFilterCount = stopFilters.size + (fareType === 'all' ? 0 : 1) + departureFilters.size

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
            {(['oneway', 'return'] as const).map(type => (
              <button
                key={type}
                type="button"
                onClick={() => setTripType(type)}
                style={tripType === type ? s.tripTypePill : s.tripTypeOption}
              >
                {type === 'oneway' ? 'One way' : 'Round trip'}
              </button>
            ))}
            <span style={s.tripTypeMuted}>Multi-city coming soon</span>
          </div>

          <label style={s.selfToggleRow}>
            <input
              type="checkbox"
              checked={bookingForSelf}
              onChange={e => setBookingForSelf(e.target.checked)}
              style={s.selfToggleCheckbox}
            />
            <span style={s.selfToggleText}>
              {bookingForSelf
                ? 'Booking for myself — your saved travel profile will fill in your details.'
                : 'Booking for someone else — enter their details manually.'}
            </span>
          </label>

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

            {showPopularRoutes && (
              <div style={s.popularRoutesRow}>
                <span style={s.popularRoutesLabel}>Popular:</span>
                {POPULAR_ROUTES.map(route => (
                  <button
                    key={`${route.origin}-${route.destination}`}
                    type="button"
                    onClick={() => applyPopularRoute(route)}
                    style={s.popularRouteChip}
                  >
                    {route.label}
                  </button>
                ))}
              </div>
            )}

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

              {tripType === 'return' && (
                <div style={s.field}>
                  <label style={s.label}>Return</label>
                  <input
                    type="date" required value={returnDate}
                    onChange={e => setReturnDate(e.target.value)}
                    // Can't return before you leave. Same-day is allowed — a
                    // day trip out and back is an ordinary corporate booking.
                    min={departDate}
                    style={s.input}
                  />
                  {returnDate && <span style={s.airportHint}>{toDisplayDate(returnDate)}</span>}
                </div>
              )}

              <div ref={travelersRef} style={{ ...s.field, position: 'relative' }}>
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
                    {/* Only the rows scroll. Done and the infant warning sit
                        outside that box, so they are visible whatever the
                        viewport height — previously the whole popover scrolled
                        as one, which put Done below the fold and made the one
                        control that closed the thing the hardest to reach. */}
                    <div style={s.travelerRows}>
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
                    </div>
                    {infant > adult && (
                      <p style={s.travelerNote}>Each infant must travel with an adult.</p>
                    )}
                    <button type="button" onClick={() => setTravelersOpen(false)} style={s.travelersDoneBtn}>
                      Done
                    </button>
                    <p style={s.travelerDismissHint}>or click anywhere to close</p>
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
                    {STOP_FILTERS.map(f => {
                      const count = stopCounts[f.key] ?? 0
                      const selected = stopFilters.has(f.key)
                      // Disabled only when it would match nothing AND is not
                      // already on — a selected chip must always stay clickable,
                      // or you could filter yourself into a state you cannot
                      // undo except with Clear filters.
                      const dead = count === 0 && !selected
                      return (
                        <button
                          key={f.key}
                          type="button"
                          disabled={dead}
                          onClick={() => toggleFilter(setStopFilters, f.key)}
                          style={{
                            ...s.filterChip,
                            ...(selected ? s.filterChipActive : {}),
                            ...(dead ? s.filterChipDead : {}),
                          }}
                        >
                          {f.label} <span style={s.filterChipCount}>{count}</span>
                        </button>
                      )
                    })}
                  </div>
                </div>

                {/* Hidden entirely unless the results contain both kinds —
                    see hasNdcMix. */}
                {hasNdcMix && (
                  <div style={s.filterGroup}>
                    <span style={s.filterGroupLabel}>Fare type</span>
                    <div style={s.filterChips}>
                      {/* One choice, not a set. Clicking a chip selects it
                          rather than toggling it, so NDC and Non-NDC can never
                          both be on — the state that used to filter nothing
                          while looking like two active filters. */}
                      {FARE_TYPE_CHOICES.map(choice => (
                        <button
                          key={choice.key}
                          type="button"
                          aria-pressed={fareType === choice.key}
                          onClick={() => setFareType(choice.key)}
                          style={{ ...s.filterChip, ...(fareType === choice.key ? s.filterChipActive : {}) }}
                        >
                          {choice.label}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                <div style={s.filterGroup}>
                  <span style={s.filterGroupLabel}>Departure time</span>
                  <div style={s.filterChips}>
                    {DEPARTURE_FILTERS.map(f => {
                      const count = departureCounts[f.key] ?? 0
                      const selected = departureFilters.has(f.key)
                      const dead = count === 0 && !selected
                      return (
                      <button
                        key={f.key}
                        type="button"
                        disabled={dead}
                        onClick={() => toggleFilter(setDepartureFilters, f.key)}
                        style={{
                          ...s.filterChip,
                          ...(selected ? s.filterChipActive : {}),
                          ...(dead ? s.filterChipDead : {}),
                        }}
                        title={f.sub}
                      >
                        {f.label} <span style={s.filterChipCount}>{count}</span>
                      </button>
                      )
                    })}
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

                      {/* ── Route strips, one per direction ──────────────
                          A round trip comes back from the provider as ONE
                          result with ONE combined price, so it is one card
                          with the outbound above the return — not two cards
                          the traveller could pick between. */}
                      {journeysOf(flight).map(journey => (
                        <div key={journey.journeyNo} style={s.routeRow}>
                          <div style={s.routePoint}>
                            <span style={s.routeTime}>{formatTime(journey.origin?.dateTime)}</span>
                            <span style={s.routeCode}>{journey.origin?.code ?? origin}</span>
                            <span style={s.routeDay}>{formatDayLabel(journey.origin?.dateTime)}</span>
                          </div>

                          <div style={s.routeMiddle}>
                            <span style={s.routeDuration}>{journey.totalDuration ?? journey.duration ?? ''}</span>
                            <div style={s.routeLineWrap}>
                              <div style={s.routeDot} />
                              {journey.stopCount === 0 ? (
                                <div style={s.routeLine} />
                              ) : (
                                <>
                                  <div style={{ flex: 1, height: '1px', background: '#D1D5DB' }} />
                                  {journey.stops.map((stop, si) => (
                                    <div key={si} style={s.routeStopDot} />
                                  ))}
                                  <div style={{ flex: 1, height: '1px', background: '#D1D5DB' }} />
                                </>
                              )}
                              <div style={s.routeDot} />
                            </div>
                            <span style={s.routeStops}>
                              {journey.stopCount === 0
                                ? 'Non-stop'
                                : journey.stops.map(st => `via ${st.city}`).join(', ')}
                            </span>
                          </div>

                          <div style={{ ...s.routePoint, alignItems: 'flex-end' as const }}>
                            <span style={s.routeTime}>{formatTime(journey.destination?.dateTime)}</span>
                            <span style={s.routeCode}>{journey.destination?.code ?? destination}</span>
                            <span style={s.routeDay}>{formatDayLabel(journey.destination?.dateTime)}</span>
                          </div>
                        </div>
                      ))}

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
  tripTypePill: { fontSize: '12px', fontWeight: 600, color: '#fff', background: '#000835', padding: '5px 12px', borderRadius: '999px', border: '1px solid #000835', cursor: 'pointer' },
  tripTypeOption: { fontSize: '12px', fontWeight: 600, color: '#4B5563', background: '#fff', padding: '5px 12px', borderRadius: '999px', border: '1px solid #D1D5DB', cursor: 'pointer' },
  tripTypeMuted: { fontSize: '11px', color: '#9CA3AF' },

  selfToggleRow: {
    display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px',
    padding: '9px 12px', background: '#F9FAFB', border: '1px solid #E5E7EB', borderRadius: '9px', cursor: 'pointer',
  },
  selfToggleCheckbox: { width: '15px', height: '15px', flexShrink: 0, cursor: 'pointer', accentColor: '#000835' },
  selfToggleText: { fontSize: '12.5px', color: '#374151', lineHeight: 1.4 },

  routeFieldsWrap: { display: 'flex', flexDirection: 'column', gap: '12px', marginBottom: '16px' },
  routeFields: { display: 'flex', alignItems: 'center', gap: '0', position: 'relative', background: '#F9FAFB', border: '1px solid #E5E7EB', borderRadius: '12px', padding: '4px' },
  routeField: { flex: 1, display: 'flex', flexDirection: 'column', gap: '2px', padding: '10px 16px' },

  popularRoutesRow: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' as const },
  popularRoutesLabel: { fontSize: '11.5px', color: '#9CA3AF', fontWeight: 500 },
  popularRouteChip: {
    fontSize: '11.5px', fontWeight: 600, color: '#3730A3', background: '#EEF2FF',
    border: '1px solid #E0E7FF', borderRadius: '20px', padding: '5px 12px', cursor: 'pointer',
  },
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
  spinner: { width: '13px', height: '13px', border: '2px solid rgba(255,255,255,0.4)', borderTopColor: '#fff', borderRadius: '50%', display: 'inline-block', animation: 'spin 0.7s linear infinite' },

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
  // Matches nothing, so it cannot be clicked into an empty results list.
  filterChipDead: { color: '#D1D5DB', background: '#F9FAFB', borderColor: '#F3F4F6', cursor: 'not-allowed' },
  filterChipCount: { opacity: 0.6, fontVariantNumeric: 'tabular-nums' },
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
  // Caps at roughly three rows and scrolls beyond that, while Done stays put
  // below it. maxHeight is in rem so it tracks the user's text size rather than
  // clipping when they have scaled it up.
  travelerRows: { maxHeight: '11rem', overflowY: 'auto' as const },
  travelerRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '5px 0' },
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
    width: '100%', height: '32px', marginTop: '8px', background: '#000835', color: '#fff',
    fontSize: '12px', fontWeight: 600, border: 'none', borderRadius: '8px', cursor: 'pointer',
  },
  travelerDismissHint: { fontSize: '10.5px', color: '#9CA3AF', textAlign: 'center' as const, margin: '6px 0 0' },
}