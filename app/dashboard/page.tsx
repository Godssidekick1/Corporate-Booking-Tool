'use client'

import { useState } from 'react'

// ─── Types ────────────────────────────────────────────────────────────────────

interface ChecklistItem {
  id: string
  label: string
  desc: string
  done: boolean
  href: string
  cta: string
}

// ─── Mock data — replace with real API calls ──────────────────────────────────

const INITIAL_CHECKLIST: ChecklistItem[] = [
  {
    id: 'company',
    label: 'Company created',
    desc: 'Your account is active.',
    done: true,
    href: '/settings/company',
    cta: 'View',
  },
  {
    id: 'policy',
    label: 'Confirm your travel policy',
    desc: 'Review and adjust band limits before your team starts booking.',
    done: false,
    href: '/settings/policy',
    cta: 'Review policy',
  },
  {
    id: 'employees',
    label: 'Add your first employee',
    desc: 'Invite team members and assign bands.',
    done: false,
    href: '/settings/users',
    cta: 'Add employees',
  },
  {
    id: 'payment',
    label: 'Connect a payment method',
    desc: 'Required before any booking can be confirmed.',
    done: false,
    href: '/settings/integrations',
    cta: 'Add payment method',
  },
  {
    id: 'booking',
    label: 'Make your first booking',
    desc: 'Search for a flight, hotel, or car rental.',
    done: false,
    href: '/book',
    cta: 'Start booking',
  },
]

const NAV_ITEMS = [
  { label: 'Dashboard', href: '/dashboard', active: true },
  { label: 'Book travel', href: '/book', active: false },
  { label: 'My bookings', href: '/bookings', active: false },
  { label: 'Approvals', href: '/approvals', active: false },
  { label: 'Reports', href: '/reports', active: false },
  { label: 'Settings', href: '/settings', active: false },
]

// ─── Component ────────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const [checklist, setChecklist] = useState<ChecklistItem[]>(INITIAL_CHECKLIST)
  const [checklistDismissed, setChecklistDismissed] = useState(false)

  const completedCount = checklist.filter(i => i.done).length
  const totalCount = checklist.length
  const allDone = completedCount === totalCount

  function markDone(id: string) {
    setChecklist(prev => prev.map(i => i.id === id ? { ...i, done: true } : i))
  }

  const firstName = 'Jane' // Replace with session user data

  return (
    <div style={styles.root}>
      {/* Sidebar nav */}
      <nav style={styles.nav}>
        <div>
          <div style={styles.navWordmark}>
            <span style={styles.navWordmarkMain}>TravelDesk</span>
            <span style={styles.navWordmarkBy}>by Amadeus</span>
          </div>
          <div style={styles.navItems}>
            {NAV_ITEMS.map(item => (
              <a
                key={item.label}
                href={item.href}
                style={{
                  ...styles.navItem,
                  backgroundColor: item.active ? 'rgba(255,255,255,0.1)' : 'transparent',
                  color: item.active ? '#FFFFFF' : 'rgba(255,255,255,0.5)',
                  fontWeight: item.active ? '600' : '400',
                }}
              >
                {item.label}
              </a>
            ))}
          </div>
        </div>
        <div style={styles.navFooter}>
          <div style={styles.userInfo}>
            <div style={styles.userAvatar}>
              {firstName[0]}
            </div>
            <div>
              <p style={styles.userName}>{firstName} Smith</p>
              <p style={styles.userRole}>Admin · L4</p>
            </div>
          </div>
          <form action="/api/auth/signout" method="POST" style={{ marginTop: '12px' }}>
            <button type="submit" style={styles.signOutBtn}>Sign out</button>
          </form>
        </div>
      </nav>

      {/* Main content */}
      <main style={styles.main}>
        {/* Top bar */}
        <div style={styles.topBar}>
          <div>
            <h1 style={styles.pageTitle}>Good morning, {firstName}</h1>
            <p style={styles.pageSubtitle}>
              {new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
            </p>
          </div>
          <a href="/book" style={styles.bookBtn}>+ New booking</a>
        </div>

        {/* Setup checklist — shown until dismissed or all done */}
        {!checklistDismissed && (
          <div style={styles.checklistCard}>
            <div style={styles.checklistHeader}>
              <div>
                <h2 style={styles.checklistTitle}>
                  {allDone ? '🎉 You\'re all set!' : 'Finish setting up TravelDesk'}
                </h2>
                <p style={styles.checklistSubtitle}>
                  {allDone
                    ? 'Your workspace is fully configured.'
                    : `${completedCount} of ${totalCount} steps complete`
                  }
                </p>
              </div>
              <button
                onClick={() => setChecklistDismissed(true)}
                style={styles.dismissBtn}
                aria-label="Dismiss checklist"
              >
                ✕
              </button>
            </div>

            {/* Progress bar */}
            <div style={styles.progressTrack}>
              <div style={{
                ...styles.progressFill,
                width: `${(completedCount / totalCount) * 100}%`,
              }} />
            </div>

            {/* Items */}
            <div style={styles.checklistItems}>
              {checklist.map(item => (
                <div key={item.id} style={{
                  ...styles.checklistItem,
                  opacity: item.done ? 0.6 : 1,
                }}>
                  <div style={{
                    ...styles.checkDot,
                    backgroundColor: item.done ? '#22C55E' : '#FFFFFF',
                    borderColor: item.done ? '#22C55E' : '#D1D5DB',
                  }}>
                    {item.done && <span style={styles.checkMark}>✓</span>}
                  </div>
                  <div style={styles.checkContent}>
                    <p style={{
                      ...styles.checkLabel,
                      textDecoration: item.done ? 'line-through' : 'none',
                      color: item.done ? '#9CA3AF' : '#111827',
                    }}>
                      {item.label}
                    </p>
                    {!item.done && <p style={styles.checkDesc}>{item.desc}</p>}
                  </div>
                  {!item.done && (
                    <a href={item.href} style={styles.checkCta} onClick={() => markDone(item.id)}>
                      {item.cta} →
                    </a>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Stats row */}
        <div style={styles.statsRow}>
          {[
            { label: 'Bookings this month', value: '0', sub: 'No bookings yet' },
            { label: 'Pending approvals', value: '0', sub: 'Nothing to action' },
            { label: 'Policy compliance', value: '—', sub: 'Starts once bookings are made' },
            { label: 'Total spend (MTD)', value: '—', sub: 'No spend recorded' },
          ].map(stat => (
            <div key={stat.label} style={styles.statCard}>
              <p style={styles.statLabel}>{stat.label}</p>
              <p style={styles.statValue}>{stat.value}</p>
              <p style={styles.statSub}>{stat.sub}</p>
            </div>
          ))}
        </div>

        {/* Recent bookings — empty state */}
        <div style={styles.section}>
          <div style={styles.sectionHeader}>
            <h2 style={styles.sectionTitle}>Recent bookings</h2>
            <a href="/bookings" style={styles.sectionLink}>View all</a>
          </div>
          <div style={styles.emptyState}>
            <div style={styles.emptyIcon}>✈</div>
            <p style={styles.emptyTitle}>No bookings yet</p>
            <p style={styles.emptyDesc}>
              When your team starts booking, their trips will appear here.
            </p>
            <a href="/book" style={styles.emptyAction}>Make your first booking →</a>
          </div>
        </div>

        {/* Pending approvals — empty state */}
        <div style={styles.section}>
          <div style={styles.sectionHeader}>
            <h2 style={styles.sectionTitle}>Pending approvals</h2>
            <a href="/approvals" style={styles.sectionLink}>View all</a>
          </div>
          <div style={styles.emptyState}>
            <div style={styles.emptyIcon}>✔</div>
            <p style={styles.emptyTitle}>No pending approvals</p>
            <p style={styles.emptyDesc}>
              Out-of-policy booking requests will show up here for you to approve or reject.
            </p>
          </div>
        </div>
      </main>
    </div>
  )
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  root: {
    display: 'flex', minHeight: '100vh',
    fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
    backgroundColor: '#F7F8FC',
  },

  // Nav
  nav: {
    width: '220px', flexShrink: 0, backgroundColor: '#000835',
    display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
    padding: '32px 20px',
  },
  navWordmark: { display: 'flex', flexDirection: 'column', gap: '3px', marginBottom: '32px' },
  navWordmarkMain: { fontSize: '18px', fontWeight: '700', color: '#FFFFFF', letterSpacing: '-0.4px' },
  navWordmarkBy: {
    fontSize: '10px', fontWeight: '400', color: 'rgba(255,255,255,0.35)',
    letterSpacing: '0.5px', textTransform: 'uppercase' as const,
  },
  navItems: { display: 'flex', flexDirection: 'column', gap: '2px' },
  navItem: {
    display: 'block', padding: '9px 12px', borderRadius: '7px',
    fontSize: '13px', textDecoration: 'none', transition: 'all 0.15s',
  },
  navFooter: { borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: '16px' },
  userInfo: { display: 'flex', alignItems: 'center', gap: '10px' },
  userAvatar: {
    width: '32px', height: '32px', borderRadius: '50%',
    backgroundColor: 'rgba(255,255,255,0.15)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontSize: '13px', fontWeight: '600', color: '#FFFFFF', flexShrink: 0,
  },
  userName: { fontSize: '12px', fontWeight: '600', color: '#FFFFFF', margin: 0 },
  userRole: { fontSize: '11px', color: 'rgba(255,255,255,0.4)', margin: 0 },
  signOutBtn: {
    width: '100%', height: '32px',
    backgroundColor: 'rgba(255,255,255,0.06)',
    color: 'rgba(255,255,255,0.45)', fontSize: '12px',
    border: 'none', borderRadius: '6px', cursor: 'pointer',
  },

  // Main
  main: { flex: 1, overflowY: 'auto' as const, padding: '36px 40px' },
  topBar: {
    display: 'flex', justifyContent: 'space-between',
    alignItems: 'flex-start', marginBottom: '28px',
  },
  pageTitle: {
    fontSize: '22px', fontWeight: '700', color: '#0A0A14',
    margin: '0 0 4px', letterSpacing: '-0.3px',
  },
  pageSubtitle: { fontSize: '13px', color: '#9CA3AF', margin: 0 },
  bookBtn: {
    display: 'inline-block', height: '38px', lineHeight: '38px',
    padding: '0 16px', backgroundColor: '#000835', color: '#FFFFFF',
    fontSize: '13px', fontWeight: '600',
    borderRadius: '8px', textDecoration: 'none',
  },

  // Checklist
  checklistCard: {
    backgroundColor: '#FFFFFF', border: '1px solid #E5E7EB',
    borderRadius: '12px', padding: '24px', marginBottom: '24px',
  },
  checklistHeader: {
    display: 'flex', justifyContent: 'space-between',
    alignItems: 'flex-start', marginBottom: '14px',
  },
  checklistTitle: {
    fontSize: '16px', fontWeight: '700', color: '#111827', margin: '0 0 4px',
  },
  checklistSubtitle: { fontSize: '13px', color: '#6B7280', margin: 0 },
  dismissBtn: {
    backgroundColor: 'transparent', border: 'none',
    color: '#9CA3AF', fontSize: '16px', cursor: 'pointer', padding: '0 4px',
  },
  progressTrack: {
    height: '4px', backgroundColor: '#F3F4F6',
    borderRadius: '2px', overflow: 'hidden', marginBottom: '20px',
  },
  progressFill: {
    height: '100%', backgroundColor: '#22C55E',
    borderRadius: '2px', transition: 'width 0.4s ease',
  },
  checklistItems: { display: 'flex', flexDirection: 'column', gap: '12px' },
  checklistItem: {
    display: 'flex', alignItems: 'flex-start', gap: '12px',
  },
  checkDot: {
    width: '20px', height: '20px', borderRadius: '50%',
    border: '2px solid', flexShrink: 0, marginTop: '1px',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    transition: 'all 0.2s',
  },
  checkMark: { fontSize: '11px', color: '#FFFFFF', fontWeight: '700' },
  checkContent: { flex: 1, minWidth: 0 },
  checkLabel: { fontSize: '13px', fontWeight: '500', margin: '0 0 2px' },
  checkDesc: { fontSize: '12px', color: '#6B7280', margin: 0 },
  checkCta: {
    fontSize: '12px', fontWeight: '600', color: '#000835',
    textDecoration: 'none', whiteSpace: 'nowrap' as const, flexShrink: 0,
    marginTop: '1px',
  },

  // Stats
  statsRow: {
    display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)',
    gap: '16px', marginBottom: '28px',
  },
  statCard: {
    backgroundColor: '#FFFFFF', border: '1px solid #E5E7EB',
    borderRadius: '10px', padding: '18px 20px',
  },
  statLabel: { fontSize: '11px', fontWeight: '600', color: '#9CA3AF', margin: '0 0 8px',
    textTransform: 'uppercase' as const, letterSpacing: '0.5px' },
  statValue: { fontSize: '26px', fontWeight: '700', color: '#111827', margin: '0 0 4px' },
  statSub: { fontSize: '11px', color: '#9CA3AF', margin: 0 },

  // Sections
  section: {
    backgroundColor: '#FFFFFF', border: '1px solid #E5E7EB',
    borderRadius: '10px', padding: '20px', marginBottom: '20px',
  },
  sectionHeader: {
    display: 'flex', justifyContent: 'space-between',
    alignItems: 'center', marginBottom: '16px',
  },
  sectionTitle: { fontSize: '14px', fontWeight: '700', color: '#111827', margin: 0 },
  sectionLink: { fontSize: '12px', color: '#000835', textDecoration: 'none', fontWeight: '500' },

  // Empty states
  emptyState: {
    display: 'flex', flexDirection: 'column',
    alignItems: 'center', padding: '32px 0', textAlign: 'center' as const,
  },
  emptyIcon: {
    fontSize: '28px', marginBottom: '12px',
    backgroundColor: '#F9FAFB', width: '56px', height: '56px',
    borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  emptyTitle: { fontSize: '14px', fontWeight: '600', color: '#374151', margin: '0 0 6px' },
  emptyDesc: { fontSize: '13px', color: '#9CA3AF', maxWidth: '340px', margin: '0 0 16px', lineHeight: '1.5' },
  emptyAction: {
    fontSize: '13px', fontWeight: '600', color: '#000835', textDecoration: 'none',
  },
}