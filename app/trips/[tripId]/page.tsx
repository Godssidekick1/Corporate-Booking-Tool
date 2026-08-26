'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'

interface Trip {
  id: string
  name: string
  status: string
  travel_date: string | null
  created_at: string
}

interface Booking {
  id: string
  booking_type: string
  status: string
  total_cost: number
  provider_order_id: string | null
  pnr: string | null
  itinerary: {
    origin?: { code: string; city: string }
    destination?: { code: string; city: string }
  } | null
  created_at: string
}

interface Expense {
  id: string
  expense_type: string
  amount: number
  currency: string
  description: string | null
  expense_date: string | null
}

export default function TripWorkspacePage() {
  const params = useParams<{ tripId: string }>()
  const router = useRouter()
  const tripId = params.tripId

  const [trip, setTrip] = useState<Trip | null>(null)
  const [bookings, setBookings] = useState<Booking[]>([])
  const [expenses, setExpenses] = useState<Expense[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [completing, setCompleting] = useState(false)
  const [completeError, setCompleteError] = useState('')

  useEffect(() => {
    loadTrip()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tripId])

  async function loadTrip() {
    setLoading(true)
    setError('')
    try {
      const res = await fetch(`/api/trips/${tripId}`)
      const data = await res.json()
      if (!res.ok) {
        setError(data.error || 'Could not load this trip.')
        return
      }
      setTrip(data.trip)
      setBookings(data.bookings)
      setExpenses(data.expenses)
    } catch {
      setError('Something went wrong loading this trip.')
    } finally {
      setLoading(false)
    }
  }

  const flightBookings = bookings.filter(b => b.booking_type === 'flight')
  const hotelBookings = bookings.filter(b => b.booking_type === 'hotel')

  async function handleMarkComplete() {
    if (!trip) return
    setCompleteError('')
    setCompleting(true)
    try {
      const res = await fetch(`/api/trips/${trip.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'completed' }),
      })
      const data = await res.json()
      if (!res.ok) {
        setCompleteError(data.error || 'Could not mark this trip complete.')
        return
      }
      setTrip(prev => prev ? { ...prev, status: 'completed' } : prev)
    } catch {
      setCompleteError('Something went wrong marking this trip complete.')
    } finally {
      setCompleting(false)
    }
  }

  if (loading) {
    return (
      <div style={s.page}>
        <div style={s.root}>
          <div style={s.loadingCard}><div style={s.spinner} /></div>
        </div>
      </div>
    )
  }

  if (error || !trip) {
    return (
      <div style={s.page}>
        <div style={s.root}>
          <div style={s.errorCard}>
            <p style={s.errorTitle}>⚠ {error || 'Trip not found.'}</p>
            <Link href="/book" style={s.errorLink}>← Back to your trips</Link>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div style={s.page}>
      <div style={s.root}>
        <Link href="/book" style={s.backLink}>← Your trips</Link>

        <div style={s.header}>
          <div style={s.headerTop}>
            <div>
              <div style={s.titleRow}>
                <h1 style={s.heading}>{trip.name}</h1>
                <span style={{ ...s.statusTag, ...(trip.status === 'completed' ? s.statusCompleted : s.statusOpen) }}>
                  {trip.status === 'completed' ? 'Completed' : trip.status === 'open' ? 'Planning' : trip.status}
                </span>
              </div>
              <p style={s.sub}>Add flights, hotels, and expenses for this trip.</p>
            </div>
            {trip.status !== 'completed' && trip.status !== 'cancelled' && (
              <button type="button" onClick={handleMarkComplete} disabled={completing} style={{ ...s.completeBtn, opacity: completing ? 0.6 : 1 }}>
                {completing ? 'Marking complete…' : '✓ Mark trip complete'}
              </button>
            )}
          </div>
          {completeError && <p style={s.completeErrorText}>⚠ {completeError}</p>}
        </div>

        {/* ── Flights ──────────────────────────────────────────────── */}
        <div style={s.section}>
          <div style={s.sectionHeader}>
            <h2 style={s.sectionTitle}>✈ Flights</h2>
            <button
              type="button"
              onClick={() => router.push(`/book/flights?tripId=${tripId}`)}
              style={s.addBtn}
            >
              + Add flight
            </button>
          </div>

          {flightBookings.length === 0 ? (
            <p style={s.emptyText}>No flights added yet.</p>
          ) : (
            <div style={s.itemList}>
              {flightBookings.map(b => (
                <div key={b.id} style={s.item}>
                  <div>
                    <span style={s.itemMain}>
                      {b.itinerary?.origin?.code ?? '—'} → {b.itinerary?.destination?.code ?? '—'}
                    </span>
                    <span style={s.itemSub}>{b.status.replace(/_/g, ' ')}{b.pnr ? ` · PNR ${b.pnr}` : ''}</span>
                  </div>
                  <span style={s.itemValue}>₹{b.total_cost?.toLocaleString('en-IN')}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── Hotels ───────────────────────────────────────────────── */}
        <div style={s.section}>
          <div style={s.sectionHeader}>
            <h2 style={s.sectionTitle}>🏨 Hotels</h2>
            <span style={s.comingSoonTag}>Coming soon</span>
          </div>
          {hotelBookings.length === 0 ? (
            <p style={s.emptyText}>Hotel booking isn't available yet.</p>
          ) : (
            <div style={s.itemList}>
              {hotelBookings.map(b => (
                <div key={b.id} style={s.item}>
                  <span style={s.itemMain}>Hotel booking</span>
                  <span style={s.itemValue}>₹{b.total_cost?.toLocaleString('en-IN')}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── Misc expenses ────────────────────────────────────────── */}
        <div style={s.section}>
          <div style={s.sectionHeader}>
            <h2 style={s.sectionTitle}>🧾 Miscellaneous expenses</h2>
            <span style={s.comingSoonTag}>Coming soon</span>
          </div>
          {expenses.length === 0 ? (
            <p style={s.emptyText}>No expenses logged yet.</p>
          ) : (
            <div style={s.itemList}>
              {expenses.map(e => (
                <div key={e.id} style={s.item}>
                  <div>
                    <span style={s.itemMain}>{e.description ?? e.expense_type}</span>
                    <span style={s.itemSub}>{e.expense_date ?? ''}</span>
                  </div>
                  <span style={s.itemValue}>{e.currency} {e.amount?.toLocaleString('en-IN')}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  page: { background: '#F9FAFB', minHeight: '100vh' },
  root: { fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif", maxWidth: '720px', margin: '0 auto', padding: '32px 24px 64px' },

  backLink: { fontSize: '13px', color: '#6B7280', textDecoration: 'none', display: 'inline-block', marginBottom: '16px' },

  header: { marginBottom: '24px' },
  headerTop: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px', flexWrap: 'wrap' as const },
  titleRow: { display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '6px' },
  heading: { fontSize: '24px', fontWeight: 700, color: '#0A0A14', margin: 0, letterSpacing: '-0.4px' },
  sub: { fontSize: '14px', color: '#6B7280', margin: 0 },
  statusTag: { fontSize: '10px', fontWeight: 700, padding: '3px 9px', borderRadius: '6px', letterSpacing: '0.3px', textTransform: 'uppercase' as const },
  statusOpen: { color: '#92400E', background: '#FEF3C7' },
  statusCompleted: { color: '#166534', background: '#DCFCE7' },
  completeBtn: {
    flexShrink: 0, height: '36px', padding: '0 14px', background: '#fff', color: '#166534', fontSize: '12.5px', fontWeight: 600,
    border: '1px solid #BBF7D0', borderRadius: '8px', cursor: 'pointer', whiteSpace: 'nowrap' as const,
  },
  completeErrorText: { fontSize: '12.5px', color: '#DC2626', margin: '10px 0 0' },

  loadingCard: { display: 'flex', justifyContent: 'center', padding: '80px 0' },
  spinner: { width: '22px', height: '22px', border: '2.5px solid #E5E7EB', borderTopColor: '#000835', borderRadius: '50%', animation: 'spin 0.7s linear infinite' },

  errorCard: { padding: '20px', background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: '14px' },
  errorTitle: { fontSize: '13px', color: '#DC2626', margin: '0 0 10px', lineHeight: 1.5 },
  errorLink: { fontSize: '13px', color: '#DC2626', fontWeight: 600, textDecoration: 'underline' },

  section: { background: '#fff', border: '1px solid #E5E7EB', borderRadius: '14px', padding: '20px', marginBottom: '16px' },
  sectionHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' },
  sectionTitle: { fontSize: '14px', fontWeight: 600, color: '#111827', margin: 0 },
  addBtn: { height: '32px', padding: '0 14px', background: '#000835', color: '#fff', fontSize: '12px', fontWeight: 600, border: 'none', borderRadius: '7px', cursor: 'pointer' },
  comingSoonTag: { fontSize: '9px', fontWeight: 700, color: '#92400E', background: '#FEF3C7', padding: '3px 8px', borderRadius: '5px', letterSpacing: '0.3px', textTransform: 'uppercase' as const },

  emptyText: { fontSize: '12.5px', color: '#9CA3AF', margin: 0 },

  itemList: { display: 'flex', flexDirection: 'column', gap: '8px' },
  item: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 0', borderBottom: '1px solid #F3F4F6' },
  itemMain: { fontSize: '13px', fontWeight: 600, color: '#111827', display: 'block' },
  itemSub: { fontSize: '11px', color: '#9CA3AF', textTransform: 'capitalize' as const },
  itemValue: { fontSize: '13px', fontWeight: 600, color: '#111827' },
}