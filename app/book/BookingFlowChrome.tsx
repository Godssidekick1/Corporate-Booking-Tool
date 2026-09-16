'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { flowStorage } from '@/app/lib/book/flowStorage'

// ── Booking flow chrome ──────────────────────────────────────────────────────
// A step indicator and two permanent exits, wrapped around every page of the
// flight booking flow.
//
// WHY THIS EXISTS. There was no app/book/layout.tsx and the root layout renders
// a bare <body>{children}</body>, so every page in the booking flow rendered
// with ZERO navigation — no nav bar, no breadcrumb, no dashboard link. The
// search page in particular had not a single <Link> on it. Once a traveller
// entered the flow, the only ways out were the browser back button (hijacked on
// two of the pages) and typing a URL.
//
// That is what made the error states dead ends. Most of them were not missing
// an escape hatch of their own so much as sitting inside a shell that offered
// none, so each page had to grow its own — and three of them grew links reading
// "Search again" that pointed at /book, which is the TRIPS LIST, not a search
// form. Putting the exits in one place fixes every page at once and removes the
// chance of a fourth wrong link.
//
// The step indicator is not decoration: it tells someone who has been bounced
// by an error which step they are on, which is the question they ask first.
// ─────────────────────────────────────────────────────────────────────────────

const STEPS = [
  { key: 'flights', label: 'Search',     match: (p: string) => p.startsWith('/book/flights') },
  { key: 'price',   label: 'Fare',       match: (p: string) => p.startsWith('/book/price') },
  { key: 'details', label: 'Passengers', match: (p: string) => p.startsWith('/book/details') },
  { key: 'confirm', label: 'Confirm',    match: (p: string) => p.startsWith('/book/confirm') },
  { key: 'ticket',  label: 'Ticket',     match: (p: string) => p.startsWith('/book/ticket') },
] as const

export default function BookingFlowChrome({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? ''
  const [searchHref, setSearchHref] = useState('/book/flights')

  const activeIndex = STEPS.findIndex(step => step.match(pathname))

  // Keep the trip the traveller started in. Without this, leaving the flow to
  // search again drops the tripId and the next booking attaches to nothing —
  // they would have to go back to the trip and start from "+ Add flight".
  //
  // Read in an effect rather than during render: sessionStorage does not exist
  // on the server, and reading it in the render body is what makes a page
  // hydrate with different markup than it was sent.
  useEffect(() => {
    const tripId = flowStorage.getTripId()
    // Synchronising state to an external store the server cannot see, which is
    // the case this rule carves out — same disable and same reason as
    // usePagedList's page clamp.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (tripId) setSearchHref(`/book/flights?tripId=${encodeURIComponent(tripId)}`)
  }, [pathname])

  // The trips list at /book is not a step in this flow — it is where trips are
  // created. Wrapping it in a booking stepper would claim the traveller is
  // mid-booking when they have not started one.
  if (activeIndex === -1) return <>{children}</>

  return (
    <div style={s.shell}>
      <header style={s.bar}>
        <nav style={s.steps} aria-label="Booking progress">
          {STEPS.map((step, i) => (
            <div key={step.key} style={s.step}>
              <span
                style={{
                  ...s.stepDot,
                  ...(i < activeIndex ? s.stepDotDone : {}),
                  ...(i === activeIndex ? s.stepDotActive : {}),
                }}
              />
              <span
                style={{
                  ...s.stepLabel,
                  ...(i === activeIndex ? s.stepLabelActive : {}),
                }}
                aria-current={i === activeIndex ? 'step' : undefined}
              >
                {step.label}
              </span>
              {i < STEPS.length - 1 && <span style={s.stepRule} />}
            </div>
          ))}
        </nav>

        <div style={s.exits}>
          {/* Deliberately /book/flights, not /book. Three pages in this flow
              linked to /book under the label "Search again" — /book is the
              trips list, so every one of them landed a traveller who wanted to
              search on a page with no search box.

              clearFlow() on the way out: this is the one click that means "I am
              abandoning this booking", so it is where the stale priced fare and
              the trip binding get dropped. The tripId is read BEFORE clearing
              and carried in the href, so the traveller stays inside the trip
              they were booking for — it is the binding to a HALF-FINISHED
              booking that leaks, not the trip itself. */}
          <Link href={searchHref} onClick={() => flowStorage.clearFlow()} style={s.exitLink}>
            Start a new search
          </Link>
          <Link href="/dashboard" style={s.exitLinkMuted}>Dashboard</Link>
        </div>
      </header>

      {children}
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  shell: { minHeight: '100vh' },
  bar: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    flexWrap: 'wrap', gap: '12px 20px',
    padding: '12px 24px', background: '#fff', borderBottom: '1px solid #E5E7EB',
    position: 'sticky', top: 0, zIndex: 20,
  },
  steps: { display: 'flex', alignItems: 'center', gap: '4px', flexWrap: 'wrap' },
  step: { display: 'flex', alignItems: 'center', gap: '6px' },
  stepDot: {
    width: '7px', height: '7px', borderRadius: '50%',
    background: '#D1D5DB', flexShrink: 0,
  },
  stepDotDone: { background: '#22C55E' },
  stepDotActive: { background: '#000835' },
  stepLabel: { fontSize: '12px', color: '#9CA3AF', whiteSpace: 'nowrap' },
  stepLabelActive: { color: '#000835', fontWeight: 600 },
  stepRule: { width: '18px', height: '1px', background: '#E5E7EB', margin: '0 6px' },
  exits: { display: 'flex', alignItems: 'center', gap: '16px' },
  exitLink: { fontSize: '12.5px', fontWeight: 600, color: '#000835', textDecoration: 'none' },
  exitLinkMuted: { fontSize: '12.5px', color: '#6B7280', textDecoration: 'none' },
}
