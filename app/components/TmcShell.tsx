'use client'

import { useEffect, useState } from 'react'
import { canAccess } from '@/app/lib/permissions/canAccess'

interface Employee {
  full_name: string
  email: string
  role: string
  tmc_id: string
}

interface Client {
  id: string
  name: string
  employeeCount: number
}

interface TmcShellProps {
  children: React.ReactNode
  activeLabel: 'Dashboard' | 'Clients' | 'Client groups' | 'Settings' | 'Reports'
  // Set when a specific client is open, so its row highlights in the list.
  activeClientId?: string
}

export default function TmcShell({ children, activeLabel, activeClientId }: TmcShellProps) {
  const [employee, setEmployee] = useState<Employee | null>(null)
  const [permissions, setPermissions] = useState<string[]>([])
  const [clients, setClients] = useState<Client[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/me')
      .then(r => r.json())
      .then(data => {
        if (data.ok) {
          setEmployee(data.employee)
          setPermissions(data.permissions ?? [])
        }
      })
      .finally(() => setLoading(false))
  }, [])

  // Clients live in the main nav rather than under Settings: they are what a
  // travel desk works in all day, not something configured once. Settings keeps
  // the things you set up and leave alone — policy, approvals, integrations.
  useEffect(() => {
    fetch('/api/tmc/companies')
      .then(r => r.json())
      .then(d => { if (d.ok) setClients(d.companies) })
      .catch(() => {})
  }, [])

  const navItems = [
    { label: 'Dashboard',     href: '/tmc/dashboard',              show: true },
    { label: 'Clients',       href: '/tmc/companies',              show: true },
    { label: 'Client groups', href: '/tmc/settings/client-groups', show: canAccess(employee?.role, permissions, 'manage_client_groups') },
    { label: 'Settings',      href: '/tmc/settings',               show: employee?.role === 'tmc_admin' || permissions.length > 0 },
    { label: 'Reports',       href: '/tmc/reports',                show: canAccess(employee?.role, permissions, 'view_reports') },
  ].filter(item => item.show)

  return (
    <div style={s.root}>
      <nav style={s.nav}>
        <div>
          <div style={s.wordmark}>
            <span style={s.wmMain}>TravelDesk</span>
            <span style={s.wmBy}>by Amadeus</span>
          </div>
          <p style={s.navLabel}>{employee?.role === 'tmc_admin' ? 'TMC Admin' : 'Travel Counsellor'}</p>
          {navItems.map(item => (
            <a key={item.label} href={item.href} style={{
              ...s.navItem,
              backgroundColor: item.label === activeLabel ? 'rgba(255,255,255,0.1)' : 'transparent',
              color: item.label === activeLabel ? '#fff' : 'rgba(255,255,255,0.5)',
              fontWeight: item.label === activeLabel ? 600 : 400,
            }}>
              {item.label}
            </a>
          ))}

          {/* The client list itself, so a desk can jump straight to whoever
              called without going via a listing page first. Scrolls rather than
              growing the nav, and headcount is the one number worth seeing at a
              glance when choosing. */}
          {clients.length > 0 && (
            <div style={s.clientBlock}>
              <p style={s.navLabel}>Clients</p>
              <div style={s.clientList}>
                {clients.map(c => (
                  <a
                    key={c.id}
                    href={`/tmc/companies/${c.id}`}
                    style={{
                      ...s.clientItem,
                      backgroundColor: c.id === activeClientId ? 'rgba(255,255,255,0.1)' : 'transparent',
                      color: c.id === activeClientId ? '#fff' : 'rgba(255,255,255,0.45)',
                    }}
                    title={c.name}
                  >
                    <span style={s.clientName}>{c.name}</span>
                    <span style={s.clientCount}>{c.employeeCount ?? 0}</span>
                  </a>
                ))}
              </div>
            </div>
          )}
        </div>
        <div style={s.navFooter}>
          <p style={s.userName}>{loading ? '…' : employee?.full_name ?? '—'}</p>
          <p style={s.userRole}>{employee?.role === 'tmc_admin' ? 'TMC Admin' : 'Travel Counsellor'}</p>
          <button
            onClick={async () => {
              await fetch('/api/auth/signout', { method: 'POST' })
              window.location.href = '/login'
            }}
            style={{ ...s.signOutBtn, marginTop: '10px' }}
          >
            Sign out
          </button>
        </div>
      </nav>

      <main style={s.main}>{children}</main>
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
  clientBlock: { marginTop: '22px', borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: '14px' },
  // Capped so a TMC with fifty clients scrolls this list instead of the page.
  clientList: { display: 'flex', flexDirection: 'column', gap: '1px', maxHeight: '260px', overflowY: 'auto' },
  clientItem: { display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 10px', borderRadius: '6px', fontSize: '12px', textDecoration: 'none' },
  clientName: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  clientCount: { fontSize: '10px', fontWeight: 600, color: 'rgba(255,255,255,0.35)', background: 'rgba(255,255,255,0.07)', borderRadius: '4px', padding: '1px 6px', flexShrink: 0 },
  navFooter: { borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: '16px' },
  userName: { fontSize: '12px', fontWeight: 600, color: '#fff', margin: '0 0 2px' },
  userRole: { fontSize: '11px', color: 'rgba(255,255,255,0.4)', margin: 0 },
  signOutBtn: { width: '100%', height: '32px', backgroundColor: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.45)', fontSize: '12px', border: 'none', borderRadius: '6px', cursor: 'pointer' },
  main: { flex: 1, overflowY: 'auto' as const },
}