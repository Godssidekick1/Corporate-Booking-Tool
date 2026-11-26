'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import AirportDropdown from '@/app/components/AirportDropdown'
import { flowStorage, type OnBehalf } from '@/app/lib/book/flowStorage'
import SearchableSelect from '@/app/components/SearchableSelect'
import { useLookup } from '@/app/hooks/useLookup'
import TripPicker, { resolveTrip, type TripChoice } from '@/app/components/TripPicker'
import TravellersPopover, { useDismiss } from '@/app/components/book/search/TravellersPopover'
import { searchPreferences } from '@/app/lib/book/searchPreferences'
import { isoDay, queryProblem, resultsHrefFor, type Cabin, type SearchQuery } from '@/app/lib/book/searchQuery'
import DateInput, { type DateInputHandle } from '@/app/components/date/DateInput'

// The date fields keep this form's input look.
const dateTrigger: React.CSSProperties = { height: 42, borderRadius: 9, background: '#F9FAFB', borderColor: '#E5E7EB', fontWeight: 500 }

// ── /book/flights: the search ────────────────────────────────────────────────
// Who is travelling, why, and where to. Searching opens the results page
// (/book/flights/results), whose address carries the search; the airline is
// asked there. What stays here is everything that is not the route: the
// traveller (a colleague, a guest), the trip it goes under and its purpose.
// Coming back ("Change" on the results) finds the last search filled in.
// ─────────────────────────────────────────────────────────────────────────────

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
  const [departDate, setDepartDate] = useState(() => isoDay())
  const returnPicker = useRef<DateInputHandle>(null)
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
  const closeTravelers = useCallback(() => setTravelersOpen(false), [])
  useDismiss(travelersRef, travelersOpen, closeTravelers)
  const [cabinPref, setCabinPref] = useState<Cabin>('Economy')
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
    // Back from the results ("Change"): this tab's last search, dates and all,
    // unless its departure has passed.
    const last = flowStorage.getSearchMeta()?.query
    if (last && last.departDate >= isoDay()) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reading sessionStorage, which the server render cannot see
      setOrigin(last.origin); setDestination(last.destination)
      setDepartDate(last.departDate)
      setTripType(last.returnDate ? 'return' : 'oneway'); setReturnDate(last.returnDate ?? '')
      setAdult(last.adult); setChild(last.child); setInfant(last.infant)
      setCabinPref(last.cabin)
      return
    }

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

  // Set while the results page is being opened (a new trip is made first).
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState('')

  function swapOriginDestination() {
    setOrigin(destination)
    setDestination(origin)
  }

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault()
    // Searching means they are done choosing travellers.
    setTravelersOpen(false)
    const query: SearchQuery = {
      origin, destination, departDate,
      returnDate: tripType === 'return' ? returnDate : null,
      adult, child, infant, cabin: cabinPref,
    }
    const wrong = queryProblem(query, isoDay())
    if (wrong) { setError(wrong); return }
    setSearching(true)
    setError('')
    try {
      // A new trip for the colleague is created now, the first moment it is
      // certainly wanted; once made it is an existing one.
      if (who && trip.kind === 'new' && !personal) {
        let id: string | null
        try {
          id = await resolveTrip(who.travellerId, trip)
        } catch (err) {
          setError((err as Error).message)
          setSearching(false)
          return
        }
        flowStorage.setTripId(id, who.travellerId)
        setTrip(id ? { kind: 'existing', id } : { kind: 'none' })
      }
      // A guest is typed in by hand; a colleague's details come from their
      // profile (the passenger page reads flowStorage.onBehalf).
      flowStorage.setGuestBooking(who ? false : !bookingForSelf)
      // A personal trip is the traveller's own: never inside a business trip.
      flowStorage.setPurpose(personal ? 'personal' : 'business')
      if (personal) flowStorage.setTripId(null)
      // The results page asks the airline (and keeps the list for the later
      // steps and "Back to results"). Always afresh from here: the traveller
      // may have changed, and their policy shapes the list.
      flowStorage.dropResults()
      router.push(resultsHrefFor(query))
    } catch {
      setError('Something went wrong. Please try again.')
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
                {/* Our own calendar (app/components/date): two months, the
                    return drawn in on a round trip, which opens next. */}
                <DateInput value={departDate} min={isoDay()} label="Departure" months={2} style={dateTrigger}
                  range={tripType === 'return' ? { start: departDate, end: returnDate, role: 'start' } : undefined}
                  rangeLabels={tripType === 'return' ? { start: 'Depart', end: 'Return' } : undefined}
                  onChange={d => {
                    setDepartDate(d)
                    // A return before the new departure moves with it.
                    if (returnDate && returnDate < d) setReturnDate(d)
                  }}
                  onPicked={() => { if (tripType === 'return') returnPicker.current?.open() }} />
              </div>

              {tripType === 'return' && (
                <div style={s.field}>
                  <label style={s.label}>Return</label>
                  {/* Can't return before you leave. Same day is allowed: a day
                      trip out and back is an ordinary corporate booking. */}
                  <DateInput value={returnDate} min={departDate} label="Return" months={2} style={dateTrigger}
                    placeholder="Choose a return date" handleRef={returnPicker}
                    range={{ start: departDate, end: returnDate, role: 'end' }}
                    rangeLabels={{ start: 'Depart', end: 'Return' }}
                    onChange={setReturnDate} />
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
                  <TravellersPopover
                    value={{ adult, child, infant }}
                    onChange={v => { setAdult(v.adult); setChild(v.child); setInfant(v.infant) }}
                    onDone={closeTravelers}
                  />
                )}
              </div>

              <div style={s.field}>
                <label style={s.label}>Cabin</label>
                <select value={cabinPref} onChange={e => setCabinPref(e.target.value as Cabin)} style={s.input}>
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
}