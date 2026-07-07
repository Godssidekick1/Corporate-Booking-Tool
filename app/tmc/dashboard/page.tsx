'use client'

import { useEffect, useState } from 'react'

interface Employee {
  full_name: string
  email: string
  role: string
  tmc_id: string
}

export default function TmcDashboardPage() {
  const [employee, setEmployee] = useState<Employee | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/me')
      .then(r => r.json())
      .then(data => { if (data.ok) setEmployee(data.employee) })
      .finally(() => setLoading(false))
  }, [])

  const firstName = employee?.full_name?.split(' ')[0] ?? '…'

  return (
    <div style={s.root}>
      <nav style={s.nav}>
        <div>
          <div style={s.wordmark}>
            <span style={s.wmMain}>TravelDesk</span>
            <span style={s.wmBy}>by Amadeus</span>
          </div>
          <p style={s.navLabel}>TMC ADMIN</p>
          {[
            { label: 'Dashboard',  href: '/tmc/dashboard', active: true  },
            { label: 'Companies',  href: '/tmc/companies', active: false },
            { label: 'Policy',     href: '/tmc/policy',    active: false },
            { label: 'Reports',    href: '/tmc/reports',   active: false },
          ].map(item => (
            <a key={item.label} href={item.href} style={{
              ...s.navItem,
              backgroundColor: item.active ? 'rgba(255,255,255,0.1)' : 'transparent',
              color: item.active ? '#fff' : 'rgba(255,255,255,0.5)',
              fontWeight: item.active ? 600 : 400,
            }}>
              {item.label}
            </a>
          ))}
        </div>
        <div style={s.navFooter}>
          <p style={s.userName}>{loading ? '…' : employee?.full_name ?? '—'}</p>
          <p style={s.userRole}>TMC Admin</p>
          <form action="/api/auth/signout" method="POST" style={{ marginTop: '10px' }}>
            <button type="submit" style={s.signOutBtn}>Sign out</button>
          </form>
        </div>
      </nav>

      <main style={s.main}>
        <h1 style={s.heading}>Welcome, {firstName}</h1>
        <p style={s.sub}>Your TMC admin portal is ready. Features coming soon.</p>

        <div style={s.cards}>
          {[
            { title: 'Companies',        desc: 'Onboard and manage your corporate clients.',      href: '/tmc/companies', cta: 'View companies'  },
            { title: 'Master policy',    desc: 'Set locked band limits that all clients inherit.', href: '/tmc/policy',    cta: 'Configure policy' },
            { title: 'Reports',          desc: 'Cross-company spend and compliance reporting.',    href: '/tmc/reports',   cta: 'View reports'    },
          ].map(card => (
            <div key={card.title} style={s.card}>
              <h2 style={s.cardTitle}>{card.title}</h2>
              <p style={s.cardDesc}>{card.desc}</p>
              <a href={card.href} style={s.cardCta}>{card.cta} →</a>
            </div>
          ))}
        </div>
      </main>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  root: { display: 'flex', minHeight: '100vh', fontFamily: "'Inter', -apple-system, sans-serif", backgroundColor: '#F7F8FC' },
  nav: { width: '220px', flexShrink: 0, backgroundColor: '#000835', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', padding: '32px 20px' },
  wordmark: { display: 'flex', flexDirection: 'column', gap: '3px', marginBottom: '28px' },
  wmMain: { fontSize: '18px', fontWeight: 700, color: '#fff', letterSpacing: '-0.4px' },
  wmBy: { fontSize: '10px', color: 'rgba(255,255,255,0.35)', letterSpacing: '0.5px', textTransform: 'uppercase' as const },
  navLabel: { fontSize: '9px', fontWeight: 600, color: 'rgba(255,255,255,0.28)', letterSpacing: '1.1px', textTransform: 'uppercase' as const, margin: '0 0 12px' },
  navItem: { display: 'block', padding: '9px 12px', borderRadius: '7px', fontSize: '13px', textDecoration: 'none', marginBottom: '2px' },
  navFooter: { borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: '16px' },
  userName: { fontSize: '12px', fontWeight: 600, color: '#fff', margin: '0 0 2px' },
  userRole: { fontSize: '11px', color: 'rgba(255,255,255,0.4)', margin: 0 },
  signOutBtn: { width: '100%', height: '32px', backgroundColor: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.45)', fontSize: '12px', border: 'none', borderRadius: '6px', cursor: 'pointer' },
  main: { flex: 1, padding: '48px 48px' },
  heading: { fontSize: '24px', fontWeight: 700, color: '#0A0A14', margin: '0 0 8px', letterSpacing: '-0.3px' },
  sub: { fontSize: '14px', color: '#6B7280', margin: '0 0 36px' },
  cards: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '16px' },
  card: { backgroundColor: '#fff', border: '1px solid #E5E7EB', borderRadius: '10px', padding: '24px' },
  cardTitle: { fontSize: '15px', fontWeight: 600, color: '#111827', margin: '0 0 8px' },
  cardDesc: { fontSize: '13px', color: '#6B7280', margin: '0 0 16px', lineHeight: '1.5' },
  cardCta: { fontSize: '13px', fontWeight: 600, color: '#000835', textDecoration: 'none' },
}