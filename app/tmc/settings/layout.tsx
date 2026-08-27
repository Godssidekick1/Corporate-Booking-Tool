'use client'

import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'
import { canAccess } from '@/app/lib/permissions/canAccess'

const SECTIONS = [
  { label: 'Client groups',     href: '/tmc/settings/client-groups',     permission: 'manage_client_groups' },
  { label: 'Users',        href: '/tmc/settings/users',        permission: 'manage_users' },
  { label: 'Policy',       href: '/tmc/settings/policy',       permission: 'manage_policy' },
  { label: 'Rule Engine test', href: '/tmc/settings/rule-engine-test', permission: 'manage_policy' },
  { label: 'Approvals',    href: '/tmc/settings/approvals',    permission: 'manage_approvals' },
  // Gated on manage_users rather than manage_approvals: it edits employee
  // records. It sits next to Approvals because that is what it feeds — a
  // 'manager' approval step resolves through manager_id.
  { label: 'Hierarchy',    href: '/tmc/settings/hierarchy',    permission: 'manage_users' },
  { label: 'Integrations', href: '/tmc/settings/integrations', permission: null }, // placeholder page, no gate yet
]

export default function TmcSettingsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const [role, setRole] = useState<string>()
  const [permissions, setPermissions] = useState<string[]>([])
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    fetch('/api/me')
      .then(r => r.json())
      .then(data => {
        if (data.ok) {
          setRole(data.employee?.role)
          setPermissions(data.permissions ?? [])
        }
      })
      .finally(() => setLoaded(true))
  }, [])

  const visibleSections = SECTIONS.filter(s => !s.permission || canAccess(role, permissions, s.permission))

  return (
    <div style={s.root}>
      <aside style={s.sidebar}>
        <div style={s.sidebarHeader}>
          <a href="/tmc/dashboard" style={s.backLink}>← Dashboard</a>
          <h2 style={s.sidebarTitle}>Settings</h2>
        </div>
        <nav style={s.nav}>
          {loaded && visibleSections.map(section => {
            const active = pathname === section.href || pathname?.startsWith(section.href + '/')
            return (
              <a
                key={section.href}
                href={section.href}
                style={{
                  ...s.navItem,
                  background: active ? '#EEF2FF' : 'transparent',
                  color: active ? '#000835' : '#6B7280',
                  fontWeight: active ? 600 : 400,
                }}
              >
                {section.label}
              </a>
            )
          })}
        </nav>
      </aside>

      <main style={s.main}>{children}</main>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  root: {
    display: 'flex', minHeight: '100vh',
    fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
    background: '#F7F8FC',
  },
  sidebar: {
    width: '220px', flexShrink: 0, background: '#fff',
    borderRight: '1px solid #E5E7EB', padding: '28px 16px',
  },
  sidebarHeader: { marginBottom: '20px', padding: '0 6px' },
  backLink: { fontSize: '12px', color: '#9CA3AF', textDecoration: 'none', display: 'block', marginBottom: '10px' },
  sidebarTitle: { fontSize: '16px', fontWeight: 600, color: '#0A0A14', margin: 0 },
  nav: { display: 'flex', flexDirection: 'column', gap: '2px' },
  navItem: { display: 'block', padding: '8px 10px', borderRadius: '6px', fontSize: '13px', textDecoration: 'none' },
  main: { flex: 1, padding: '32px 40px', overflowY: 'auto' as const },
}