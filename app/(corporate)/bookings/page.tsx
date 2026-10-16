'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useCanSelfBook } from '@/app/hooks/useCanSelfBook'
import TripList from '@/app/components/trips/TripList'

// ── /bookings — "My trips" ────────────────────────────────────────────────────
// Every trip with its flights nested inside it, and the flights that sit in
// no trip -- the full history. The trips page (/book) shows the same cards
// for picking up and starting trips; both use TripList and TripCard
// (app/components/trips), so a trip looks the same wherever it appears.
//
// A corporate admin also books for colleagues. Those trips are the
// colleagues', and live on a tab of their own -- never mixed in with the
// admin's own.
// ─────────────────────────────────────────────────────────────────────────────

export default function BookingsPage() {
  const canSelfBook = useCanSelfBook()
  const [isAdmin, setIsAdmin] = useState(false)
  const [tab, setTab] = useState<'mine' | 'others'>('mine')
  useEffect(() => {
    fetch('/api/me').then(r => r.json()).then(d => setIsAdmin(d.employee?.role === 'admin')).catch(() => {})
  }, [])

  return (
    <div style={s.page}>
      <div className="page-frame narrow" style={s.root}>
        <div style={s.header}>
          <h1 style={s.heading}>My trips</h1>
          {canSelfBook && <Link href="/book" style={s.newBtn}>+ New booking</Link>}
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

        {tab === 'others' && (
          <p style={s.tabHint}>
            Trips you set up for colleagues, their own trips you booked into, and flights you booked for them.
            Each is theirs: it is in their My trips too.
          </p>
        )}

        {/* key: switching tab starts that list afresh, from page 1. */}
        <TripList
          key={tab}
          others={tab === 'others'}
          emptyAction={canSelfBook && tab === 'mine' ? <Link href="/book" style={s.emptyCta}>Start your first trip →</Link> : null}
        />
      </div>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  page: { background: '#F9FAFB', minHeight: '100vh' },
  // Padding and width: the shared .page-frame (globals.css).
  root: { fontFamily: "'Inter', -apple-system, sans-serif" },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 20, flexWrap: 'wrap' },
  heading: { fontSize: 22, fontWeight: 700, color: '#0A0A14', margin: 0, letterSpacing: '-0.4px' },
  newBtn: { fontSize: 13, fontWeight: 600, color: '#fff', background: '#000835', padding: '9px 16px', borderRadius: 9, textDecoration: 'none' },
  tabs: { display: 'flex', gap: 4, borderBottom: '1px solid #E5E7EB', margin: '-4px 0 16px' },
  // Three sides off and the bottom set, as in app/components/Tabs.tsx: border: 'none'
  // beside a changing borderBottomColor made React warn when the tab changed.
  tab: { borderTop: 'none', borderLeft: 'none', borderRight: 'none', borderBottom: '2px solid transparent', background: 'transparent', padding: '8px 12px', fontSize: 13, color: '#6B7280', cursor: 'pointer', marginBottom: -1 },
  tabOn: { color: '#000835', fontWeight: 600, borderBottom: '2px solid #000835' },
  tabHint: { fontSize: 12.5, color: '#6B7280', margin: '-6px 0 16px', lineHeight: 1.6 },
  emptyCta: { fontSize: 13, fontWeight: 600, color: '#000835', textDecoration: 'underline' },
}
