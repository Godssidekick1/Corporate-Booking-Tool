'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import SearchEditBar from '@/app/components/book/search/SearchEditBar'
import { runSearch, type Found } from '@/app/components/book/search/runSearch'
import FlightResults from '@/app/components/book/FlightResults'
import RoundTripPicker from '@/app/components/book/RoundTripPicker'
import { SearchLoader } from '@/app/components/book/Takeoff'
import { flowStorage, type RoundTripPair } from '@/app/lib/book/flowStorage'
import { displayDate, parseQuery, resultsHrefFor, type SearchQuery } from '@/app/lib/book/searchQuery'
import type { FareOption, FlatFlightResult } from '@/app/lib/book/types'

// ── /book/flights/results ────────────────────────────────────────────────────
// The flights a search found. The search is in the address (searchQuery.ts),
// so a refresh, Back and every "Back to results" link come back here to the
// same list: the one already in this tab when it is the same search and still
// fresh, else asked of the airline again. The edit bar above changes the
// search in place. Who is travelling and why were chosen on the search page
// (/book/flights) and are named in the heading row, with a way back to change
// them.
// ─────────────────────────────────────────────────────────────────────────────

// How long a list is reused without asking the airline again. Availability
// moves; a quarter of an hour is what a traveller comparing fares needs.
const REUSE_MS = 15 * 60 * 1000

type Status = 'idle' | 'searching' | 'done' | 'error'

export default function FlightResultsPage() {
  const router = useRouter()
  const [query, setQuery] = useState<SearchQuery | null>(null)
  const [status, setStatus] = useState<Status>('idle')
  const [found, setFound] = useState<Found | null>(null)
  const [error, setError] = useState('')
  // A new search starts the list with no filters, sort or open cards.
  const [searchSeq, setSearchSeq] = useState(0)
  const [navigatingKey, setNavigatingKey] = useState<string | null>(null)
  const [context, setContext] = useState<{ bookingFor: string; personal: boolean } | null>(null)
  // Only the latest search's answer is shown: an earlier one that answers late
  // is dropped.
  const latest = useRef(0)

  const search = useCallback(async (q: SearchQuery) => {
    const mine = ++latest.current
    setStatus('searching')
    setError('')
    const outcome = await runSearch(q)
    if (mine !== latest.current) return
    if (!outcome.ok) { setError(outcome.error); setStatus('error'); return }
    setFound(outcome)
    setSearchSeq(n => n + 1)
    setStatus('done')
  }, [])

  // The address is read once, on arrival (not through useSearchParams: right
  // after a client navigation it can lag the address bar; see the search
  // page). A changed search updates the address itself, below.
  useEffect(() => {
    const q = parseQuery(window.location.search)
    if (!q) { router.replace('/book/flights'); return }
    const who = flowStorage.onBehalf()
    /* eslint-disable react-hooks/set-state-in-effect -- reading the address and
       sessionStorage, which the server render cannot see */
    setQuery(q)
    setContext({
      bookingFor: who?.name ?? (flowStorage.isGuestBooking() ? 'A guest' : 'Me'),
      personal: flowStorage.getPurpose() === 'personal',
    })
    const fresh = flowStorage.freshResults(q, REUSE_MS)
    if (fresh) {
      setFound({ results: fresh.results ?? [], split: fresh.split ?? null, hiddenByPolicy: fresh.hiddenByPolicy ?? [] })
      setStatus('done')
    } else {
      void search(q)
    }
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [router, search])

  function changeSearch(next: SearchQuery) {
    setQuery(next)
    // Replaced, not pushed: Back leaves the results rather than stepping
    // through every search tried here.
    router.replace(resultsHrefFor(next), { scroll: false })
    void search(next)
  }

  function handleChooseFare(flight: FlatFlightResult, fare: FareOption) {
    // Nothing to price here: that is the next page's job. The fare chosen in
    // the card goes in the URL, so the fare page opens with it selected (and a
    // refresh keeps it).
    setNavigatingKey(flight.flightKey)
    const q = fare.pricingKey ? `?fare=${encodeURIComponent(fare.pricingKey)}` : ''
    router.push(`/book/price/${encodeURIComponent(flight.flightKey)}${q}`)
  }

  // A domestic round trip's two picks: both are priced together on the next page.
  function handleContinuePair(pair: RoundTripPair) {
    flowStorage.savePair(pair)
    setNavigatingKey(pair.onward.flightKey)
    router.push('/book/price/round-trip')
  }

  if (!query) return <div style={s.page} />


  const split = found?.split ?? null
  const route = query.returnDate ? `${query.origin} ⇄ ${query.destination}` : `${query.origin} → ${query.destination}`
  const dates = query.returnDate ? `${displayDate(query.departDate)} – ${displayDate(query.returnDate)}` : displayDate(query.departDate)
  const summary = status !== 'done' || !found ? null
    : split ? `${split.onward?.results.length ?? 0} onward · ${split.return?.results.length ?? 0} return flights`
    : `${found.results.length} flight${found.results.length === 1 ? '' : 's'}`

  return (
    <div style={s.page}>
      <div style={s.root}>
        <SearchEditBar query={query} busy={status === 'searching'} onSearch={changeSearch} />

        <div style={s.heading}>
          <span style={s.headingText}>
            <b style={s.route}>{route}</b> · {dates}
            {summary && <> · {summary}</>}
          </span>
          {context && (
            <span style={s.chips}>
              <span style={s.chip}>Booking for <b style={s.chipStrong}>{context.bookingFor}</b></span>
              {context.personal && <span style={s.chip}><b style={s.chipStrong}>Personal trip</b></span>}
              <Link href="/book/flights" style={s.change}>Change</Link>
            </span>
          )}
        </div>

        {status === 'error' && (
          <div style={s.errorBanner} role="alert">
            <span aria-hidden="true">⚠</span>
            <span>{error}</span>
            <button type="button" style={s.retry} onClick={() => void search(query)}>Try again</button>
          </div>
        )}

        {/* Keyed by the search: a new one starts its steps again. */}
        {status === 'searching' && (
          <SearchLoader key={resultsHrefFor(query)} route={route} dates={dates} />
        )}

        {status === 'done' && found && split && (
          !split.onward?.results.length && !split.return?.results.length && !split.specialReturn?.results.length ? (
            <div style={s.empty}>
              <p style={s.emptyTitle}>No flights found</p>
              <p style={s.emptyDesc}>{split.notes[0] ?? 'Try different dates or another route.'}</p>
            </div>
          ) : (
            <RoundTripPicker key={searchSeq} split={split} navigatingKey={navigatingKey}
              onChooseSpecial={handleChooseFare} onContinue={handleContinuePair} />
          )
        )}

        {status === 'done' && found && !split && (
          found.results.length === 0 ? (
            <div style={s.empty}>
              <p style={s.emptyTitle}>No flights found</p>
              <p style={s.emptyDesc}>Try a different date or route above.</p>
            </div>
          ) : (
            <FlightResults key={searchSeq} results={found.results} hiddenByPolicy={found.hiddenByPolicy}
              navigatingKey={navigatingKey} onChoose={handleChooseFare} />
          )
        )}
      </div>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  page: { background: 'var(--color-canvas)', minHeight: '100vh' },
  root: { fontFamily: "'Inter', -apple-system, sans-serif", maxWidth: '1440px', margin: '0 auto', padding: '0 max(16px, 2vw) 64px' },

  heading: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px 16px', flexWrap: 'wrap', margin: '2px 0 14px' },
  headingText: { fontSize: '13px', color: 'var(--color-secondary)' },
  route: { fontSize: '15px', color: 'var(--color-ink)' },
  chips: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
  chip: { fontSize: '12px', color: 'var(--color-body)', background: 'var(--color-surface)', border: '1px solid var(--color-line)', borderRadius: '999px', padding: '4px 10px' },
  chipStrong: { color: 'var(--color-ink)', fontWeight: 600 },
  change: { fontSize: '12px', fontWeight: 600, color: 'var(--color-info-fg)', textDecoration: 'none' },

  errorBanner: {
    display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', background: 'var(--color-danger-bg)',
    border: '1px solid var(--color-danger-line)', borderRadius: '10px', padding: '11px 14px', fontSize: '13px',
    color: 'var(--color-danger-fg)', marginBottom: '16px',
  },
  retry: { marginLeft: 'auto', border: '1px solid var(--color-danger-line)', background: 'var(--color-surface)', color: 'var(--color-danger-fg)', borderRadius: '8px', padding: '5px 12px', fontSize: '12.5px', fontWeight: 600, cursor: 'pointer' },


  empty: { textAlign: 'center', padding: '56px 20px', background: 'var(--color-surface)', border: '1px solid var(--color-line)', borderRadius: '14px' },
  emptyTitle: { fontSize: '15px', fontWeight: 600, color: 'var(--color-body)', margin: '0 0 6px' },
  emptyDesc: { fontSize: '13px', color: 'var(--color-muted)', margin: 0 },
}
