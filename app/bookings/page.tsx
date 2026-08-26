'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { formatTime, formatDayLabel } from '@/app/lib/book/types'

// ── /bookings — "My trips" ────────────────────────────────────────────────────
// Shows the employee's trips, each with its flights nested underneath —
// replaces the earlier flat list of individual flight bookings. /api/bookings
// does the trip/booking grouping server-side; this page just renders it.
//
// Starting a NEW booking still goes through /book (the trip picker) — kept
// deliberately separate from this page, which is a review/history surface.
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

interface TripGroup {
  trip: {
    id: string
    name: string
    status: string
    travel_date: string | null
    created_at: string
  }
  bookings: BookingSummary[]
}

const STATUS_META: Record<string, { label: string; color: string; bg: string }> = {
  ticketed:         { label: 'Ticketed',        color: '#166534', bg: '#DCFCE7' },
  held:             { label: 'Booked',          color: '#1E40AF', bg: '#DBEAFE' },
  passenger_added:  { label: 'In progress',     color: '#92400E', bg: '#FEF3C7' },
  priced:           { label: 'In progress',     color: '#92400E', bg: '#FEF3C7' },
  not_evaluated:    { label: 'Pending policy',  color: '#92400E', bg: '#FEF3C7' },
  pending_approval: { label: 'Pending approval', color: '#92400E', bg: '#FEF3C7' },
  approved:         { label: 'Approved',        color: '#1E40AF', bg: '#DBEAFE' },
  rejected:         { label: 'Rejected',        color: '#991B1B', bg: '#FEE2E2' },
  failed:           { label: 'Failed',          color: '#991B1B', bg: '#FEE2E2' },
  cancelled:        { label: 'Cancelled',       color: '#6B7280', bg: '#F3F4F6' },
}

const TRIP_STATUS_META: Record<string, { label: string; color: string; bg: string }> = {
  open:      { label: 'Planning',  color: '#92400E', bg: '#FEF3C7' },
  active:    { label: 'Active',    color: '#1E40AF', bg: '#DBEAFE' },
  completed: { label: 'Completed', color: '#166534', bg: '#DCFCE7' },
  cancelled: { label: 'Cancelled', color: '#6B7280', bg: '#F3F4F6' },
}

function statusMeta(status: string) {
  return STATUS_META[status] ?? { label: status, color: '#6B7280', bg: '#F3F4F6' }
}

function tripStatusMeta(status: string) {
  return TRIP_STATUS_META[status] ?? { label: status, color: '#6B7280', bg: '#F3F4F6' }
}

// Where a booking should route to when clicked — matches the step it's
// currently sitting at, so "My trips" can act as a resume point too, not
// just a read-only history.
function resumeHref(booking: BookingSummary): string {
  if (booking.status === 'ticketed') return `/book/ticket/${booking.id}`
  if (booking.status === 'held') return `/book/ticket/${booking.id}`
  if (booking.status === 'pending_approval' || booking.status === 'approved') return `/book/confirm/${booking.id}`
  return `/book/ticket/${booking.id}` // failed/cancelled/other: land on ticket page, which shows the right state/error
}

function FlightCard({ booking }: { booking: BookingSummary }) {
  const meta = statusMeta(booking.status)
  const it = booking.itinerary
  const travelers = booking.traveler_snapshot?.PassengerDetails ?? []
  const currency = booking.fare_breakdown?.currency ?? ''

  return (
    <Link href={resumeHref(booking)} style={s.card}>
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
}

function TripSection({ group, onMarkComplete, completingId }: {
  group: TripGroup
  onMarkComplete: (tripId: string) => void
  completingId: string | null
}) {
  const meta = tripStatusMeta(group.trip.status)
  const canComplete = group.trip.status === 'open' || group.trip.status === 'active'

  return (
    <div style={s.tripSection}>
      <div style={s.tripHeader}>
        <div style={s.tripHeaderLeft}>
          <Link href={`/trips/${group.trip.id}`} style={s.tripNameLink}>{group.trip.name}</Link>
          <span style={{ ...s.statusBadge, color: meta.color, background: meta.bg }}>{meta.label}</span>
        </div>
        {canComplete && (
          <button
            type="button"
            disabled={completingId === group.trip.id}
            onClick={() => onMarkComplete(group.trip.id)}
            style={{ ...s.completeBtn, opacity: completingId === group.trip.id ? 0.6 : 1 }}
          >
            {completingId === group.trip.id ? 'Marking complete…' : '✓ Mark trip complete'}
          </button>
        )}
      </div>

      {group.bookings.length === 0 ? (
        <p style={s.emptyTripText}>No flights added to this trip yet.</p>
      ) : (
        <div style={s.list}>
          {group.bookings.map(booking => <FlightCard key={booking.id} booking={booking} />)}
        </div>
      )}
    </div>
  )
}

export default function BookingsPage() {
  const [trips, setTrips] = useState<TripGroup[] | null>(null)
  const [ungrouped, setUngrouped] = useState<BookingSummary[]>([])
  const [error, setError] = useState('')
  const [completingId, setCompletingId] = useState<string | null>(null)
  const [completeError, setCompleteError] = useState('')

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
      setTrips(data.trips)
      setUngrouped(data.ungroupedBookings ?? [])
    } catch {
      setError('Something went wrong loading your trips.')
    }
  }

  async function handleMarkComplete(tripId: string) {
    setCompleteError('')
    setCompletingId(tripId)
    try {
      const res = await fetch(`/api/trips/${tripId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'completed' }),
      })
      const data = await res.json()
      if (!res.ok) {
        setCompleteError(data.error || 'Could not mark this trip complete.')
        return
      }
      // Reflect the new status locally rather than a full reload.
      setTrips(prev => prev?.map(g => g.trip.id === tripId ? { ...g, trip: { ...g.trip, status: 'completed' } } : g) ?? null)
    } catch {
      setCompleteError('Something went wrong marking this trip complete.')
    } finally {
      setCompletingId(null)
    }
  }

  const isEmpty = trips !== null && trips.length === 0 && ungrouped.length === 0

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

        {completeError && (
          <div style={s.errorCard}>
            <p style={s.errorText}>⚠ {completeError}</p>
          </div>
        )}

        {!trips && !error && (
          <div style={s.loadingCard}>
            <div style={s.spinner} />
          </div>
        )}

        {isEmpty && (
          <div style={s.emptyState}>
            <div style={s.emptyIcon}>✈</div>
            <p style={s.emptyTitle}>No trips yet</p>
            <p style={s.emptyDesc}>Create a trip to start booking flights, hotels, and tracking expenses in one place.</p>
            <Link href="/book" style={s.emptyCta}>Start your first trip →</Link>
          </div>
        )}

        {trips && trips.length > 0 && (
          <div style={s.tripsList}>
            {trips.map(group => (
              <TripSection
                key={group.trip.id}
                group={group}
                onMarkComplete={handleMarkComplete}
                completingId={completingId}
              />
            ))}
          </div>
        )}

        {ungrouped.length > 0 && (
          <div style={s.tripSection}>
            <div style={s.tripHeader}>
              <div style={s.tripHeaderLeft}>
                <span style={s.otherLabel}>Other flights</span>
              </div>
            </div>
            <p style={s.emptyTripText}>Not linked to a specific trip.</p>
            <div style={s.list}>
              {ungrouped.map(booking => <FlightCard key={booking.id} booking={booking} />)}
            </div>
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
  spinner: { width: '22px', height: '22px', border: '2.5px solid #E5E7EB', borderTopColor: '#000835', borderRadius: '50%', animation: 'spin 0.7s linear infinite' },

  emptyState: { display: 'flex', flexDirection: 'column' as const, alignItems: 'center', textAlign: 'center' as const, padding: '64px 20px', background: '#fff', border: '1px solid #E5E7EB', borderRadius: '16px' },
  emptyIcon: { fontSize: '26px', marginBottom: '10px' },
  emptyTitle: { fontSize: '15px', fontWeight: 700, color: '#111827', margin: '0 0 4px' },
  emptyDesc: { fontSize: '13px', color: '#9CA3AF', margin: '0 0 18px', maxWidth: '320px', lineHeight: 1.6 },
  emptyCta: { fontSize: '13px', fontWeight: 600, color: '#000835', textDecoration: 'underline' },

  tripsList: { display: 'flex', flexDirection: 'column' as const, gap: '24px' },
  tripSection: { display: 'flex', flexDirection: 'column' as const, gap: '10px', marginTop: '24px' },
  tripHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap' as const, gap: '10px' },
  tripHeaderLeft: { display: 'flex', alignItems: 'center', gap: '10px' },
  tripNameLink: { fontSize: '16px', fontWeight: 700, color: '#0A0A14', textDecoration: 'none' },
  otherLabel: { fontSize: '16px', fontWeight: 700, color: '#6B7280' },
  completeBtn: {
    height: '32px', padding: '0 12px', background: '#fff', color: '#166534', fontSize: '12px', fontWeight: 600,
    border: '1px solid #BBF7D0', borderRadius: '8px', cursor: 'pointer', whiteSpace: 'nowrap' as const,
  },
  emptyTripText: { fontSize: '12.5px', color: '#9CA3AF', margin: '0 0 4px' },

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