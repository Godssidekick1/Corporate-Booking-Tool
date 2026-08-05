'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'

interface Trip {
  id: string
  name: string
  status: string
  travel_date: string | null
  created_at: string
  updated_at: string
}

function formatDate(iso: string) {
  try {
    return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
  } catch {
    return ''
  }
}

const STATUS_LABEL: Record<string, string> = {
  open: 'Draft',
  active: 'Active',
  completed: 'Completed',
  cancelled: 'Cancelled',
}

export default function TripsListPage() {
  const router = useRouter()
  const [trips, setTrips] = useState<Trip[] | null>(null)
  const [error, setError] = useState('')
  const [creating, setCreating] = useState(false)
  const [showNewTrip, setShowNewTrip] = useState(false)
  const [tripName, setTripName] = useState('')
  const [createError, setCreateError] = useState('')

  useEffect(() => {
    loadTrips()
  }, [])

  async function loadTrips() {
    setError('')
    try {
      const res = await fetch('/api/trips')
      const data = await res.json()
      if (!res.ok) {
        setError(data.error || 'Could not load your trips.')
        return
      }
      setTrips(data.trips)
    } catch {
      setError('Something went wrong loading your trips.')
    }
  }

  async function handleCreateTrip(e: React.FormEvent) {
    e.preventDefault()
    setCreateError('')
    if (!tripName.trim()) {
      setCreateError('Give your trip a name to continue.')
      return
    }
    setCreating(true)
    try {
      const res = await fetch('/api/trips', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: tripName.trim() }),
      })
      const data = await res.json()
      if (!res.ok) {
        setCreateError(data.error || 'Could not create trip.')
        return
      }
      router.push(`/trips/${data.trip.id}`)
    } catch {
      setCreateError('Something went wrong creating this trip.')
    } finally {
      setCreating(false)
    }
  }

  return (
    <div style={s.page}>
      <div style={s.root}>
        <div style={s.header}>
          <div>
            <h1 style={s.heading}>Your trips</h1>
            <p style={s.sub}>Pick up where you left off, or start something new.</p>
          </div>
          <button type="button" onClick={() => setShowNewTrip(true)} style={s.newTripBtn}>
            + New trip
          </button>
        </div>

        {showNewTrip && (
          <div style={s.newTripCard}>
            <form onSubmit={handleCreateTrip} style={s.newTripForm}>
              <div style={s.field}>
                <label style={s.label}>Trip name</label>
                <input
                  type="text" autoFocus value={tripName}
                  onChange={e => setTripName(e.target.value)}
                  placeholder="e.g. Mumbai client visit"
                  style={s.input}
                />
              </div>
              {createError && <p style={s.fieldError}>{createError}</p>}
              <div style={s.newTripActions}>
                <button type="button" onClick={() => { setShowNewTrip(false); setTripName(''); setCreateError('') }} style={s.cancelBtn}>
                  Cancel
                </button>
                <button type="submit" disabled={creating} style={{ ...s.createBtn, opacity: creating ? 0.7 : 1 }}>
                  {creating ? 'Creating…' : 'Create trip →'}
                </button>
              </div>
            </form>
          </div>
        )}

        {error && (
          <div style={s.errorCard}>
            <p style={s.errorTitle}>⚠ {error}</p>
          </div>
        )}

        {trips === null && !error && (
          <div style={s.loadingCard}>
            <div style={s.spinner} />
          </div>
        )}

        {trips !== null && trips.length === 0 && (
          <div style={s.emptyCard}>
            <p style={s.emptyTitle}>No trips yet</p>
            <p style={s.emptySub}>Create your first trip to start booking flights, hotels, and tracking expenses in one place.</p>
          </div>
        )}

        {trips !== null && trips.length > 0 && (
          <div style={s.tripsList}>
            {trips.map(trip => (
              <button
                key={trip.id}
                type="button"
                onClick={() => router.push(`/trips/${trip.id}`)}
                style={s.tripCard}
              >
                <div style={s.tripCardMain}>
                  <span style={s.tripName}>{trip.name}</span>
                  <span style={{ ...s.statusTag, ...(trip.status === 'open' ? s.statusOpen : s.statusOther) }}>
                    {STATUS_LABEL[trip.status] ?? trip.status}
                  </span>
                </div>
                <span style={s.tripMeta}>
                  {trip.travel_date ? formatDate(trip.travel_date) : `Created ${formatDate(trip.created_at)}`}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  page: { background: '#F9FAFB', minHeight: '100vh' },
  root: { fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif", maxWidth: '720px', margin: '0 auto', padding: '32px 24px 64px' },

  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '24px' },
  heading: { fontSize: '24px', fontWeight: 700, color: '#0A0A14', margin: '0 0 6px', letterSpacing: '-0.4px' },
  sub: { fontSize: '14px', color: '#6B7280', margin: 0 },
  newTripBtn: {
    height: '38px', padding: '0 16px', background: '#000835', color: '#fff', fontSize: '13px', fontWeight: 600,
    border: 'none', borderRadius: '9px', cursor: 'pointer', flexShrink: 0,
  },

  newTripCard: { background: '#fff', border: '1px solid #E5E7EB', borderRadius: '14px', padding: '20px', marginBottom: '20px' },
  newTripForm: { display: 'flex', flexDirection: 'column', gap: '12px' },
  field: { display: 'flex', flexDirection: 'column', gap: '6px' },
  label: { fontSize: '12px', fontWeight: 500, color: '#374151' },
  input: { height: '40px', padding: '0 12px', fontSize: '14px', color: '#111827', background: '#F9FAFB', border: '1px solid #E5E7EB', borderRadius: '8px', outline: 'none' },
  fieldError: { fontSize: '12px', color: '#DC2626', margin: 0 },
  newTripActions: { display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '4px' },
  cancelBtn: { height: '36px', padding: '0 14px', background: '#fff', color: '#374151', fontSize: '13px', fontWeight: 500, border: '1px solid #D1D5DB', borderRadius: '8px', cursor: 'pointer' },
  createBtn: { height: '36px', padding: '0 16px', background: '#000835', color: '#fff', fontSize: '13px', fontWeight: 600, border: 'none', borderRadius: '8px', cursor: 'pointer' },

  errorCard: { padding: '16px', background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: '12px', marginBottom: '16px' },
  errorTitle: { fontSize: '13px', color: '#DC2626', margin: 0 },

  loadingCard: { display: 'flex', justifyContent: 'center', padding: '60px 0' },
  spinner: { width: '22px', height: '22px', border: '2.5px solid #E5E7EB', borderTopColor: '#000835', borderRadius: '50%' },

  emptyCard: { textAlign: 'center' as const, padding: '48px 24px', background: '#fff', border: '1px dashed #D1D5DB', borderRadius: '14px' },
  emptyTitle: { fontSize: '14px', fontWeight: 600, color: '#111827', margin: '0 0 6px' },
  emptySub: { fontSize: '13px', color: '#9CA3AF', margin: 0, maxWidth: '360px', marginLeft: 'auto', marginRight: 'auto', lineHeight: 1.5 },

  tripsList: { display: 'flex', flexDirection: 'column', gap: '10px' },
  tripCard: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center', textAlign: 'left' as const,
    background: '#fff', border: '1px solid #E5E7EB', borderRadius: '12px', padding: '16px 18px',
    cursor: 'pointer', font: 'inherit', width: '100%',
  },
  tripCardMain: { display: 'flex', alignItems: 'center', gap: '10px' },
  tripName: { fontSize: '14px', fontWeight: 600, color: '#111827' },
  tripMeta: { fontSize: '12px', color: '#9CA3AF' },
  statusTag: { fontSize: '10px', fontWeight: 700, padding: '2px 8px', borderRadius: '5px', letterSpacing: '0.3px', textTransform: 'uppercase' as const },
  statusOpen: { color: '#92400E', background: '#FEF3C7' },
  statusOther: { color: '#065F46', background: '#ECFDF5' },
}