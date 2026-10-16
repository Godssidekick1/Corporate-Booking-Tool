'use client'

import { useCallback, useEffect, useState } from 'react'
import Pagination from '@/app/components/Pagination'
import TripCard, { FlightRow, type TripCardTrip, type TripCardFlight } from './TripCard'

// ── TripList ─────────────────────────────────────────────────────────────────
// A page of trips as TripCards, each with its flights, from GET /api/bookings
// (one's own) or /api/bookings?for=others (the trips one keeps for colleagues).
// Shared by My trips and the trips page so both look and behave the same.
//
// Acting on a trip -- submit for sign-off, mark complete, delete -- happens
// here and reloads the page of trips, since a submission can sign a trip off
// at once (no chain) or flag it, and the card should show what the server
// decided rather than a guess.
// ─────────────────────────────────────────────────────────────────────────────

interface Group { trip: TripCardTrip; bookings: TripCardFlight[] }

export default function TripList({
  others, showUngrouped = true, allowDelete = false, emptyAction, source, base = '/trips', emptyText,
}: {
  others: boolean
  // Where the page of trips comes from: the company side reads /api/bookings;
  // the travel desk passes /api/tmc/trips with its scope and client filter.
  source?: { endpoint: string; query?: Record<string, string | null | undefined> }
  base?: '/trips' | '/tmc/trips'
  emptyText?: { title: string; desc: string }
  // "Flights not in a trip" below the trips (My trips shows them; the trips page does not).
  showUngrouped?: boolean
  allowDelete?: boolean
  emptyAction?: React.ReactNode
}) {
  const [groups, setGroups] = useState<Group[] | null>(null)
  const [ungrouped, setUngrouped] = useState<TripCardFlight[]>([])
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [pageSize, setPageSize] = useState(10)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<{ id: string; what: 'submit' | 'complete' | 'delete' } | null>(null)
  const [tripErrors, setTripErrors] = useState<Record<string, string>>({})

  // The source's VALUE, so an inline object does not refetch every render.
  const sourceKey = JSON.stringify(source ?? null)

  // Bumped to load the page again after acting on a trip.
  const [reloadKey, setReloadKey] = useState(0)

  // Only the fetch's answer sets state here; what starts a fetch (a page
  // change, an action) marks it loading itself.
  useEffect(() => {
    let live = true
    const src = JSON.parse(sourceKey) as typeof source | null
    const qs = new URLSearchParams({ page: String(page) })
    if (!src && others) qs.set('for', 'others')
    for (const [k, v] of Object.entries(src?.query ?? {})) if (v) qs.set(k, v)
    fetch(`${src?.endpoint ?? '/api/bookings'}?${qs}`)
      .then(async res => {
        const data = await res.json()
        if (!live) return
        if (!res.ok) { setError(data.error || 'Could not load trips.'); return }
        setError('')
        setGroups(data.trips)
        setUngrouped(data.ungroupedBookings ?? [])
        setTotal(data.total ?? 0)
        setPageSize(data.pageSize ?? 10)
      })
      .catch(() => { if (live) setError('Something went wrong loading trips.') })
      .finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [others, page, reloadKey, sourceKey])

  const goTo = useCallback((p: number) => { setLoading(true); setPage(p) }, [])
  const reload = () => { setLoading(true); setReloadKey(k => k + 1) }

  async function act(id: string, what: 'submit' | 'complete' | 'delete') {
    if (what === 'delete' && !window.confirm('Delete this trip? Its bookings stay, outside any trip.')) return
    setBusy({ id, what })
    setTripErrors(e => ({ ...e, [id]: '' }))
    try {
      const res = what === 'submit'
        ? await fetch(`/api/trips/${id}/submit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        : what === 'complete'
          ? await fetch(`/api/trips/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'completed' }) })
          : await fetch(`/api/trips/${id}`, { method: 'DELETE' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setTripErrors(e => ({ ...e, [id]: data.error || 'That did not work. Please try again.' })); return }
      reload()
    } catch {
      setTripErrors(e => ({ ...e, [id]: 'Something went wrong. Please try again.' }))
    } finally {
      setBusy(null)
    }
  }

  if (error) return <div style={s.errorCard}>⚠ {error}</div>
  if (!groups) return <div style={s.loading}><div style={s.spinner} /></div>

  if (groups.length === 0 && ungrouped.length === 0) {
    return (
      <div style={s.emptyState}>
        <p style={s.emptyTitle}>{emptyText?.title ?? (others ? 'Nothing arranged for others yet' : 'No trips yet')}</p>
        <p style={s.emptyDesc}>
          {emptyText?.desc ?? (others
            ? 'Trips you set up for colleagues, and flights you book for them, appear here — and in their own trips too.'
            : 'A trip groups one journey’s flights, with what it is for and its budget.')}
        </p>
        {emptyAction}
      </div>
    )
  }

  return (
    <div style={{ ...s.list, opacity: loading ? 0.6 : 1 }}>
      {groups.map(g => (
        <TripCard
          key={g.trip.id}
          trip={g.trip}
          flights={g.bookings}
          others={others}
          base={base}
          addFlightHref={others ? `${base}/${g.trip.id}` : `/book/flights?tripId=${g.trip.id}`}
          actions={{
            onSubmit: () => act(g.trip.id, 'submit'),
            submitting: busy?.id === g.trip.id && busy.what === 'submit',
            onComplete: others && !g.trip.arranged_by_me ? undefined : () => act(g.trip.id, 'complete'),
            completing: busy?.id === g.trip.id && busy.what === 'complete',
            onDelete: allowDelete && !others ? () => act(g.trip.id, 'delete') : undefined,
            error: tripErrors[g.trip.id] || undefined,
          }}
        />
      ))}

      {showUngrouped && ungrouped.length > 0 && (
        <section style={s.looseCard}>
          <header style={s.looseHead}>
            <span style={s.looseTitle}>{others ? 'Flights booked for others, not in a trip' : 'Flights not in a trip'}</span>
            <span style={s.looseCount}>{ungrouped.length}</span>
          </header>
          <ul style={s.looseList}>
            {ungrouped.map(f => <FlightRow key={f.id} flight={f} others={others} />)}
          </ul>
        </section>
      )}

      <Pagination page={page} pageSize={pageSize} total={total} onPageChange={goTo} busy={loading} noun="trips" />
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  list: { display: 'flex', flexDirection: 'column', gap: 14, transition: 'opacity 0.15s' },
  errorCard: { padding: 16, background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 12, fontSize: 13, color: '#DC2626' },
  loading: { display: 'flex', justifyContent: 'center', padding: '60px 0' },
  spinner: { width: 22, height: 22, border: '2.5px solid #E5E7EB', borderTopColor: '#000835', borderRadius: '50%', animation: 'spin 0.7s linear infinite' },
  emptyState: {
    display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', gap: 6,
    padding: '56px 20px', background: '#fff', border: '1px solid #E5E7EB', borderRadius: 14,
  },
  emptyTitle: { fontSize: 15, fontWeight: 700, color: '#111827', margin: 0 },
  emptyDesc: { fontSize: 13, color: '#6B7280', margin: '0 0 10px', maxWidth: 380, lineHeight: 1.6 },
  looseCard: { background: '#fff', border: '1px solid #E5E7EB', borderRadius: 14, padding: '14px 18px' },
  looseHead: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 },
  looseTitle: { fontSize: 14, fontWeight: 700, color: '#374151' },
  looseCount: { fontSize: 11, fontWeight: 600, color: '#6B7280', background: '#F3F4F6', borderRadius: 10, padding: '1px 8px' },
  looseList: { listStyle: 'none', margin: 0, padding: 0 },
}
