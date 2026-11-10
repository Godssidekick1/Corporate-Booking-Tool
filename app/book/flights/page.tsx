'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import AirportDropdown from '@/app/components/AirportDropdown'
import { flowStorage, type OnBehalf } from '@/app/lib/book/flowStorage'
import SearchableSelect from '@/app/components/SearchableSelect'
import { useLookup } from '@/app/hooks/useLookup'
import TripPicker, { resolveTrip, type TripChoice } from '@/app/components/TripPicker'
import { searchPreferences } from '@/app/lib/book/searchPreferences'
import type { FareOption, FlatFlightResult } from '@/app/lib/book/types'
import FlightResults from '@/app/components/book/FlightResults'

function toApiDate(input: string) {
  const [y, m, d] = input.split('-')
  return `${d}/${m}/${y}`
}

function toDisplayDate(input: string) {
  if (!input) return ''
  const d = new Date(input)
  return d.toLocaleDateString('en-IN', { weekday: 'short', day: '2-digit', month: 'short' })
}

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

  // ── Who's travelling (booking on someone's behalf) ─────────────────────────
  // A corporate admin may book for a colleague, whose policy and approval
  // chain then apply (app/lib/book/bookingActor.ts); the travel desk chose its
  // traveller on /tmc/book already. Read after mount: sessionStorage and the
  // caller's role are not available to the server render.
  const [who, setWho] = useState<OnBehalf | null>(null)
  const [isAdmin, setIsAdmin] = useState(false)
  const [meId, setMeId] = useState('')
  const [mode, setMode] = useState<'me' | 'colleague' | 'guest'>('me')
  const [colleagueId, setColleagueId] = useState('')
  // The colleague's trip this goes under: theirs, not the admin's (TripPicker).
  const [trip, setTrip] = useState<TripChoice>({ kind: 'none' })

  // How the traveller's company books (Corporate Settings): a personal trip
  // and a guest booking are offered only where allowed. add-passenger checks
  // both again; this only keeps the page from offering what it would refuse.
  const [controls, setControls] = useState<{ personalAllowed: boolean; guestAllowed: boolean } | null>(null)
  const [purpose, setPurpose] = useState<'business' | 'personal'>('business')
  const personal = purpose === 'personal' && controls?.personalAllowed === true
  const guestAllowed = controls?.guestAllowed !== false
  useEffect(() => {
    let live = true
    const q = who?.travellerId ? `?travellerId=${encodeURIComponent(who.travellerId)}` : ''
    fetch(`/api/book/controls${q}`).then(r => r.json()).then(d => {
      if (!live || !d.ok) return
      setControls(d)
      // A guest booking the company does not allow is not left selected.
      if (!d.guestAllowed) {
        setBookingForSelf(true)
        setMode(m => (m === 'guest' ? 'me' : m))
      }
    }).catch(() => {})
    return () => { live = false }
  }, [who?.travellerId])

  function chooseTrip(choice: TripChoice) {
    setTrip(choice)
    // An existing trip or none applies now; a new one is created at search.
    if (choice.kind !== 'new') flowStorage.setTripId(choice.kind === 'existing' ? choice.id : null, who?.travellerId ?? null)
  }
  const colleagueLookup = useLookup('/api/book/travellers', colleagueId, {
    enabled: isAdmin && mode === 'colleague',
    toOption: row => ({
      id: String(row.id),
      label: String(row.full_name),
      sublabel: [row.band_code, row.department, row.email].filter(Boolean).join(' · ') || undefined,
    }),
  })
  useEffect(() => {
    fetch('/api/me').then(r => r.json()).then(d => {
      const me: string = d.employee?.id ?? ''
      setMeId(me)
      setIsAdmin(d.employee?.role === 'admin')
      // Only the person who chose a traveller books for them: a choice left in
      // this tab by someone else (another account, signed in here before) is
      // dropped by claim(), and this person starts by booking for themself.
      flowStorage.claim(me)
      const saved = flowStorage.onBehalf()
      setWho(saved)
      if (saved) {
        setMode('colleague'); setColleagueId(saved.travellerId)
        // Their trip, when one is already chosen (the trip page's + Add flight).
        const tripId = flowStorage.getTripId()
        if (tripId) setTrip({ kind: 'existing', id: tripId })
      }
    }).catch(() => {})
  }, [])

  function chooseMode(next: 'me' | 'colleague' | 'guest') {
    setMode(next)
    setBookingForSelf(next === 'me')
    if (next !== 'colleague') { flowStorage.setOnBehalf(null); setWho(null); setColleagueId('') }
  }

  async function chooseColleague(id: string) {
    setColleagueId(id)
    if (!id) { flowStorage.setOnBehalf(null); setWho(null); return }
    const d = await fetch(`/api/book/travellers/${id}`).then(r => r.json()).catch(() => null)
    if (!d?.ok) { setError(d?.error || 'Could not load that colleague.'); return }
    const next: OnBehalf = {
      bookerId: meId, travellerId: d.traveller.id, name: d.traveller.full_name, clientName: d.traveller.client_name,
      bandCode: d.traveller.band_code, policy: d.policy, home: '/bookings',
    }
    // A different traveller: anything priced so far was for someone else, and
    // a trip the admin started from is the admin's -- clearFlow drops both.
    flowStorage.clearFlow()
    flowStorage.setOnBehalf(next)
    setWho(next)
    setTrip({ kind: 'none' })
  }

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
    // A trip in the address is one's own: + Add flight on the trips page. It
    // is not sent while booking for a colleague (flowStorage.getTripId).
    if (tripId) flowStorage.setTripId(tripId, null)
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
  const [navigatingKey, setNavigatingKey] = useState<string | null>(null)

  // Airlines the traveller's policy left out of the results (named in the filters).
  const [hiddenByPolicy, setHiddenByPolicy] = useState<{ code: string; name: string }[]>([])
  // A new search starts the results with no filters, sort or open cards.
  const [searchSeq, setSearchSeq] = useState(0)

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

  function swapOriginDestination() {
    setOrigin(destination)
    setDestination(origin)
  }

  function handleChooseFare(flight: FlatFlightResult, fare: FareOption) {
    // Nothing to price here: that is the next page's job. The fare chosen in
    // the card goes in the URL, so the fare page opens with it selected (and a
    // refresh keeps it).
    setNavigatingKey(flight.flightKey)
    const query = fare.pricingKey ? `?fare=${encodeURIComponent(fare.pricingKey)}` : ''
    router.push(`/book/price/${encodeURIComponent(flight.flightKey)}${query}`)
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
      // A new trip for the colleague is created now, the first moment it is
      // certainly wanted; once made it is an existing one.
      if (who && trip.kind === 'new' && !personal) {
        let id: string | null
        try {
          id = await resolveTrip(who.travellerId, trip)
        } catch (err) {
          setError((err as Error).message)
          return
        }
        flowStorage.setTripId(id, who.travellerId)
        setTrip(id ? { kind: 'existing', id } : { kind: 'none' })
      }
      const res = await fetch('/api/book/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // Booking for someone else: whose (bookingActor); absent = oneself.
          travellerId: flowStorage.travellerId(),
          origin, destination,
          departDate: toApiDate(departDate),
          tripType,
          // Sent only when it is actually a round trip, so switching back to
          // one way can't leave a stale return date behind in the request.
          returnDate: tripType === 'return' ? toApiDate(returnDate) : undefined,
          // The selector has existed since this page was written and its value
          // has never left the browser, which is why every search came back
          // economy whatever was picked.
          cabin: cabinPref,
          adult, child, infant,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        // The airline's own wording comes back to the travel desk only
        // (app/lib/book/providerErrors.ts); everyone else gets the plain line.
        const forDesk = data.provider?.message ? ` Airline system: ${data.provider.message}` : ''
        setError(`${data.error || 'Search failed.'}${forDesk}`)
        return
      }

      const foundResults: FlatFlightResult[] = data.results ?? []
      setResults(foundResults)
      setHiddenByPolicy(data.hiddenByPolicy ?? [])
      setSearchSeq(n => n + 1)
      setHasSearched(true)
      searchPreferences.saveLastSearch({ origin, destination, adult, child, infant, cabinPref })
      // A guest is typed in by hand; a colleague's details come from their
      // profile (the passenger page reads flowStorage.onBehalf).
      flowStorage.setGuestBooking(who ? false : !bookingForSelf)
      // A personal trip is the traveller's own: never inside a business trip.
      flowStorage.setPurpose(personal ? 'personal' : 'business')
      if (personal) flowStorage.setTripId(null)

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

          {who?.home === '/tmc/book' ? null : isAdmin ? (
            // A corporate admin: themself, a colleague (whose policy and chain
            // apply), or a guest who is not an employee (typed in by hand,
            // under the admin's own policy).
            <div style={s.whoRow}>
              <span style={s.selfToggleText}>Who&apos;s travelling?</span>
              <div style={s.whoToggle}>
                {(['me', 'colleague', 'guest'] as const).filter(m => m !== 'guest' || guestAllowed).map(m => (
                  <button key={m} type="button" onClick={() => chooseMode(m)}
                    style={{ ...s.whoBtn, ...(mode === m ? s.whoBtnOn : {}) }}>
                    {m === 'me' ? 'Me' : m === 'colleague' ? 'A colleague' : 'A guest'}
                  </button>
                ))}
              </div>
              {mode === 'colleague' && (
                <div style={{ minWidth: 260, flex: 1, maxWidth: 380 }}>
                  <SearchableSelect
                    value={colleagueId}
                    onChange={chooseColleague}
                    options={colleagueLookup.options}
                    onSearch={colleagueLookup.onSearch}
                    loading={colleagueLookup.loading}
                    selectedLabel={colleagueLookup.selectedLabel || who?.name || ''}
                    placeholder="Search colleagues by name, email or department…"
                    emptyMessage="No colleague matches"
                  />
                </div>
              )}
              {mode === 'colleague' && who && !personal && (
                <div style={{ minWidth: 240, maxWidth: 340 }}>
                  <TripPicker travellerId={who.travellerId} travellerName={who.name} value={trip} onChange={chooseTrip} />
                </div>
              )}
              {mode === 'guest' && (
                <span style={s.selfToggleText}>Not an employee — enter their details on the passenger page.</span>
              )}
            </div>
          ) : !guestAllowed ? null : (
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
          )}

          {controls?.personalAllowed && (
            <div style={s.whoRow}>
              <span style={s.selfToggleText}>Trip purpose</span>
              <div style={s.whoToggle}>
                {(['business', 'personal'] as const).map(p => (
                  <button key={p} type="button" onClick={() => setPurpose(p)}
                    style={{ ...s.whoBtn, ...(purpose === p ? s.whoBtnOn : {}) }}>
                    {p === 'business' ? 'Business' : 'Personal'}
                  </button>
                ))}
              </div>
              {personal && (
                <span style={s.selfToggleText}>A personal trip: not checked against company policy, no approval, paid by the traveller&apos;s own card.</span>
              )}
            </div>
          )}

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
            <FlightResults
              key={searchSeq}
              results={results}
              hiddenByPolicy={hiddenByPolicy}
              navigatingKey={navigatingKey}
              onChoose={handleChooseFare}
            />
          )
        )}
      </div>
    </div>
  )
}



const s: Record<string, React.CSSProperties> = {
  page: { background: '#F9FAFB', minHeight: '100vh' },
  root: { fontFamily: "'Inter', -apple-system, sans-serif", maxWidth: '1180px', margin: '0 auto', padding: '32px 24px 64px' },

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
  whoRow: { display: 'flex', alignItems: 'center', gap: '10px 14px', flexWrap: 'wrap', marginBottom: '14px' },
  whoToggle: { display: 'flex', background: '#F3F4F6', borderRadius: '8px', padding: '3px' },
  whoBtn: { border: 'none', background: 'transparent', fontSize: '12.5px', color: '#6B7280', padding: '5px 12px', borderRadius: '6px', cursor: 'pointer' },
  whoBtnOn: { background: '#fff', color: '#111827', fontWeight: 600, boxShadow: '0 1px 2px rgba(0,0,0,0.06)' },

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


  // Matches nothing, so it cannot be clicked into an empty results list.







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