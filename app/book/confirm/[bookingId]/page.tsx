'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'

interface Booking {
  id: string
  status: string
  provider: string
  provider_order_id: string
  total_cost: number
  itinerary: {
    airline?: { code: string; name: string }
    origin?: { code: string; name: string; city: string; dateTime: string }
    destination?: { code: string; name: string; city: string; dateTime: string }
    duration?: string
    stopCount?: number
  } | null
  traveler_snapshot: {
    Email: string
    PassengerDetails: { FirstName: string; LastName: string; Title: string }[]
  } | null
  fare_breakdown: { currency: string; isRefundable: boolean; fareType: string } | null
}

function formatTime(iso: string | undefined) {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })
  } catch {
    return '—'
  }
}

export default function ConfirmBookingPage() {
  const router = useRouter()
  const params = useParams<{ bookingId: string }>()
  const bookingId = params.bookingId

  const [booking, setBooking] = useState<Booking | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    loadBooking()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookingId])

  async function loadBooking() {
    setLoading(true)
    setLoadError('')
    try {
      const res = await fetch(`/api/book/${bookingId}`)
      const data = await res.json()
      if (!res.ok) {
        setLoadError(data.error || 'Could not load this booking.')
        return
      }
      setBooking(data.booking)

      // If this booking has already moved past passengers_added (e.g. the
      // user hit back after confirming, or refreshed after clicking Book),
      // send them forward to wherever they actually are instead of letting
      // them try to re-book an already-booked reservation.
      if (data.booking.status === 'booked') {
        router.replace(`/book/ticket/${bookingId}`)
      } else if (data.booking.status === 'ticketed') {
        router.replace(`/book/ticket/${bookingId}`)
      }
    } catch {
      setLoadError('Something went wrong loading this booking.')
    } finally {
      setLoading(false)
    }
  }

  async function handleConfirmBooking() {
    setConfirming(true)
    setError('')
    try {
      const res = await fetch('/api/book/book', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bookingId }),
      })
      const data = await res.json()

      if (!data.ok) {
        setError(data.error || 'Could not complete the booking. Please try again.')
        return
      }

      router.push(`/book/ticket/${bookingId}`)
    } catch {
      setError('Something went wrong completing the booking. Please try again.')
    } finally {
      setConfirming(false)
    }
  }

  if (loading) {
    return (
      <div style={s.page}>
        <div style={s.root}>
          <div style={s.loadingCard}>
            <div style={s.spinner} />
          </div>
        </div>
      </div>
    )
  }

  if (loadError || !booking) {
    return (
      <div style={s.page}>
        <div style={s.root}>
          <div style={s.errorCard}>
            <p style={s.errorTitle}>⚠ {loadError || 'Booking not found.'}</p>
            <Link href="/book" style={s.errorLink}>← Start a new search</Link>
          </div>
        </div>
      </div>
    )
  }

  const traveler = booking.traveler_snapshot?.PassengerDetails?.[0]

  return (
    <div style={s.page}>
      <div style={s.root}>
        <div style={s.header}>
          <h1 style={s.heading}>Review & confirm</h1>
          <p style={s.sub}>This is the final step before booking with the airline — check the details below carefully.</p>
        </div>

        {/* ── Flight ───────────────────────────────────────────────── */}
        {booking.itinerary && (
          <div style={s.card}>
            <h2 style={s.cardTitle}>Flight</h2>
            <div style={s.routeRow}>
              <div style={s.routePoint}>
                <span style={s.routeTime}>{formatTime(booking.itinerary.origin?.dateTime)}</span>
                <span style={s.routeCode}>{booking.itinerary.origin?.code}</span>
              </div>
              <div style={s.routeMiddle}>
                <span style={s.routeDuration}>{booking.itinerary.duration ?? ''}</span>
                <div style={s.routeLine} />
                <span style={s.routeStops}>
                  {(booking.itinerary.stopCount ?? 0) === 0 ? 'Non-stop' : `${booking.itinerary.stopCount} stop(s)`}
                </span>
              </div>
              <div style={{ ...s.routePoint, alignItems: 'flex-end' as const }}>
                <span style={s.routeTime}>{formatTime(booking.itinerary.destination?.dateTime)}</span>
                <span style={s.routeCode}>{booking.itinerary.destination?.code}</span>
              </div>
            </div>
            <p style={s.mutedLine}>{booking.itinerary.airline?.name ?? 'Airline'}</p>
          </div>
        )}

        {/* ── Traveler ─────────────────────────────────────────────── */}
        {traveler && (
          <div style={s.card}>
            <h2 style={s.cardTitle}>Traveler</h2>
            <p style={s.travelerName}>{traveler.Title} {traveler.FirstName} {traveler.LastName}</p>
            <p style={s.mutedLine}>{booking.traveler_snapshot?.Email}</p>
          </div>
        )}

        {/* ── Fare ─────────────────────────────────────────────────── */}
        <div style={s.card}>
          <h2 style={s.cardTitle}>Fare</h2>
          <div style={s.fareRow}>
            <span style={s.fareLabel}>Total</span>
            <span style={s.fareValue}>
              {booking.fare_breakdown?.currency ?? ''} {booking.total_cost?.toLocaleString('en-IN')}
            </span>
          </div>
          {booking.fare_breakdown && (
            <div style={s.metaTags}>
              <span style={{ ...s.tag, color: booking.fare_breakdown.isRefundable ? '#065F46' : '#9CA3AF', background: booking.fare_breakdown.isRefundable ? '#ECFDF5' : '#F3F4F6' }}>
                {booking.fare_breakdown.isRefundable ? 'Refundable' : 'Non-refundable'}
              </span>
              {booking.fare_breakdown.fareType && <span style={s.tag}>{booking.fare_breakdown.fareType}</span>}
            </div>
          )}
        </div>

        <div style={s.noticeCard}>
          <p style={s.noticeText}>
            Clicking below will confirm this booking directly with the airline. This step typically can't be undone —
            double-check the traveler's name and dates match their passport exactly.
          </p>
        </div>

        {error && (
          <div style={s.errorBanner}>
            <span style={s.bannerIcon}>⚠</span> {error}
          </div>
        )}

        <button
          type="button"
          onClick={handleConfirmBooking}
          disabled={confirming}
          style={{ ...s.confirmBtn, opacity: confirming ? 0.7 : 1 }}
        >
          {confirming ? 'Booking…' : 'Confirm booking →'}
        </button>
      </div>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  page: { background: '#F9FAFB', minHeight: '100vh' },
  root: { fontFamily: "'Inter', -apple-system, sans-serif", maxWidth: '640px', margin: '0 auto', padding: '32px 24px 64px' },

  header: { marginBottom: '20px' },
  heading: { fontSize: '22px', fontWeight: 700, color: '#0A0A14', margin: '0 0 6px', letterSpacing: '-0.4px' },
  sub: { fontSize: '13px', color: '#6B7280', margin: 0, lineHeight: 1.5 },

  loadingCard: { display: 'flex', justifyContent: 'center', padding: '80px 0' },
  spinner: { width: '22px', height: '22px', border: '2.5px solid #E5E7EB', borderTopColor: '#000835', borderRadius: '50%' },

  errorCard: { padding: '20px', background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: '14px' },
  errorTitle: { fontSize: '13px', color: '#DC2626', margin: '0 0 10px', lineHeight: 1.5 },
  errorLink: { fontSize: '13px', color: '#DC2626', fontWeight: 600, textDecoration: 'underline' },

  card: { background: '#fff', border: '1px solid #E5E7EB', borderRadius: '14px', padding: '20px', marginBottom: '16px' },
  cardTitle: { fontSize: '14px', fontWeight: 600, color: '#111827', margin: '0 0 14px' },

  routeRow: { display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '10px' },
  routePoint: { display: 'flex', flexDirection: 'column', gap: '2px', flex: '0 0 auto', minWidth: '58px' },
  routeTime: { fontSize: '16px', fontWeight: 700, color: '#111827' },
  routeCode: { fontSize: '11px', fontWeight: 600, color: '#6B7280' },
  routeMiddle: { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px' },
  routeDuration: { fontSize: '10px', color: '#9CA3AF', fontWeight: 500 },
  routeLine: { width: '100%', height: '1px', background: '#D1D5DB' },
  routeStops: { fontSize: '10px', color: '#9CA3AF' },
  mutedLine: { fontSize: '12px', color: '#9CA3AF', margin: 0 },

  travelerName: { fontSize: '14px', fontWeight: 600, color: '#111827', margin: '0 0 4px' },

  fareRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' },
  fareLabel: { fontSize: '13px', color: '#6B7280' },
  fareValue: { fontSize: '16px', fontWeight: 700, color: '#0A0A14' },
  metaTags: { display: 'flex', gap: '6px' },
  tag: { fontSize: '10px', color: '#6B7280', background: '#F3F4F6', padding: '3px 9px', borderRadius: '5px', fontWeight: 500 },

  noticeCard: { background: '#FFFBEB', border: '1px solid #FDE68A', borderRadius: '12px', padding: '14px 16px', marginBottom: '16px' },
  noticeText: { fontSize: '12px', color: '#92400E', margin: 0, lineHeight: 1.5 },

  errorBanner: { display: 'flex', alignItems: 'center', gap: '8px', background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: '10px', padding: '11px 14px', fontSize: '13px', color: '#DC2626', marginBottom: '16px' },
  bannerIcon: { fontSize: '14px' },

  confirmBtn: {
    height: '48px', width: '100%', background: '#000835', color: '#fff', fontSize: '14px', fontWeight: 700,
    border: 'none', borderRadius: '10px', cursor: 'pointer', letterSpacing: '0.2px',
  },
}