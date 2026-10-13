'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useCanSelfBook } from '@/app/hooks/useCanSelfBook'
import Pagination from '@/app/components/Pagination'
import SearchableSelect from '@/app/components/SearchableSelect'
import Link from 'next/link'
import { useLookup } from '@/app/hooks/useLookup'

interface Trip {
  id: string
  name: string
  status: string
  travel_date: string | null
  created_at: string
  updated_at: string
  // Set up for them by someone else (the desk, or an admin colleague).
  arranged_by_name?: string | null
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
  const canSelfBook = useCanSelfBook()
  const [trips, setTrips] = useState<Trip[] | null>(null)
  // Ten at a time, most recently touched first.
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [pageSize, setPageSize] = useState(10)
  const [error, setError] = useState('')
  const [creating, setCreating] = useState(false)
  const [showNewTrip, setShowNewTrip] = useState(false)
  const [tripName, setTripName] = useState('')
  const [createError, setCreateError] = useState('')
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState('')
  // A corporate admin may make the trip a colleague's: it is then THEIRS (in
  // their trips, and in the admin's under Arranged for others), never the
  // admin's own. Asked every time, so whose name a trip is under is a choice.
  const [isAdmin, setIsAdmin] = useState(false)
  const [forWhom, setForWhom] = useState<'me' | 'colleague'>('me')
  const [colleagueId, setColleagueId] = useState('')
  const colleagueLookup = useLookup('/api/book/travellers', colleagueId, {
    enabled: isAdmin && forWhom === 'colleague',
    toOption: row => ({
      id: String(row.id),
      label: String(row.full_name),
      sublabel: [row.band_code, row.department, row.email].filter(Boolean).join(' · ') || undefined,
    }),
  })
  useEffect(() => {
    fetch('/api/me').then(r => r.json()).then(d => setIsAdmin(d.employee?.role === 'admin')).catch(() => {})
  }, [])

  useEffect(() => {
    loadTrips(page)
  }, [page])

  async function loadTrips(p: number) {
    setError('')
    try {
      const res = await fetch(`/api/trips?page=${p}`)
      const data = await res.json()
      if (!res.ok) {
        setError(data.error || 'Could not load your trips.')
        return
      }
      setTrips(data.trips)
      setTotal(data.total ?? 0)
      setPageSize(data.pageSize ?? 10)
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
    if (forWhom === 'colleague' && !colleagueId) {
      setCreateError('Choose whose trip this is.')
      return
    }
    setCreating(true)
    let navigating = false
    try {
      const res = await fetch('/api/trips', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: tripName.trim(), travellerId: forWhom === 'colleague' ? colleagueId : undefined }),
      })
      const data = await res.json()
      if (!res.ok) {
        setCreateError(data.error || 'Could not create trip.')
        return
      }
      // Stays busy until the trip page opens: the trip already exists, and a
      // button that flips back to "Create trip" invites a second one.
      navigating = true
      router.push(`/trips/${data.trip.id}`)
    } catch {
      setCreateError('Something went wrong creating this trip.')
    } finally {
      if (!navigating) setCreating(false)
    }
  }

  async function handleDeleteTrip(tripId: string) {
    setDeleteError('')
    setDeletingId(tripId)
    // Optimistic removal — trips is guaranteed non-null here since the
    // delete button only renders once trips has loaded.
    const prevTrips = trips
    setTrips(prevTrips!.filter(t => t.id !== tripId))
    setConfirmDeleteId(null)
    try {
      const res = await fetch(`/api/trips/${tripId}`, { method: 'DELETE' })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        setDeleteError(data.error || 'Could not delete this trip.')
        setTrips(prevTrips) // roll back
      }
    } catch {
      setDeleteError('Something went wrong deleting this trip.')
      setTrips(prevTrips) // roll back
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <div style={s.page}>
      <div style={s.root}>
        <div style={s.header}>
          <div>
            <h1 style={s.heading}>Your own trips</h1>
            <p style={s.sub}>
              {canSelfBook === false ? 'Trips your travel desk has booked for you.' : 'Pick up where you left off, or start something new.'}
            </p>
          </div>
          {canSelfBook && (
            <button type="button" onClick={() => setShowNewTrip(true)} style={s.newTripBtn}>
              + New trip
            </button>
          )}
        </div>

        {canSelfBook === false && (
          <div style={s.deskCard}>
            <p style={s.deskText}>Your travel desk books travel for your company. Contact them to arrange a trip; it will appear here once booked.</p>
          </div>
        )}

        {isAdmin && (
          <p style={s.arrangedLink}>
            Trips you set up for colleagues are theirs, and kept apart: <Link href="/bookings" style={s.arrangedA}>My trips → Arranged for others</Link>
          </p>
        )}

        {showNewTrip && canSelfBook && (
          <div style={s.newTripCard}>
            <form onSubmit={handleCreateTrip} style={s.newTripForm}>
              {isAdmin && (
                <div style={s.field}>
                  <label style={s.label}>Whose trip?</label>
                  <div style={s.whoToggle}>
                    {(['me', 'colleague'] as const).map(w => (
                      <button key={w} type="button" onClick={() => { setForWhom(w); setCreateError('') }}
                        style={{ ...s.whoBtn, ...(forWhom === w ? s.whoBtnOn : {}) }}>
                        {w === 'me' ? 'Mine' : 'For a colleague'}
                      </button>
                    ))}
                  </div>
                  {forWhom === 'colleague' && (
                    <SearchableSelect
                      value={colleagueId}
                      onChange={setColleagueId}
                      options={colleagueLookup.options}
                      onSearch={colleagueLookup.onSearch}
                      loading={colleagueLookup.loading}
                      selectedLabel={colleagueLookup.selectedLabel}
                      placeholder="Search colleagues by name, email or department…"
                      emptyMessage="No colleague matches"
                    />
                  )}
                  {forWhom === 'colleague' && colleagueId && (
                    <span style={s.whoNote}>
                      It will be <strong>{colleagueLookup.selectedLabel || 'their'}</strong>&apos;s trip, in their My trips, and in yours under Arranged for others.
                    </span>
                  )}
                </div>
              )}
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
                  {creating ? 'Opening the trip…' : forWhom === 'colleague' && isAdmin ? 'Create their trip →' : 'Create trip →'}
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
            <p style={s.emptySub}>
              {canSelfBook === false
                ? 'Nothing booked yet.'
                : 'Create your first trip to start booking flights, hotels, and tracking expenses in one place.'}
            </p>
          </div>
        )}

        {deleteError && (
          <div style={s.errorCard}>
            <p style={s.errorTitle}>⚠ {deleteError}</p>
          </div>
        )}

        {trips !== null && trips.length > 0 && (
          <div style={s.tripsList}>
            {trips.map(trip => (
              <div key={trip.id} style={s.tripCard}>
                {confirmDeleteId === trip.id ? (
                  <div style={s.confirmRow}>
                    <span style={s.confirmText}>Delete “{trip.name}”?</span>
                    <div style={s.confirmActions}>
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteId(null)}
                        style={s.confirmCancelBtn}
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        disabled={deletingId === trip.id}
                        onClick={() => handleDeleteTrip(trip.id)}
                        style={{ ...s.confirmDeleteBtn, opacity: deletingId === trip.id ? 0.7 : 1 }}
                      >
                        {deletingId === trip.id ? 'Deleting…' : 'Delete'}
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => router.push(`/trips/${trip.id}`)}
                      style={s.tripCardMainBtn}
                    >
                      <div style={s.tripCardMain}>
                        <span style={s.tripName}>{trip.name}</span>
                        <span style={{ ...s.statusTag, ...(trip.status === 'open' ? s.statusOpen : s.statusOther) }}>
                          {STATUS_LABEL[trip.status] ?? trip.status}
                        </span>
                      </div>
                      <span style={s.tripMeta}>
                        {trip.travel_date ? formatDate(trip.travel_date) : `Created ${formatDate(trip.created_at)}`}
                        {trip.arranged_by_name ? ` · Set up for you by ${trip.arranged_by_name}` : ''}
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmDeleteId(trip.id)}
                      style={s.deleteIconBtn}
                      aria-label={`Delete ${trip.name}`}
                      title="Delete trip"
                    >
                      🗑
                    </button>
                  </>
                )}
              </div>
            ))}
          </div>
        )}

        <Pagination page={page} pageSize={pageSize} total={total} onPageChange={setPage} noun="trips" />
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
  whoToggle: { display: 'inline-flex', border: '1px solid #E5E7EB', borderRadius: '8px', overflow: 'hidden', alignSelf: 'flex-start' },
  whoBtn: { padding: '7px 14px', fontSize: '13px', background: '#fff', color: '#374151', border: 'none', cursor: 'pointer' },
  whoBtnOn: { background: '#000835', color: '#fff', fontWeight: 600 },
  whoNote: { fontSize: '12px', color: '#4338CA', lineHeight: 1.5 },
  arrangedLink: { fontSize: '12.5px', color: '#6B7280', margin: '-8px 0 16px' },
  arrangedA: { color: '#3730A3', fontWeight: 600 },
  label: { fontSize: '12px', fontWeight: 500, color: '#374151' },
  input: { height: '40px', padding: '0 12px', fontSize: '14px', color: '#111827', background: '#F9FAFB', border: '1px solid #E5E7EB', borderRadius: '8px', outline: 'none' },
  fieldError: { fontSize: '12px', color: '#DC2626', margin: 0 },
  newTripActions: { display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '4px' },
  cancelBtn: { height: '36px', padding: '0 14px', background: '#fff', color: '#374151', fontSize: '13px', fontWeight: 500, border: '1px solid #D1D5DB', borderRadius: '8px', cursor: 'pointer' },
  createBtn: { height: '36px', padding: '0 16px', background: '#000835', color: '#fff', fontSize: '13px', fontWeight: 600, border: 'none', borderRadius: '8px', cursor: 'pointer' },

  deskCard: { padding: '14px 16px', background: '#EEF2FF', border: '1px solid #C7D2FE', borderRadius: '12px', marginBottom: '16px' },
  deskText: { fontSize: '13px', color: '#3730A3', margin: 0, lineHeight: 1.5 },
  errorCard: { padding: '16px', background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: '12px', marginBottom: '16px' },
  errorTitle: { fontSize: '13px', color: '#DC2626', margin: 0 },

  loadingCard: { display: 'flex', justifyContent: 'center', padding: '60px 0' },
  spinner: { width: '22px', height: '22px', border: '2.5px solid #E5E7EB', borderTopColor: '#000835', borderRadius: '50%', animation: 'spin 0.7s linear infinite' },

  emptyCard: { textAlign: 'center' as const, padding: '48px 24px', background: '#fff', border: '1px dashed #D1D5DB', borderRadius: '14px' },
  emptyTitle: { fontSize: '14px', fontWeight: 600, color: '#111827', margin: '0 0 6px' },
  emptySub: { fontSize: '13px', color: '#9CA3AF', margin: 0, maxWidth: '360px', marginLeft: 'auto', marginRight: 'auto', lineHeight: 1.5 },

  tripsList: { display: 'flex', flexDirection: 'column', gap: '10px' },
  tripCard: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    background: '#fff', border: '1px solid #E5E7EB', borderRadius: '12px', padding: '4px 4px 4px 18px',
    width: '100%', boxSizing: 'border-box' as const,
  },
  tripCardMainBtn: {
    display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '4px', textAlign: 'left' as const,
    background: 'none', border: 'none', cursor: 'pointer', font: 'inherit', flex: 1,
    padding: '12px 0', minWidth: 0,
  },
  tripCardMain: { display: 'flex', alignItems: 'center', gap: '10px' },
  tripName: { fontSize: '14px', fontWeight: 600, color: '#111827' },
  tripMeta: { fontSize: '12px', color: '#9CA3AF' },
  statusTag: { fontSize: '10px', fontWeight: 700, padding: '2px 8px', borderRadius: '5px', letterSpacing: '0.3px', textTransform: 'uppercase' as const },
  statusOpen: { color: '#92400E', background: '#FEF3C7' },
  statusOther: { color: '#065F46', background: '#ECFDF5' },

  deleteIconBtn: {
    flexShrink: 0, width: '38px', height: '38px', display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'none', border: 'none', borderRadius: '8px', cursor: 'pointer', fontSize: '15px', color: '#9CA3AF',
  },

  confirmRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', padding: '12px 6px 12px 12px', gap: '12px' },
  confirmText: { fontSize: '13px', color: '#374151', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const },
  confirmActions: { display: 'flex', gap: '8px', flexShrink: 0 },
  confirmCancelBtn: { height: '32px', padding: '0 12px', background: '#fff', color: '#374151', fontSize: '12px', fontWeight: 500, border: '1px solid #D1D5DB', borderRadius: '7px', cursor: 'pointer' },
  confirmDeleteBtn: { height: '32px', padding: '0 12px', background: '#DC2626', color: '#fff', fontSize: '12px', fontWeight: 600, border: 'none', borderRadius: '7px', cursor: 'pointer' },
}