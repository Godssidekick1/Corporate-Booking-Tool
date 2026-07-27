'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'

interface Booking {
  id: string
  status: string
  pnr: string | null
  ticket_numbers: string[] | null
  total_cost: number
  itinerary: {
    airline?: { code: string; name: string }
    origin?: { code: string; name: string; city: string; dateTime: string }
    destination?: { code: string; name: string; city: string; dateTime: string }
  } | null
  traveler_snapshot: {
    Email: string
    PassengerDetails: { FirstName: string; LastName: string; Title: string }[]
  } | null
  fare_breakdown: { currency: string } | null
}

function formatTime(iso: string | undefined) {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })
  } catch {
    return '—'
  }
}

export default function TicketPage() {
  const params = useParams<{ bookingId: string }>()
  const bookingId = params.bookingId

  const [booking, setBooking] = useState<Booking | null>(null)
  const [loading, setLoading] = useState(true)
  const [ticketing, setTicketing] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    loadAndMaybeTicket()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookingId])

  async function loadAndMaybeTicket() {
    setLoading(true)
    setError('')
    try {
      const res = await fetch(`/api/book/${bookingId}`)
      const data = await res.json()
      if (!res.ok) {
        setError(data.error || 'Could not load this booking.')
        return
      }
      setBooking(data.booking)
      setLoading(false)

      // A booking that reached this page at status 'booked' hasn't been
      // ticketed yet — issue the ticket automatically rather than making
      // the user click a second button right after "Confirm booking".
      // If it's already 'ticketed' (e.g. a refresh), there's nothing to do.
      if (data.booking.status === 'booked') {
        await issueTicket()
      }
    } catch {
      setError('Something went wrong loading this booking.')
      setLoading(false)
    }
  }

  async function issueTicket() {
    setTicketing(true)
    setError('')
    try {
      const res = await fetch('/api/book/ticket', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bookingId }),
      })
      const data = await res.json()

      if (!data.ok) {
        setError(data.error || 'Could not issue the ticket. You can try again below.')
        return
      }

      setBooking(prev => prev ? {
        ...prev,
        status: 'ticketed',
        pnr: data.pnr ?? prev.pnr,
        ticket_numbers: data.ticketNumbers ?? prev.ticket_numbers,
      } : prev)
    } catch {
      setError('Something went wrong issuing the ticket. You can try again below.')
    } finally {
      setTicketing(false)
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

  if (!booking) {
    return (
      <div style={s.page}>
        <div style={s.root}>
          <div style={s.errorCard}>
            <p style={s.errorTitle}>⚠ {error || 'Booking not found.'}</p>
            <Link href="/book" style={s.errorLink}>← Start a new search</Link>
          </div>
        </div>
      </div>
    )
  }

  const traveler = booking.traveler_snapshot?.PassengerDetails?.[0]
  const isTicketed = booking.status === 'ticketed'

  return (
    <div style={s.page}>
      <div style={s.root}>
        {ticketing && (
          <div style={s.loadingCard}>
            <div style={s.spinner} />
            <p style={s.loadingText}>Issuing your ticket…</p>
          </div>
        )}

        {!ticketing && isTicketed && (
          <>
            <div style={s.successHero}>
              <div style={s.successIcon}>✓</div>
              <h1 style={s.successHeading}>You're booked!</h1>
              <p style={s.successSub}>Your ticket has been issued.</p>
            </div>

            <div style={s.card}>
              <div style={s.confirmRow}>
                <span style={s.confirmLabel}>PNR</span>
                <span style={s.confirmValue}>{booking.pnr || '—'}</span>
              </div>
              {booking.ticket_numbers && booking.ticket_numbers.length > 0 && (
                <div style={s.confirmRow}>
                  <span style={s.confirmLabel}>Ticket number</span>
                  <span style={s.confirmValue}>{booking.ticket_numbers[0]}</span>
                </div>
              )}
            </div>

            {booking.itinerary && (
              <div style={s.card}>
                <h2 style={s.cardTitle}>Flight</h2>
                <div style={s.routeRow}>
                  <div style={s.routePoint}>
                    <span style={s.routeTime}>{formatTime(booking.itinerary.origin?.dateTime)}</span>
                    <span style={s.routeCode}>{booking.itinerary.origin?.code}</span>
                  </div>
                  <span style={s.routeArrow}>→</span>
                  <div style={s.routePoint}>
                    <span style={s.routeTime}>{formatTime(booking.itinerary.destination?.dateTime)}</span>
                    <span style={s.routeCode}>{booking.itinerary.destination?.code}</span>
                  </div>
                </div>
                <p style={s.mutedLine}>{booking.itinerary.airline?.name ?? 'Airline'}</p>
              </div>
            )}

            {traveler && (
              <div style={s.card}>
                <h2 style={s.cardTitle}>Traveler</h2>
                <p style={s.travelerName}>{traveler.Title} {traveler.FirstName} {traveler.LastName}</p>
                <p style={s.mutedLine}>{booking.traveler_snapshot?.Email}</p>
              </div>
            )}

            <Link href="/book" style={s.doneLink}>Book another flight →</Link>
          </>
        )}

        {!ticketing && !isTicketed && (
          <div style={s.errorCard}>
            <p style={s.errorTitle}>⚠ {error || 'Ticketing did not complete.'}</p>
            <p style={s.errorNote}>
              Your booking is confirmed with the airline — only ticket issuance needs to be retried.
            </p>
            <button type="button" onClick={issueTicket} style={s.retryBtn}>Retry ticketing →</button>
          </div>
        )}
      </div>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  page: { background: '#F9FAFB', minHeight: '100vh' },
  root: { fontFamily: "'Inter', -apple-system, sans-serif", maxWidth: '560px', margin: '0 auto', padding: '32px 24px 64px' },

  loadingCard: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '14px', padding: '80px 0' },
  spinner: { width: '22px', height: '22px', border: '2.5px solid #E5E7EB', borderTopColor: '#000835', borderRadius: '50%' },
  loadingText: { fontSize: '13px', color: '#6B7280', margin: 0 },

  errorCard: { padding: '20px', background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: '14px' },
  errorTitle: { fontSize: '13px', color: '#DC2626', margin: '0 0 8px', lineHeight: 1.5 },
  errorNote: { fontSize: '12px', color: '#7F1D1D', margin: '0 0 14px', lineHeight: 1.5 },
  errorLink: { fontSize: '13px', color: '#DC2626', fontWeight: 600, textDecoration: 'underline' },
  retryBtn: { height: '38px', padding: '0 18px', background: '#DC2626', color: '#fff', fontSize: '13px', fontWeight: 600, border: 'none', borderRadius: '8px', cursor: 'pointer' },

  successHero: { textAlign: 'center' as const, padding: '20px 0 28px' },
  successIcon: { width: '52px', height: '52px', borderRadius: '50%', background: '#ECFDF5', color: '#065F46', fontSize: '24px', fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 14px' },
  successHeading: { fontSize: '22px', fontWeight: 700, color: '#0A0A14', margin: '0 0 4px' },
  successSub: { fontSize: '13px', color: '#6B7280', margin: 0 },

  card: { background: '#fff', border: '1px solid #E5E7EB', borderRadius: '14px', padding: '20px', marginBottom: '16px' },
  cardTitle: { fontSize: '14px', fontWeight: 600, color: '#111827', margin: '0 0 14px' },

  confirmRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0' },
  confirmLabel: { fontSize: '12px', color: '#6B7280' },
  confirmValue: { fontSize: '15px', fontWeight: 700, color: '#0A0A14', letterSpacing: '0.5px' },

  routeRow: { display: 'flex', alignItems: 'center', gap: '14px', marginBottom: '10px' },
  routePoint: { display: 'flex', flexDirection: 'column', gap: '2px' },
  routeTime: { fontSize: '16px', fontWeight: 700, color: '#111827' },
  routeCode: { fontSize: '11px', fontWeight: 600, color: '#6B7280' },
  routeArrow: { fontSize: '13px', color: '#9CA3AF' },
  mutedLine: { fontSize: '12px', color: '#9CA3AF', margin: 0 },

  travelerName: { fontSize: '14px', fontWeight: 600, color: '#111827', margin: '0 0 4px' },

  doneLink: {
    display: 'block', textAlign: 'center' as const, height: '48px', lineHeight: '48px', width: '100%',
    background: '#000835', color: '#fff', fontSize: '14px', fontWeight: 700, borderRadius: '10px',
    textDecoration: 'none', letterSpacing: '0.2px',
  },
}