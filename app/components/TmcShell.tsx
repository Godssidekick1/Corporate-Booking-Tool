'use client'

import { useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import Link from 'next/link'
import { canAccess } from '@/app/lib/permissions/canAccess'
import { PRIMARY_NAV, isActive } from '@/app/lib/navigation/tmcNav'

// ── TmcShell ─────────────────────────────────────────────────────────────────
// The persistent frame for every /tmc route. Rendered once from
// app/tmc/layout.tsx rather than opted into per page, which is what stops the
// rail disappearing when you navigate into Configurations.
//
// Active state comes from usePathname() rather than an `activeLabel` prop. The
// prop was a typed union that had to be widened for every new section and
// passed correctly by every page; deriving it removes both obligations.
//
// The rail collapses to icons. It no longer carries a client quick-list — that
// duplicated the Clients nav item, and a scrolling list of names is the one
// thing that cannot collapse to 64px sensibly.
// ─────────────────────────────────────────────────────────────────────────────

interface Employee {
  full_name: string
  email: string
  role: string
  tmc_id: string
}

const COLLAPSE_KEY = 'tmc.rail.collapsed'

export default function TmcShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? ''

  const [employee, setEmployee] = useState<Employee | null>(null)
  const [permissions, setPermissions] = useState<string[]>([])
  const [collapsed, setCollapsed] = useState(false)

  useEffect(() => {
    let cancelled = false

    fetch('/api/me')
      .then(r => r.json())
      .then(d => {
        if (cancelled || !d.ok) return
        setEmployee(d.employee)
        setPermissions(d.permissions ?? [])
      })

    return () => { cancelled = true }
  }, [])

  // Read after mount, not in a useState initializer: localStorage doesn't exist
  // during server render, so initializing from it would either crash on the
  // server or hydrate to a different value than the HTML.
  useEffect(() => {
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setCollapsed(localStorage.getItem(COLLAPSE_KEY) === '1')
    } catch {
      // Throws outright in some privacy modes rather than returning null.
    }
  }, [])

  function toggleCollapsed() {
    setCollapsed(prev => {
      const next = !prev
      try { localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0') } catch { /* non-fatal */ }
      return next
    })
  }

  const visibleNav = PRIMARY_NAV.filter(
    item => !item.permission || canAccess(employee?.role, permissions, item.permission)
  )

  const railWidth = collapsed ? 'w-rail-collapsed' : 'w-rail'

  return (
    <div className="flex min-h-screen bg-canvas">
      <aside
        className={`fixed inset-y-0 left-0 z-30 flex flex-col bg-rail transition-[width] duration-200 ${railWidth}`}
      >
        {/* Brand */}
        <div className={`pt-6 pb-5 ${collapsed ? 'px-3' : 'px-5'}`}>
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-white/95 text-[13px] font-bold text-rail">
              TD
            </div>
            {!collapsed && (
              <div className="min-w-0 leading-tight">
                <div className="truncate text-[15px] font-semibold text-white">TravelDesk</div>
                <div className="text-[10px] uppercase tracking-[0.08em] text-white/40">
                  by Amadeus
                </div>
              </div>
            )}
          </div>

          {!collapsed && employee && (
            <span className="mt-4 inline-block rounded bg-white/10 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-white/85">
              {employee.role === 'tmc_admin' ? 'TMC Admin' : 'Travel Counsellor'}
            </span>
          )}
        </div>

        <nav className={collapsed ? 'px-2' : 'px-3'}>
          {visibleNav.map(item => {
            const active = isActive(pathname, item.href)
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? 'page' : undefined}
                // Collapsed items are icon-only, so the native tooltip is the
                // only thing naming them.
                title={collapsed ? item.label : undefined}
                className={[
                  'mb-0.5 flex items-center gap-3 rounded-lg py-2.5 text-[13px] transition-colors',
                  collapsed ? 'justify-center px-0' : 'px-3',
                  active
                    ? 'bg-white/10 font-semibold text-white'
                    : 'text-white/55 hover:bg-white/5 hover:text-white',
                ].join(' ')}
              >
                <NavIcon name={item.icon} active={active} />
                {!collapsed && item.label}
              </Link>
            )
          })}
        </nav>

        <div className={`mt-auto border-t border-white/[0.08] py-3 ${collapsed ? 'px-2' : 'px-3'}`}>
          <button
            type="button"
            onClick={toggleCollapsed}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            className={[
              'mb-0.5 flex w-full items-center gap-3 rounded-lg py-2 text-[13px] text-white/45 transition-colors hover:bg-white/5 hover:text-white',
              collapsed ? 'justify-center px-0' : 'px-3',
            ].join(' ')}
          >
            <svg
              className="h-[18px] w-[18px] shrink-0 transition-transform duration-200"
              style={{ transform: collapsed ? 'rotate(180deg)' : 'none' }}
              viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"
            >
              <path d="M15 18l-6-6 6-6" />
            </svg>
            {!collapsed && 'Collapse'}
          </button>

          {/* /tmc/profile, not /profile. The latter is the traveller profile —
              passport, meal preference — which no TMC or TC user should ever be
              asked for. */}
          <Link
            href="/tmc/profile"
            title={collapsed ? (employee?.full_name ?? 'Profile') : undefined}
            className={[
              'flex items-center gap-3 rounded-lg py-2 text-[13px] transition-colors',
              collapsed ? 'justify-center px-0' : 'px-3',
              isActive(pathname, '/tmc/profile')
                ? 'bg-white/10 font-semibold text-white'
                : 'text-white/55 hover:bg-white/5 hover:text-white',
            ].join(' ')}
          >
            <NavIcon name="person" active={isActive(pathname, '/tmc/profile')} />
            {!collapsed && <span className="truncate">{employee?.full_name ?? 'Profile'}</span>}
          </Link>

          {/* POST then hard redirect: the route clears the Supabase session
              cookie server-side and returns JSON, and a full location change
              guarantees no client-side cache of the old session survives. */}
          <button
            type="button"
            onClick={async () => {
              await fetch('/api/auth/signout', { method: 'POST' })
              window.location.href = '/login'
            }}
            title={collapsed ? 'Sign out' : undefined}
            className={[
              'flex w-full items-center gap-3 rounded-lg py-2 text-left text-[13px] text-white/55 transition-colors hover:bg-white/5 hover:text-white',
              collapsed ? 'justify-center px-0' : 'px-3',
            ].join(' ')}
          >
            <NavIcon name="logout" />
            {!collapsed && 'Sign out'}
          </button>
        </div>
      </aside>

      {/* Spacer holds the layout open; the rail itself is fixed so it doesn't
          scroll with content. Transitions in step with the rail. */}
      <div className={`shrink-0 transition-[width] duration-200 ${railWidth}`} aria-hidden />

      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}

// ── NavIcon ──────────────────────────────────────────────────────────────────
// Inline SVG rather than an icon font or package: a handful of icons doesn't
// justify a dependency, and a webfont would add a network round trip before the
// nav can paint — the exact thing this work is trying to remove.
// ─────────────────────────────────────────────────────────────────────────────

function NavIcon({ name, active }: { name?: string; active?: boolean }) {
  const common = {
    className: `h-[18px] w-[18px] shrink-0 ${active ? 'opacity-100' : 'opacity-70'}`,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.7,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  }

  switch (name) {
    case 'dashboard':
      return (
        <svg {...common}>
          <rect x="3" y="3" width="7" height="9" rx="1" />
          <rect x="14" y="3" width="7" height="5" rx="1" />
          <rect x="14" y="12" width="7" height="9" rx="1" />
          <rect x="3" y="16" width="7" height="5" rx="1" />
        </svg>
      )
    case 'groups':
      return (
        <svg {...common}>
          <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
        </svg>
      )
    case 'assessment':
      return (
        <svg {...common}>
          <path d="M3 3v18h18" />
          <path d="M7 15l4-5 3 3 5-7" />
        </svg>
      )
    case 'settings':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      )
    case 'person':
      return (
        <svg {...common}>
          <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
          <circle cx="12" cy="7" r="4" />
        </svg>
      )
    case 'logout':
      return (
        <svg {...common}>
          <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
          <path d="M16 17l5-5-5-5M21 12H9" />
        </svg>
      )
    default:
      return <span className="h-[18px] w-[18px] shrink-0" />
  }
}
