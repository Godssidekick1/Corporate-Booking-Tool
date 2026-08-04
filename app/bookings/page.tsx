'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { formatTime, formatDayLabel } from '@/app/lib/book/types'

// ── /bookings — "My trips" ────────────────────────────────────────────────────
// This is the page the dashboard already links to (both the nav item and the
// "Recent bookings" section's "View all" link point at /bookings) — not a new
// route, just replacing the ComingSoonStub that was sitting here with a real
// implementation.
//
// Scoped to the logged-in employee's own bookings (see /api/bookings) — this
// is a personal trip list, matching "My trips" in the dashboard nav. A
// company/team-wide view is a separate reporting concern, not this page.
// ─────────────────────────────────────────────────────────────────────────────

interface BookingSummary {
  id: string
  status: string
  pnr: string | null
  total_cost: number | null
  created_at: string
  itinerary: {
    origin?: { code: string; city: string; dateTime: string }
    destination?: { code: string; city: string; dateTime: string }
    stopCount?: number
  } | null
  traveler_snapshot: {
    PassengerDetails: { FirstName: string; LastName: string }[]
  } | null
  fare_breakdown: { currency: string } | null
}

const STATUS_META: Record<string, { label: string; color: string; bg: string }> = {
  ticketed:         { label: 'Ticketed',        color: '#166534', bg: '#DCFCE7' },
  held:             { label: 'Booked',          color: '#1E40AF', bg: '#DBEAFE' },
  passenger_added:  { label: 'In progress',     color: '#92400E', bg: '#FEF3C7' },
  priced:           { label: 'In progress',     color: '#92400E', bg: '#FEF3C7' },
  not_evaluated:    { label: 'Pending policy',  color: '#92400E', bg: '#FEF3C7' },
  pending_approval: { label: 'Pending approval', color: '#92400E', bg: '#FEF3C7' },
  failed:           { label: 'Failed',          color: '#991B1B', bg: '#FEE2E2' },
  cancelled:        { label: 'Cancelled',       color: '#6B7280', bg: '#F3F4F6' },
}

function statusMeta(status: string) {
  return STATUS_META[status] ?? { label: status, color: '#6B7280', bg: '#F3F4F6' }
}

// Where a booking should route to when clicked — matches the step it's
// currently sitting at, so "My trips" can act as a resume point too, not
// just a read-only history.
function resumeHref(booking: BookingSummary): string {
  if (booking.status === 'ticketed') return `/book/ticket/${booking.id}`
  if (booking.status === 'held') return `/book/ticket/${booking.id}`
  if (booking.status === 'passenger_added') return `/book/confirm/${booking.id}`
  return `/book/ticket/${booking.id}` // failed/cancelled/other: land on ticket page, which shows the right state/error
}

export default function BookingsPage() {
  const [bookings, setBookings] = useState<BookingSummary[] | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    loadBookings()
  }, [])

  async function loadBookings() {
    setError('')
    try {
      const res = await fetch('/api/bookings')
      const data = await res.json()
      if (!res.ok) {
        setError(data.error || 'Could not load your trips.')
        return
      }
      setBookings(data.bookings)
    } catch {
      setError('Something went wrong loading your trips.')
    }
  }

  return (
    <div style={s.page}>
      <div style={s.root}>
        <div style={s.header}>
          <h1 style={s.heading}>My trips</h1>
          <Link href="/book" style={s.newTripBtn}>+ New booking</Link>
        </div>

        {error && (
          <div style={s.errorCard}>
            <p style={s.errorText}>⚠ {error}</p>
          </div>
        )}

        {!bookings && !error && (
          <div style={s.loadingCard}>
            <div style={s.spinner} />
          </div>
        )}

        {bookings && bookings.length === 0 && (
          <div style={s.emptyState}>
            <div style={s.emptyIcon}>✈</div>
            <p style={s.emptyTitle}>No trips yet</p>
            <p style={s.emptyDesc}>Your bookings will show up here once you book a flight.</p>
            <Link href="/book" style={s.emptyCta}>Book your first flight →</Link>
          </div>
        )}

        {bookings && bookings.length > 0 && (
          <div style={s.list}>
            {bookings.map(booking => {
              const meta = statusMeta(booking.status)
              const it = booking.itinerary
              const travelers = booking.traveler_snapshot?.PassengerDetails ?? []
              const currency = booking.fare_breakdown?.currency ?? ''

              return (
                <Link key={booking.id} href={resumeHref(booking)} style={s.card}>
                  <div style={s.cardTop}>
                    <div style={s.routeBlock}>
                      {it?.origin && it?.destination ? (
                        <>
                          <span style={s.routeCode}>{it.origin.code}</span>
                          <span style={s.routeArrow}>→</span>
                          <span style={s.routeCode}>{it.destination.code}</span>
                          {(it.stopCount ?? 0) > 0 && (
                            <span style={s.stopBadge}>{it.stopCount} stop{it.stopCount === 1 ? '' : 's'}</span>
                          )}
                        </>
                      ) : (
                        <span style={s.routeCode}>Flight booking</span>
                      )}
                    </div>
                    <span style={{ ...s.statusBadge, color: meta.color, background: meta.bg }}>{meta.label}</span>
                  </div>

                  <div style={s.cardBody}>
                    <div style={s.cardDetail}>
                      {it?.origin?.dateTime && (
                        <span>{formatDayLabel(it.origin.dateTime)} · {formatTime(it.origin.dateTime)}</span>
                      )}
                      {travelers.length > 0 && (
                        <span style={s.dot}>
                          {travelers.length} traveler{travelers.length === 1 ? '' : 's'}
                        </span>
                      )}
                      {booking.pnr && <span style={s.dot}>PNR {booking.pnr}</span>}
                    </div>
                    {booking.total_cost != null && (
                      <span style={s.cardFare}>{currency} {booking.total_cost.toLocaleString('en-IN')}</span>
                    )}
                  </div>
                </Link>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  page: { background: '#F9FAFB', minHeight: '100vh' },
  root: { fontFamily: "'Inter', -apple-system, sans-serif", maxWidth: '720px', margin: '0 auto', padding: '32px 24px 64px' },

  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' },
  heading: { fontSize: '22px', fontWeight: 700, color: '#0A0A14', margin: 0, letterSpacing: '-0.4px' },
  newTripBtn: {
    fontSize: '13px', fontWeight: 600, color: '#fff', background: '#000835',
    padding: '9px 16px', borderRadius: '9px', textDecoration: 'none',
  },

  errorCard: { padding: '16px', background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: '12px', marginBottom: '16px' },
  errorText: { fontSize: '13px', color: '#DC2626', margin: 0 },

  loadingCard: { display: 'flex', justifyContent: 'center', padding: '60px 0' },
  spinner: { width: '22px', height: '22px', border: '2.5px solid #E5E7EB', borderTopColor: '#000835', borderRadius: '50%' },

  emptyState: { display: 'flex', flexDirection: 'column' as const, alignItems: 'center', textAlign: 'center' as const, padding: '64px 20px', background: '#fff', border: '1px solid #E5E7EB', borderRadius: '16px' },
  emptyIcon: { fontSize: '26px', marginBottom: '10px' },
  emptyTitle: { fontSize: '15px', fontWeight: 700, color: '#111827', margin: '0 0 4px' },
  emptyDesc: { fontSize: '13px', color: '#9CA3AF', margin: '0 0 18px', maxWidth: '320px', lineHeight: 1.6 },
  emptyCta: { fontSize: '13px', fontWeight: 600, color: '#000835', textDecoration: 'underline' },

  list: { display: 'flex', flexDirection: 'column' as const, gap: '10px' },
  card: {
    display: 'block', background: '#fff', border: '1px solid #E5E7EB', borderRadius: '14px',
    padding: '16px 18px', textDecoration: 'none', color: 'inherit',
  },
  cardTop: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' },
  routeBlock: { display: 'flex', alignItems: 'center', gap: '6px' },
  routeCode: { fontSize: '15px', fontWeight: 700, color: '#0A0A14', letterSpacing: '0.2px' },
  routeArrow: { fontSize: '13px', color: '#9CA3AF' },
  stopBadge: { fontSize: '10px', color: '#9CA3AF', fontWeight: 500, marginLeft: '4px' },
  statusBadge: { fontSize: '11px', fontWeight: 700, padding: '4px 10px', borderRadius: '7px' },

  cardBody: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap' as const, gap: '8px' },
  cardDetail: { display: 'flex', alignItems: 'center', gap: '10px', fontSize: '12.5px', color: '#6B7280', flexWrap: 'wrap' as const },
  dot: { display: 'flex', alignItems: 'center', gap: '10px' },
  cardFare: { fontSize: '13px', fontWeight: 700, color: '#111827' },
}