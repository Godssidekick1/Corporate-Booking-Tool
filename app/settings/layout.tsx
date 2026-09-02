'use client'

import { usePathname } from 'next/navigation'

const SECTIONS = [
  { label: 'Company',     href: '/settings/company' },
  { label: 'Users',        href: '/settings/users' },
  { label: 'Policy',       href: '/settings/policy' },
  { label: 'Hierarchy',    href: '/settings/hierarchy' },
  { label: 'Approvals',    href: '/settings/approvals' },
  { label: 'Integrations', href: '/settings/integrations' },
]

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()

  return (
    <div style={s.root}>
      <aside style={s.sidebar}>
        <div style={s.sidebarHeader}>
          <a href="/dashboard" style={s.backLink}>← Dashboard</a>
          <h2 style={s.sidebarTitle}>Settings</h2>
        </div>
        <nav style={s.nav}>
          {SECTIONS.map(section => {
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