'use client'

import { useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import Link from 'next/link'
import { canAccess } from '@/app/lib/permissions/canAccess'
import { PRIMARY_NAV, isActive } from '@/app/lib/navigation/tmcNav'

// ── TmcShell ─────────────────────────────────────────────────────────────────
// The persistent frame for every /tmc route. Rendered once from
// app/tmc/layout.tsx rather than opted into per page, which is what stops the
// rail disappearing when you navigate into Configurations — previously those
// pages skipped the shell entirely because the settings layout supplied its own
// sidebar, so entering settings dropped you out of the product.
//
// Active state comes from usePathname() rather than an `activeLabel` prop. The
// prop was a typed union that had to be widened for every new section and
// passed correctly by every page; deriving it removes both obligations.
// ─────────────────────────────────────────────────────────────────────────────

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

export default function TmcShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? ''

  const [employee, setEmployee] = useState<Employee | null>(null)
  const [permissions, setPermissions] = useState<string[]>([])
  const [clients, setClients] = useState<Client[]>([])

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

  useEffect(() => {
    let cancelled = false

    fetch('/api/tmc/companies')
      .then(r => r.json())
      .then(d => { if (!cancelled && d.ok) setClients(d.companies) })
      .catch(() => {})

    return () => { cancelled = true }
  }, [])

  const visibleNav = PRIMARY_NAV.filter(
    item => !item.permission || canAccess(employee?.role, permissions, item.permission)
  )

  return (
    <div className="flex min-h-screen bg-canvas">
      {/* ── Primary rail ─────────────────────────────────────────────── */}
      <aside className="fixed inset-y-0 left-0 z-30 flex w-rail flex-col bg-rail">
        <div className="px-5 pt-6 pb-5">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-md bg-white/95 text-[13px] font-bold text-rail">
              TD
            </div>
            <div className="leading-tight">
              <div className="text-[15px] font-semibold text-white">TravelDesk</div>
              <div className="text-[10px] uppercase tracking-[0.08em] text-white/40">
                by Amadeus
              </div>
            </div>
          </div>

          {employee && (
            <span className="mt-4 inline-block rounded bg-white/10 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-white/85">
              {employee.role === 'tmc_admin' ? 'TMC Admin' : 'Travel Counsellor'}
            </span>
          )}
        </div>

        <nav className="px-3">
          {visibleNav.map(item => {
            const active = isActive(pathname, item.href)
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={[
                  'mb-0.5 flex items-center gap-3 rounded-lg px-3 py-2.5 text-[13px] transition-colors',
                  active
                    ? 'bg-white/10 font-semibold text-white'
                    : 'text-white/55 hover:bg-white/5 hover:text-white',
                ].join(' ')}
              >
                <NavIcon name={item.icon} active={active} />
                {item.label}
              </Link>
            )
          })}
        </nav>

        {/* Client quick-list — jump straight to whoever just called, without
            going via a listing page. Scrolls rather than growing the rail. */}
        {clients.length > 0 && (
          <div className="mt-5 flex min-h-0 flex-1 flex-col border-t border-white/[0.08] px-3 pt-4">
            <p className="px-3 pb-2 text-[10px] font-semibold uppercase tracking-wider text-white/35">
              Clients
            </p>
            <div className="min-h-0 flex-1 overflow-y-auto pb-2">
              {clients.map(c => {
                const active = pathname === `/tmc/companies/${c.id}`
                return (
                  <Link
                    key={c.id}
                    href={`/tmc/companies/${c.id}`}
                    title={c.name}
                    className={[
                      'flex items-center gap-2 rounded-md px-3 py-1.5 text-[12px] transition-colors',
                      active
                        ? 'bg-white/10 text-white'
                        : 'text-white/45 hover:bg-white/5 hover:text-white/80',
                    ].join(' ')}
                  >
                    <span className="flex-1 truncate">{c.name}</span>
                    <span className="shrink-0 rounded bg-white/[0.07] px-1.5 py-px text-[10px] font-semibold text-white/40">
                      {c.employeeCount ?? 0}
                    </span>
                  </Link>
                )
              })}
            </div>
          </div>
        )}

        <div className={`${clients.length > 0 ? '' : 'mt-auto'} border-t border-white/[0.08] px-3 py-3`}>
          <Link
            href="/profile"
            className="flex items-center gap-3 rounded-lg px-3 py-2 text-[13px] text-white/55 transition-colors hover:bg-white/5 hover:text-white"
          >
            <NavIcon name="person" />
            <span className="truncate">{employee?.full_name ?? 'Profile'}</span>
          </Link>
          {/* POST then hard redirect, not a form action: the route clears the
              Supabase session cookie server-side and returns JSON, and a full
              location change guarantees every client-side cache of the old
              session is dropped. */}
          <button
            type="button"
            onClick={async () => {
              await fetch('/api/auth/signout', { method: 'POST' })
              window.location.href = '/login'
            }}
            className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-[13px] text-white/55 transition-colors hover:bg-white/5 hover:text-white"
          >
            <NavIcon name="logout" />
            Sign out
          </button>
        </div>
      </aside>

      {/* Spacer holds the layout open; the rail itself is fixed so it doesn't
          scroll with content. */}
      <div className="w-rail shrink-0" aria-hidden />

      {/* Content renders immediately and independently of /api/me — the shell
          never gates the page on its own chrome loading. */}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}

// ── NavIcon ──────────────────────────────────────────────────────────────────
// Inline SVG rather than an icon font or package: five icons don't justify a
// dependency, and a webfont would add a network round trip before the nav can
// paint — the exact thing this pass is trying to remove.
// ─────────────────────────────────────────────────────────────────────────────

function NavIcon({ name, active }: { name?: string; active?: boolean }) {
  const cls = `h-[18px] w-[18px] shrink-0 ${active ? 'opacity-100' : 'opacity-70'}`
  const common = {
    className: cls,
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
