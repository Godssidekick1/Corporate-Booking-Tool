'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createBrowserClient } from '@supabase/ssr'

const supabase = createBrowserClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

interface Employee {
  id: string
  full_name: string
  email: string
  role: 'admin' | 'manager' | 'finance' | 'employee'
  status: string
  company_id: string | null
  band_code: string | null
  band_rank: number | null
  department: string | null
}

interface Company {
  id: string
  name: string
  status: string
  setup_completed: boolean
  settings: {
    approvalModel?: string
  }
}

interface MeResponse {
  ok: boolean
  employee: Employee
  company: Company | null
  employeeCount: number
}

function getChecklist(company: Company | null, employeeCount: number) {
  const hasPolicy = !!(company?.settings?.approvalModel)
  return [
    {
      id: 'company',
      label: 'Company created',
      desc: 'Your account is active.',
      done: true,
      href: '/setup',
      cta: 'View',
    },
    {
      id: 'policy',
      label: 'Confirm your travel policy',
      desc: 'Review and adjust band limits before your team starts booking.',
      done: hasPolicy,
      href: '/setup/policy',
      cta: 'Review policy',
    },
    {
      id: 'employees',
      label: 'Add your first employee',
      desc: 'Invite team members and assign bands.',
      done: employeeCount > 1,
      href: '/setup/invite',
      cta: 'Add employees',
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
}

function getNavItems(role: string) {
  const base = [
    { label: 'Dashboard',   href: '/dashboard' },
    { label: 'Book travel', href: '/book' },
    { label: 'My trips',    href: '/bookings' },
  ]
  if (role === 'admin' || role === 'manager' || role === 'finance') {
    base.push({ label: 'Approvals', href: '/approvals' })
  }
  if (role === 'admin' || role === 'finance') {
    base.push({ label: 'Reports', href: '/reports' })
  }
  if (role === 'admin') {
    base.push({ label: 'Settings', href: '/settings' })
  }
  return base
}

function getStats(role: string) {
  if (role === 'admin' || role === 'finance') {
    return [
      { label: 'Bookings this month', value: '0', sub: 'No bookings yet' },
      { label: 'Pending approvals',   value: '0', sub: 'Nothing to action' },
      { label: 'Policy compliance',   value: '—', sub: 'Starts once bookings are made' },
      { label: 'Total spend (MTD)',    value: '—', sub: 'No spend recorded' },
    ]
  }
  if (role === 'manager') {
    return [
      { label: 'Team bookings',     value: '0', sub: 'No bookings yet' },
      { label: 'Pending approvals', value: '0', sub: 'Nothing to action' },
      { label: 'Team spend (MTD)',  value: '—', sub: 'No spend recorded' },
    ]
  }
  return [
    { label: 'My trips this year', value: '0', sub: 'No trips yet' },
    { label: 'Pending approval',   value: '0', sub: 'Nothing pending' },
    { label: 'Total spend (YTD)',  value: '—', sub: 'No spend recorded' },
  ]
}

export default function DashboardPage() {
  const router = useRouter()
  const [me, setMe] = useState<MeResponse | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/me')
      .then(r => r.json())
      .then((data: MeResponse) => {
        if (!data.ok) { router.replace('/login'); return }
        setMe(data)
      })
      .catch(() => router.replace('/login'))
      .finally(() => setLoading(false))
  }, [router])

  async function handleSignOut() {
    await supabase.auth.signOut()
    router.replace('/login')
  }

  if (loading || !me) return <LoadingScreen />

  const { employee, company } = me
  const { role, full_name, band_code } = employee
  const navItems = getNavItems(role)
  const stats = getStats(role)
  const firstName = full_name?.split(' ')[0] ?? 'there'
  const checklist = getChecklist(company, me.employeeCount ?? 0)
  const completedCount = checklist.filter(i => i.done).length
  const showChecklist = role === 'admin' && !(company?.setup_completed ?? false)

  return (
    <div style={s.root}>
      <nav style={s.nav}>
        <div>
          <div style={s.navWordmark}>
            <span style={s.navWmMain}>TravelDesk</span>
            <span style={s.navWmBy}>by Amadeus</span>
          </div>

          {company && (
            <div style={s.companyBadge}>
              <span style={s.companyDot} />
              <span style={s.companyName}>{company.name}</span>
            </div>
          )}

          <div style={s.navItems}>
            {navItems.map(item => {
              const active = item.href === '/dashboard'
              return (
                <a key={item.label} href={item.href} style={{
                  ...s.navItem,
                  background: active ? 'rgba(255,255,255,0.1)' : 'transparent',
                  color: active ? '#fff' : 'rgba(255,255,255,0.5)',
                  fontWeight: active ? 500 : 400,
                }}>
                  {item.label}
                </a>
              )
            })}
          </div>
        </div>

        <div style={s.navFooter}>
          <div style={s.userInfo}>
            <div style={s.userAvatar}>{firstName[0]}</div>
            <div>
              <p style={s.userName}>{full_name}</p>
              <p style={s.userMeta}>
                {role.charAt(0).toUpperCase() + role.slice(1)}
                {band_code ? ` · ${band_code}` : ''}
              </p>
            </div>
          </div>
          <button onClick={handleSignOut} style={s.signOutBtn}>
            Sign out
          </button>
        </div>
      </nav>

      <main style={s.main}>
        <div style={s.topBar}>
          <div>
            <h1 style={s.pageTitle}>{getGreeting()}, {firstName}</h1>
            <p style={s.pageDate}>
              {new Date().toLocaleDateString('en-GB', {
                weekday: 'long', day: 'numeric',
                month: 'long', year: 'numeric',
              })}
            </p>
          </div>
          <a href="/book" style={s.bookBtn}>+ New booking</a>
        </div>

        {showChecklist && (
          <div style={s.checklistCard}>
            <div style={s.checklistHeader}>
              <h2 style={s.checklistTitle}>Finish setting up TravelDesk</h2>
              <p style={s.checklistSub}>Complete these steps before your team starts booking.</p>
            </div>
            <div style={s.progressTrack}>
              <div style={{ ...s.progressFill, width: `${(completedCount / checklist.length) * 100}%` }} />
            </div>
            <div style={s.checklistItems}>
              {checklist.map(item => (
                <div key={item.id} style={{ ...s.checklistItem, opacity: item.done ? 0.5 : 1 }}>
                  <div style={{
                    ...s.checkDot,
                    background: item.done ? '#22C55E' : '#fff',
                    borderColor: item.done ? '#22C55E' : '#D1D5DB',
                  }}>
                    {item.done && <span style={s.checkMark}>✓</span>}
                  </div>
                  <div style={s.checkContent}>
                    <p style={{
                      ...s.checkLabel,
                      textDecoration: item.done ? 'line-through' : 'none',
                      color: item.done ? '#9CA3AF' : '#111827',
                    }}>{item.label}</p>
                    {!item.done && <p style={s.checkDesc}>{item.desc}</p>}
                  </div>
                  {!item.done && (
                    <a href={item.href} style={s.checkCta}>{item.cta} →</a>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {role === 'employee' && (
          <div style={s.infoBanner}>
            <span style={s.infoBannerText}>
              Your travel entitlements are set by your company policy for band{' '}
              <strong>{band_code ?? '—'}</strong>.
              Out-of-policy bookings will be routed to your manager for approval.
            </span>
          </div>
        )}

        {role === 'manager' && (
          <div style={s.infoBanner}>
            <span style={s.infoBannerText}>
              You can approve in-band booking requests from your direct reports.
              High-value requests are routed to Finance automatically.
            </span>
          </div>
        )}

        <div style={{ ...s.statsRow, gridTemplateColumns: `repeat(${stats.length}, 1fr)` }}>
          {stats.map(stat => (
            <div key={stat.label} style={s.statCard}>
              <p style={s.statLabel}>{stat.label}</p>
              <p style={s.statValue}>{stat.value}</p>
              <p style={s.statSub}>{stat.sub}</p>
            </div>
          ))}
        </div>

        <Section title="Recent bookings" linkLabel="View all" linkHref="/bookings">
          <EmptyState
            icon="✈"
            title="No bookings yet"
            desc={
              role === 'employee'
                ? 'Start a trip request and your manager will be notified for approval.'
                : 'When your team starts booking, their trips will appear here.'
            }
            cta="Make your first booking →"
            ctaHref="/book"
          />
        </Section>

        {(role === 'admin' || role === 'manager' || role === 'finance') && (
          <Section title="Pending approvals" linkLabel="View all" linkHref="/approvals">
            <EmptyState
              icon="✔"
              title="No pending approvals"
              desc="Out-of-policy booking requests will show up here for you to action."
            />
          </Section>
        )}
      </main>
    </div>
  )
}

function Section({ title, linkLabel, linkHref, children }: {
  title: string
  linkLabel: string
  linkHref: string
  children: React.ReactNode
}) {
  return (
    <div style={s.section}>
      <div style={s.sectionHeader}>
        <h2 style={s.sectionTitle}>{title}</h2>
        <a href={linkHref} style={s.sectionLink}>{linkLabel}</a>
      </div>
      {children}
    </div>
  )
}

function EmptyState({ icon, title, desc, cta, ctaHref }: {
  icon: string
  title: string
  desc: string
  cta?: string
  ctaHref?: string
}) {
  return (
    <div style={s.emptyState}>
      <div style={s.emptyIcon}>{icon}</div>
      <p style={s.emptyTitle}>{title}</p>
      <p style={s.emptyDesc}>{desc}</p>
      {cta && ctaHref && <a href={ctaHref} style={s.emptyCta}>{cta}</a>}
    </div>
  )
}

function LoadingScreen() {
  return (
    <div style={{
      minHeight: '100vh', display: 'flex',
      alignItems: 'center', justifyContent: 'center',
      background: '#F7F8FC', fontFamily: "'Inter', sans-serif",
    }}>
      <p style={{ fontSize: '13px', color: '#9CA3AF' }}>Loading…</p>
    </div>
  )
}

function getGreeting() {
  const h = new Date().getHours()
  if (h < 12) return 'Good morning'
  if (h < 17) return 'Good afternoon'
  return 'Good evening'
}

const s: Record<string, React.CSSProperties> = {
  root: {
    display: 'flex', minHeight: '100vh',
    fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
    background: '#F7F8FC',
  },
  nav: {
    width: '220px', flexShrink: 0, background: '#000835',
    display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
    padding: '28px 16px',
  },
  navWordmark: { display: 'flex', flexDirection: 'column', gap: '2px', marginBottom: '20px', padding: '0 6px' },
  navWmMain: { fontSize: '17px', fontWeight: 600, color: '#fff', letterSpacing: '-0.3px' },
  navWmBy: { fontSize: '9px', color: 'rgba(255,255,255,0.32)', letterSpacing: '0.5px', textTransform: 'uppercase' as const },
  companyBadge: {
    display: 'flex', alignItems: 'center', gap: '7px',
    padding: '7px 10px', marginBottom: '20px',
    background: 'rgba(255,255,255,0.06)', borderRadius: '6px',
  },
  companyDot: { width: '6px', height: '6px', borderRadius: '50%', background: '#22C55E', flexShrink: 0 },
  companyName: { fontSize: '12px', color: 'rgba(255,255,255,0.7)', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const },
  navItems: { display: 'flex', flexDirection: 'column', gap: '1px' },
  navItem: { display: 'block', padding: '8px 10px', borderRadius: '6px', fontSize: '13px', textDecoration: 'none', transition: 'all 0.15s' },
  navFooter: { borderTop: '1px solid rgba(255,255,255,0.07)', paddingTop: '14px' },
  userInfo: { display: 'flex', alignItems: 'center', gap: '9px', marginBottom: '10px' },
  userAvatar: {
    width: '30px', height: '30px', borderRadius: '50%',
    background: 'rgba(255,255,255,0.12)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontSize: '12px', fontWeight: 600, color: '#fff', flexShrink: 0,
  },
  userName: { fontSize: '12px', fontWeight: 500, color: '#fff', margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const },
  userMeta: { fontSize: '10px', color: 'rgba(255,255,255,0.38)', margin: 0 },
  signOutBtn: { width: '100%', height: '30px', background: 'rgba(255,255,255,0.05)', color: 'rgba(255,255,255,0.4)', fontSize: '11px', border: 'none', borderRadius: '5px', cursor: 'pointer' },
  main: { flex: 1, overflowY: 'auto' as const, padding: '32px 36px' },
  topBar: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '24px' },
  pageTitle: { fontSize: '20px', fontWeight: 600, color: '#0A0A14', margin: '0 0 3px', letterSpacing: '-0.3px' },
  pageDate: { fontSize: '12px', color: '#9CA3AF', margin: 0 },
  bookBtn: { display: 'inline-block', height: '34px', lineHeight: '34px', padding: '0 14px', background: '#000835', color: '#fff', fontSize: '12px', fontWeight: 600, borderRadius: '7px', textDecoration: 'none', flexShrink: 0 },
  checklistCard: { background: '#fff', border: '1px solid #E5E7EB', borderRadius: '10px', padding: '20px', marginBottom: '20px' },
  checklistHeader: { marginBottom: '12px' },
  checklistTitle: { fontSize: '14px', fontWeight: 600, color: '#111827', margin: '0 0 3px' },
  checklistSub: { fontSize: '12px', color: '#6B7280', margin: 0 },
  progressTrack: { height: '3px', background: '#F3F4F6', borderRadius: '2px', marginBottom: '16px', overflow: 'hidden' },
  progressFill: { height: '100%', background: '#22C55E', borderRadius: '2px' },
  checklistItems: { display: 'flex', flexDirection: 'column', gap: '10px' },
  checklistItem: { display: 'flex', alignItems: 'flex-start', gap: '10px' },
  checkDot: { width: '18px', height: '18px', borderRadius: '50%', border: '2px solid', flexShrink: 0, marginTop: '1px', display: 'flex', alignItems: 'center', justifyContent: 'center' },
  checkMark: { fontSize: '10px', color: '#fff', fontWeight: 700 },
  checkContent: { flex: 1 },
  checkLabel: { fontSize: '12px', fontWeight: 500, margin: '0 0 1px' },
  checkDesc: { fontSize: '11px', color: '#6B7280', margin: 0 },
  checkCta: { fontSize: '11px', fontWeight: 600, color: '#000835', textDecoration: 'none', flexShrink: 0, marginTop: '1px' },
  infoBanner: { background: '#EEF2FF', border: '1px solid #C7D2FE', borderRadius: '8px', padding: '11px 14px', marginBottom: '20px' },
  infoBannerText: { fontSize: '12px', color: '#3730A3', lineHeight: '1.55' },
  statsRow: { display: 'grid', gap: '14px', marginBottom: '20px' },
  statCard: { background: '#fff', border: '1px solid #E5E7EB', borderRadius: '9px', padding: '16px 18px' },
  statLabel: { fontSize: '10px', fontWeight: 600, color: '#9CA3AF', margin: '0 0 6px', textTransform: 'uppercase' as const, letterSpacing: '0.4px' },
  statValue: { fontSize: '24px', fontWeight: 700, color: '#111827', margin: '0 0 3px' },
  statSub: { fontSize: '10px', color: '#9CA3AF', margin: 0 },
  section: { background: '#fff', border: '1px solid #E5E7EB', borderRadius: '9px', padding: '18px', marginBottom: '16px' },
  sectionHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px' },
  sectionTitle: { fontSize: '13px', fontWeight: 600, color: '#111827', margin: 0 },
  sectionLink: { fontSize: '11px', color: '#000835', textDecoration: 'none', fontWeight: 500 },
  emptyState: { display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '24px 0', textAlign: 'center' as const },
  emptyIcon: { fontSize: '22px', width: '48px', height: '48px', borderRadius: '50%', background: '#F9FAFB', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: '10px' },
  emptyTitle: { fontSize: '13px', fontWeight: 600, color: '#374151', margin: '0 0 4px' },
  emptyDesc: { fontSize: '12px', color: '#9CA3AF', maxWidth: '300px', margin: '0 0 12px', lineHeight: '1.5' },
  emptyCta: { fontSize: '12px', fontWeight: 600, color: '#000835', textDecoration: 'none' },
}