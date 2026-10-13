'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { isActive } from '@/app/lib/navigation/tmcNav'

// ── /settings layout ─────────────────────────────────────────────────────────
// The company's settings, as a second column beside the rail -- the same
// pattern as the TMC side's Configurations (app/tmc/configurations/layout.tsx).
// It used to be a sidebar of its own with a "← Dashboard" link, because no
// corporate page had a rail to return by; the shared one (CorporateShell) is
// that way back now.
// ─────────────────────────────────────────────────────────────────────────────

const SECTIONS = [
  { label: 'Company',      href: '/settings/company' },
  { label: 'Users',        href: '/settings/users' },
  { label: 'Policy',       href: '/settings/policy' },
  { label: 'Hierarchy',    href: '/settings/hierarchy' },
  { label: 'Approvals',    href: '/settings/approvals' },
  { label: 'Integrations', href: '/settings/integrations' },
]

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? ''

  return (
    <div className="flex min-h-screen">
      <nav className="w-subnav shrink-0 border-r border-line bg-surface">
        <div className="px-5 py-6">
          <h2 className="text-[15px] font-semibold text-ink">Settings</h2>
        </div>
        <div className="pb-8">
          {SECTIONS.map(section => {
            const active = isActive(pathname, section.href)
            return (
              <Link
                key={section.href}
                href={section.href}
                aria-current={active ? 'page' : undefined}
                className={[
                  'flex items-center border-l-2 py-2 pl-[18px] pr-4 text-[13px] transition-colors',
                  active ? 'border-rail bg-info-bg/60 font-semibold text-rail' : 'border-transparent text-body hover:bg-canvas',
                ].join(' ')}
              >
                {section.label}
              </Link>
            )
          })}
        </div>
      </nav>

      {/* Padding and width: the shared .page-frame (globals.css), as on every page. */}
      <div className="page-frame min-w-0 flex-1">{children}</div>
    </div>
  )
}
