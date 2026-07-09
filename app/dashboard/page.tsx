'use client'

import { useState, useEffect } from 'react'
import { createBrowserClient } from '@supabase/ssr'

const supabase = createBrowserClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

interface Employee {
  id: string
  full_name: string
  email: string
  role: string
  band_code: string
  company_id: string
}

interface Company {
  id: string
  name: string
}

interface ChecklistItem {
  id: string
  label: string
  desc: string
  done: boolean
  href: string
  cta: string
}

function getNavItems(role: string) {
  const base = [
    { label: 'Dashboard',   href: '/dashboard', active: true  },
    { label: 'Book travel', href: '/book',       active: false },
    { label: 'My trips',    href: '/bookings',   active: false },
  ]
  if (['admin', 'manager', 'finance'].includes(role))
    base.push({ label: 'Approvals', href: '/approvals', active: false })
  if (['admin', 'finance'].includes(role))
    base.push({ label: 'Reports', href: '/reports', active: false })
  if (role === 'admin')
    base.push({ label: 'Settings', href: '/settings', active: false })
  return base
}

function getGreeting() {
  const h = new Date().getHours()
  if (h < 12) return 'Good morning'
  if (h < 17) return 'Good afternoon'
  return 'Good evening'
}

export default function DashboardPage() {
  const [employee, setEmployee] = useState<Employee | null>(null)
  const [company, setCompany] = useState<Company | null>(null)
  const [loading, setLoading] = useState(true)
  const [companySettings, setCompanySettings] = useState<Record<string, unknown>>({})
  const [checklist, setChecklist] = useState<ChecklistItem[]>([
    { id: 'company',   label: 'Company created',            desc: 'Your account is active.',                                       done: true,  href: '/settings/company',      cta: 'View'               },
    { id: 'policy',    label: 'Confirm your travel policy', desc: 'Review and adjust band limits before your team starts booking.', done: false, href: '/settings/policy',       cta: 'Review policy'      },
    { id: 'employees', label: 'Add your first employee',    desc: 'Invite team members and assign bands.',                         done: false, href: '/settings/users',        cta: 'Add employees'      },
    { id: 'payment',   label: 'Connect a payment method',   desc: 'Required before any booking can be confirmed.',                 done: false, href: '/settings/integrations', cta: 'Add payment method' },
    { id: 'booking',   label: 'Make your first booking',    desc: 'Search for a flight, hotel, or car rental.',                   done: false, href: '/book',                  cta: 'Start booking'      },
  ])

  useEffect(() => {
    fetch('/api/me')
      .then(r => r.json())
      .then(data => {
        if (data.ok) {
          setEmployee(data.employee)
          setCompany(data.company)
          setCompanySettings(data.company?.settings ?? {})
        }
      })
      .finally(() => setLoading(false))
  }, [])

 async function handleSignOut() {
  await fetch('/api/auth/signout', { method: 'POST' })
  window.location.href = '/login'
}

  const firstName = employee?.full_name?.split(' ')[0] ?? '…'
  const roleLabel = employee
    ? `${employee.role.charAt(0).toUpperCase() + employee.role.slice(1)}${employee.band_code ? ` · ${employee.band_code}` : ''}`
    : '…'
  const avatarLetter = employee?.full_name?.[0]?.toUpperCase() ?? '?'
  const navItems = getNavItems(employee?.role ?? '')
  const completedCount = checklist.filter(i => i.done).length
  const allDone = completedCount === checklist.length

  function markDone(id: string) {
    setChecklist(prev => prev.map(i => i.id === id ? { ...i, done: true } : i))
  }

  return (
    <div style={s.root}>
      {/* Sidebar */}
      <nav style={s.nav}>
        <div>
          <div style={s.wordmark}>
            <span style={s.wmMain}>TravelDesk</span>
            <span style={s.wmBy}>by Amadeus</span>
          </div>
          {company && <p style={s.companyName}>{company.name}</p>}
          <div style={s.navItems}>
            {navItems.map(item => (
              <a key={item.label} href={item.href} style={{
                ...s.navItem,
                backgroundColor: item.active ? 'rgba(255,255,255,0.1)' : 'transparent',
                color: item.active ? '#FFFFFF' : 'rgba(255,255,255,0.5)',
                fontWeight: item.active ? '600' : '400',
              }}>
                {item.label}
              </a>
            ))}
          </div>
        </div>
        <div style={s.navFooter}>
          <div style={s.userInfo}>
            <div style={s.avatar}>{loading ? '?' : avatarLetter}</div>
            <div>
              <p style={s.userName}>{loading ? '…' : employee?.full_name ?? '—'}</p>
              <p style={s.userRole}>{loading ? '…' : roleLabel}</p>
            </div>
          </div>
          <button onClick={handleSignOut} style={{ ...s.signOutBtn, marginTop: '12px' }}>
            Sign out
          </button>
        </div>
      </nav>

      {/* Main */}
      <main style={s.main}>
        <div style={s.topBar}>
          <div>
            <h1 style={s.pageTitle}>{getGreeting()}, {firstName}</h1>
            <p style={s.pageSubtitle}>
              {new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
            </p>
          </div>
          <a href="/book" style={s.bookBtn}>+ New booking</a>
        </div>

        {employee?.role === 'admin' && !companySettings.setup_confirmed && (
          <div style={s.checklistCard}>
            <div style={s.checklistHeader}>
              <div>
                <h2 style={s.checklistTitle}>
                  {allDone ? '🎉 You\'re all set!' : 'Finish setting up TravelDesk'}
                </h2>
                <p style={s.checklistSub}>
                  {allDone ? 'Your workspace is fully configured.' : `${completedCount} of ${checklist.length} steps complete`}
                </p>
              </div>
            </div>
            <div style={s.progressTrack}>
              <div style={{ ...s.progressFill, width: `${(completedCount / checklist.length) * 100}%` }} />
            </div>
            <div style={s.checklistItems}>
              {checklist.map(item => (
                <div key={item.id} style={{ ...s.checklistItem, opacity: item.done ? 0.6 : 1 }}>
                  <div style={{ ...s.checkDot, backgroundColor: item.done ? '#22C55E' : '#FFFFFF', borderColor: item.done ? '#22C55E' : '#D1D5DB' }}>
                    {item.done && <span style={s.checkMark}>✓</span>}
                  </div>
                  <div style={s.checkContent}>
                    <p style={{ ...s.checkLabel, textDecoration: item.done ? 'line-through' : 'none', color: item.done ? '#9CA3AF' : '#111827' }}>
                      {item.label}
                    </p>
                    {!item.done && <p style={s.checkDesc}>{item.desc}</p>}
                  </div>
                  {!item.done && (
                    <a href={item.href} style={s.checkCta} onClick={() => markDone(item.id)}>
                      {item.cta} →
                    </a>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        <div style={s.statsRow}>
          {[
            { label: 'Bookings this month', value: '0', sub: 'No bookings yet' },
            { label: 'Pending approvals',   value: '0', sub: 'Nothing to action' },
            { label: 'Policy compliance',   value: '—', sub: 'Starts once bookings are made' },
            { label: 'Total spend (MTD)',    value: '—', sub: 'No spend recorded' },
          ].map(stat => (
            <div key={stat.label} style={s.statCard}>
              <p style={s.statLabel}>{stat.label}</p>
              <p style={s.statValue}>{stat.value}</p>
              <p style={s.statSub}>{stat.sub}</p>
            </div>
          ))}
        </div>

        <div style={s.section}>
          <div style={s.sectionHeader}>
            <h2 style={s.sectionTitle}>Recent bookings</h2>
            <a href="/bookings" style={s.sectionLink}>View all</a>
          </div>
          <div style={s.emptyState}>
            <div style={s.emptyIcon}>✈</div>
            <p style={s.emptyTitle}>No bookings yet</p>
            <p style={s.emptyDesc}>When your team starts booking, their trips will appear here.</p>
            <a href="/book" style={s.emptyAction}>Make your first booking →</a>
          </div>
        </div>

        {['admin', 'manager', 'finance'].includes(employee?.role ?? '') && (
          <div style={s.section}>
            <div style={s.sectionHeader}>
              <h2 style={s.sectionTitle}>Pending approvals</h2>
              <a href="/approvals" style={s.sectionLink}>View all</a>
            </div>
            <div style={s.emptyState}>
              <div style={s.emptyIcon}>✔</div>
              <p style={s.emptyTitle}>No pending approvals</p>
              <p style={s.emptyDesc}>Out-of-policy booking requests will show up here for you to approve or reject.</p>
            </div>
          </div>
        )}
      </main>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  root: { display: 'flex', minHeight: '100vh', fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif", backgroundColor: '#F7F8FC' },
  nav: { width: '220px', flexShrink: 0, backgroundColor: '#000835', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', padding: '32px 20px' },
  wordmark: { display: 'flex', flexDirection: 'column', gap: '3px', marginBottom: '8px' },
  wmMain: { fontSize: '18px', fontWeight: '700', color: '#FFFFFF', letterSpacing: '-0.4px' },
  wmBy: { fontSize: '10px', fontWeight: '400', color: 'rgba(255,255,255,0.35)', letterSpacing: '0.5px', textTransform: 'uppercase' as const },
  companyName: { fontSize: '11px', color: 'rgba(255,255,255,0.4)', margin: '0 0 24px', whiteSpace: 'nowrap' as const, overflow: 'hidden', textOverflow: 'ellipsis' },
  navItems: { display: 'flex', flexDirection: 'column', gap: '2px' },
  navItem: { display: 'block', padding: '9px 12px', borderRadius: '7px', fontSize: '13px', textDecoration: 'none' },
  navFooter: { borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: '16px' },
  userInfo: { display: 'flex', alignItems: 'center', gap: '10px' },
  avatar: { width: '32px', height: '32px', borderRadius: '50%', backgroundColor: 'rgba(255,255,255,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '13px', fontWeight: '600', color: '#FFFFFF', flexShrink: 0 },
  userName: { fontSize: '12px', fontWeight: '600', color: '#FFFFFF', margin: 0 },
  userRole: { fontSize: '11px', color: 'rgba(255,255,255,0.4)', margin: 0 },
  signOutBtn: { width: '100%', height: '32px', backgroundColor: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.45)', fontSize: '12px', border: 'none', borderRadius: '6px', cursor: 'pointer' },
  main: { flex: 1, overflowY: 'auto' as const, padding: '36px 40px' },
  topBar: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '28px' },
  pageTitle: { fontSize: '22px', fontWeight: '700', color: '#0A0A14', margin: '0 0 4px', letterSpacing: '-0.3px' },
  pageSubtitle: { fontSize: '13px', color: '#9CA3AF', margin: 0 },
  bookBtn: { display: 'inline-block', height: '38px', lineHeight: '38px', padding: '0 16px', backgroundColor: '#000835', color: '#FFFFFF', fontSize: '13px', fontWeight: '600', borderRadius: '8px', textDecoration: 'none' },
  checklistCard: { backgroundColor: '#FFFFFF', border: '1px solid #E5E7EB', borderRadius: '12px', padding: '24px', marginBottom: '24px' },
  checklistHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '14px' },
  checklistTitle: { fontSize: '16px', fontWeight: '700', color: '#111827', margin: '0 0 4px' },
  checklistSub: { fontSize: '13px', color: '#6B7280', margin: 0 },
  progressTrack: { height: '4px', backgroundColor: '#F3F4F6', borderRadius: '2px', overflow: 'hidden', marginBottom: '20px' },
  progressFill: { height: '100%', backgroundColor: '#22C55E', borderRadius: '2px', transition: 'width 0.4s ease' },
  checklistItems: { display: 'flex', flexDirection: 'column', gap: '12px' },
  checklistItem: { display: 'flex', alignItems: 'flex-start', gap: '12px' },
  checkDot: { width: '20px', height: '20px', borderRadius: '50%', border: '2px solid', flexShrink: 0, marginTop: '1px', display: 'flex', alignItems: 'center', justifyContent: 'center' },
  checkMark: { fontSize: '11px', color: '#FFFFFF', fontWeight: '700' },
  checkContent: { flex: 1, minWidth: 0 },
  checkLabel: { fontSize: '13px', fontWeight: '500', margin: '0 0 2px' },
  checkDesc: { fontSize: '12px', color: '#6B7280', margin: 0 },
  checkCta: { fontSize: '12px', fontWeight: '600', color: '#000835', textDecoration: 'none', whiteSpace: 'nowrap' as const, flexShrink: 0, marginTop: '1px' },
  statsRow: { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '16px', marginBottom: '28px' },
  statCard: { backgroundColor: '#FFFFFF', border: '1px solid #E5E7EB', borderRadius: '10px', padding: '18px 20px' },
  statLabel: { fontSize: '11px', fontWeight: '600', color: '#9CA3AF', margin: '0 0 8px', textTransform: 'uppercase' as const, letterSpacing: '0.5px' },
  statValue: { fontSize: '26px', fontWeight: '700', color: '#111827', margin: '0 0 4px' },
  statSub: { fontSize: '11px', color: '#9CA3AF', margin: 0 },
  section: { backgroundColor: '#FFFFFF', border: '1px solid #E5E7EB', borderRadius: '10px', padding: '20px', marginBottom: '20px' },
  sectionHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' },
  sectionTitle: { fontSize: '14px', fontWeight: '700', color: '#111827', margin: 0 },
  sectionLink: { fontSize: '12px', color: '#000835', textDecoration: 'none', fontWeight: '500' },
  emptyState: { display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '32px 0', textAlign: 'center' as const },
  emptyIcon: { fontSize: '28px', marginBottom: '12px', backgroundColor: '#F9FAFB', width: '56px', height: '56px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center' },
  emptyTitle: { fontSize: '14px', fontWeight: '600', color: '#374151', margin: '0 0 6px' },
  emptyDesc: { fontSize: '13px', color: '#9CA3AF', maxWidth: '340px', margin: '0 0 16px', lineHeight: '1.5' },
  emptyAction: { fontSize: '13px', fontWeight: '600', color: '#000835', textDecoration: 'none' },
}