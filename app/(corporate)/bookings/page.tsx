'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useCanSelfBook } from '@/app/hooks/useCanSelfBook'
import TripList from '@/app/components/trips/TripList'
import TripForm from '@/app/components/trips/TripForm'

// ── /bookings — "My trips" ────────────────────────────────────────────────────
// Everything one has, in one place: each trip with its flights nested inside
// it, and the flights that sit in no trip. From here a trip is started
// ("+ New trip", which asks what it is for), finished or deleted, and a
// search begun. The sidebar's "Book travel" goes straight to the search.
//
// It used to be two pages: this one, and a "Trips" page at /book with the
// same list, minus the loose flights, plus the trip buttons (user,
// 2026-11-17: "why are these pages same and different at the same time").
// /book now sends people here.
//
// A corporate admin also books for colleagues. Those trips are the
// colleagues', and live on a tab of their own -- never mixed in with the
// admin's own -- and an admin can make a new trip a colleague's. At a CBT-only
// company the travel desk books, so there is no "+ New trip"; what it books
// still appears.
// ─────────────────────────────────────────────────────────────────────────────

export default function MyTripsPage() {
  const router = useRouter()
  const canSelfBook = useCanSelfBook()
  const [isAdmin, setIsAdmin] = useState(false)
  const [tab, setTab] = useState<'mine' | 'others'>('mine')
  const [formOpen, setFormOpen] = useState(false)
  useEffect(() => {
    fetch('/api/me').then(r => r.json()).then(d => setIsAdmin(d.employee?.role === 'admin')).catch(() => {})
  }, [])

  return (
    <div style={s.page}>
      <div className="page-frame narrow" style={s.root}>
        <div style={s.header}>
          <div>
            <h1 style={s.heading}>My trips</h1>
            <p style={s.sub}>
              {canSelfBook === false
                ? 'Trips your travel desk has booked for you.'
                : 'Your trips and flights. Pick one up, or start something new.'}
            </p>
          </div>
          {canSelfBook && (
            <div style={s.headerActions}>
              <Link href="/book/flights" style={s.secondaryBtn}>Search flights</Link>
              <button type="button" onClick={() => setFormOpen(true)} style={s.primaryBtn}>+ New trip</button>
            </div>
          )}
        </div>

        {isAdmin && (
          <div style={s.tabs} role="tablist">
            {(['mine', 'others'] as const).map(t => (
              <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}
                style={{ ...s.tab, ...(tab === t ? s.tabOn : {}) }}>
                {t === 'mine' ? 'My own trips' : 'Arranged for others'}
              </button>
            ))}
          </div>
        )}

        {canSelfBook === false && (
          <p style={s.deskNote}>Your travel desk books travel for your company. Contact them to arrange a trip; it appears here once they do.</p>
        )}

        {tab === 'others' && (
          <p style={s.tabHint}>
            Trips you set up for colleagues, their own trips you booked into, and flights you booked for them.
            Each is theirs: it is in their My trips too.
          </p>
        )}

        {/* key: switching tab starts that list afresh, from page 1. One's own
            trips can be deleted here; a colleague's are theirs to delete. */}
        <TripList
          key={tab}
          others={tab === 'others'}
          allowDelete={tab === 'mine'}
          emptyAction={canSelfBook && tab === 'mine'
            ? <button type="button" onClick={() => setFormOpen(true)} style={s.primaryBtn}>+ New trip</button>
            : null}
        />
      </div>

      <TripForm
        open={formOpen}
        onClose={() => setFormOpen(false)}
        allowColleague={isAdmin}
        onCreated={id => { setFormOpen(false); router.push(`/trips/${id}`) }}
      />
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  page: { background: '#F9FAFB', minHeight: '100vh' },
  // Padding and width: the shared .page-frame (globals.css).
  root: { fontFamily: "'Inter', -apple-system, sans-serif" },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 20, flexWrap: 'wrap' },
  heading: { fontSize: 22, fontWeight: 700, color: '#0A0A14', margin: '0 0 4px', letterSpacing: '-0.4px' },
  sub: { fontSize: 13, color: '#6B7280', margin: 0 },
  headerActions: { display: 'flex', gap: 8, flexWrap: 'wrap' },
  primaryBtn: {
    height: 38, padding: '0 16px', fontSize: 13, fontWeight: 600, color: '#fff', background: '#000835',
    border: 'none', borderRadius: 9, cursor: 'pointer',
  },
  secondaryBtn: {
    display: 'inline-flex', alignItems: 'center', height: 38, padding: '0 14px', fontSize: 13, fontWeight: 600,
    color: '#000835', background: '#fff', border: '1px solid #D1D5DB', borderRadius: 9, textDecoration: 'none',
  },
  tabs: { display: 'flex', gap: 4, borderBottom: '1px solid #E5E7EB', margin: '-4px 0 16px' },
  // Three sides off and the bottom set, as in app/components/Tabs.tsx.
  tab: { borderTop: 'none', borderLeft: 'none', borderRight: 'none', borderBottom: '2px solid transparent', background: 'transparent', padding: '8px 12px', fontSize: 13, color: '#6B7280', cursor: 'pointer', marginBottom: -1 },
  tabOn: { color: '#000835', fontWeight: 600, borderBottom: '2px solid #000835' },
  tabHint: { fontSize: 12.5, color: '#6B7280', margin: '-4px 0 14px', lineHeight: 1.55 },
  deskNote: {
    fontSize: 13, color: '#374151', background: '#fff', border: '1px solid #E5E7EB', borderRadius: 12,
    padding: '12px 16px', margin: '0 0 14px', lineHeight: 1.6,
  },
}
