'use client'

import { useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import Link from 'next/link'
import { isActive } from '@/app/lib/navigation/tmcNav'
import { flowStorage } from '@/app/lib/book/flowStorage'

// ── AppShell ─────────────────────────────────────────────────────────────────
// The one frame around every signed-in page, TMC and corporate alike: a fixed
// navy rail that collapses to icons, the person's profile and Sign out pinned
// to its foot (never scrolled away), and the page beside it. Which entries the
// rail holds is the caller's business -- TmcShell and CorporateShell decide
// that from the person's role and permissions; this decides nothing about who
// sees what.
//
// The rail collapses by choice (remembered per browser) and on its own below
// 1024px, so a tablet or a phone keeps most of its width for the page.
//
// The page itself is framed by PageFrame (padding, width), not here: the
// Configurations and Settings layouts put a second column flush against the
// rail, which a padded frame would push away from it.
// ─────────────────────────────────────────────────────────────────────────────

export interface ShellItem {
  label: string
  href: string
  icon?: string
  // A count shown beside the label (pending approvals).
  badge?: number
}

const COLLAPSE_KEY = 'tmc.rail.collapsed'
const NARROW = '(max-width: 1023px)'

export default function AppShell({ items, tag, profile, children }: {
  items: ShellItem[]
  // Under the brand: the role, or the company.
  tag?: string | null
  profile: { href: string; name: string | null; sub?: string | null }
  children: React.ReactNode
}) {
  const pathname = usePathname() ?? ''
  const [chosen, setChosen] = useState(false)
  const [narrow, setNarrow] = useState(false)

  // Read after mount, not in a useState initializer: localStorage and the
  // viewport don't exist during server render, so initializing from them would
  // hydrate to a different value than the HTML.
  useEffect(() => {
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setChosen(localStorage.getItem(COLLAPSE_KEY) === '1')
    } catch {
      // Throws outright in some privacy modes rather than returning null.
    }
    const mq = window.matchMedia(NARROW)
    setNarrow(mq.matches)
    const onChange = (e: MediaQueryListEvent) => setNarrow(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  function toggleCollapsed() {
    setChosen(prev => {
      const next = !prev
      try { localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0') } catch { /* non-fatal */ }
      return next
    })
  }

  const collapsed = chosen || narrow
  const railWidth = collapsed ? 'w-rail-collapsed' : 'w-rail'
  const itemClass = (active: boolean) => [
    'flex items-center gap-3 rounded-lg text-[13px] transition-colors',
    collapsed ? 'justify-center px-0' : 'px-3',
    active ? 'bg-white/10 font-semibold text-white' : 'text-white/55 hover:bg-white/5 hover:text-white',
  ].join(' ')
  const profileActive = isActive(pathname, profile.href)

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
                <div className="text-[10px] uppercase tracking-[0.08em] text-white/40">by Amadeus</div>
              </div>
            )}
          </div>

          {!collapsed && tag && (
            <span className="mt-4 inline-block max-w-full truncate rounded bg-white/10 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-white/85">
              {tag}
            </span>
          )}
        </div>

        {/* Scrolls on its own when the entries outgrow a short screen, so the
            profile and Sign out below are never pushed off it. */}
        <nav className={`min-h-0 overflow-y-auto ${collapsed ? 'px-2' : 'px-3'}`}>
          {items.map(item => {
            const active = isActive(pathname, item.href)
            const badge = item.badge ?? 0
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? 'page' : undefined}
                // Collapsed items are icon-only, so the native tooltip is the
                // only thing naming them.
                title={collapsed ? item.label : undefined}
                className={`mb-0.5 py-2.5 ${itemClass(active)}`}
              >
                <span className="relative">
                  <NavIcon name={item.icon} active={active} />
                  {collapsed && badge > 0 && (
                    <span className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-white" aria-hidden />
                  )}
                </span>
                {!collapsed && <span className="min-w-0 flex-1 truncate">{item.label}</span>}
                {!collapsed && badge > 0 && (
                  <span className="rounded-full bg-white px-1.5 text-[10px] font-bold text-rail">{badge}</span>
                )}
              </Link>
            )
          })}
        </nav>

        {/* Collapse toggle -- a chevron straddling the rail's right edge, just
            below the last entry: it acts on the rail's WIDTH, so it lives on
            the edge it moves. Hidden when the screen is too narrow to expand.
            The rail is z-30 and a second column (Configurations, Settings) is
            in normal flow, so the button paints above the seam. */}
        {!narrow && (
          <div className="relative mt-4 h-0">
            <button
              type="button"
              onClick={toggleCollapsed}
              title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              aria-expanded={!collapsed}
              className="absolute -right-[11px] top-0 flex h-[22px] w-[22px] items-center justify-center rounded-full border border-white/20 bg-rail text-white/55 shadow-[0_1px_4px_rgba(0,0,0,0.3)] transition-colors hover:border-white/40 hover:bg-rail-hover hover:text-white"
            >
              <svg
                className="h-[13px] w-[13px] transition-transform duration-200"
                // Left when expanded (click to close), right when collapsed.
                style={{ transform: collapsed ? 'rotate(180deg)' : 'none' }}
                viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"
              >
                <path d="M15 18l-6-6 6-6" />
              </svg>
            </button>
          </div>
        )}

        <div className={`mt-auto border-t border-white/[0.08] py-3 ${collapsed ? 'px-2' : 'px-3'}`}>
          <Link
            href={profile.href}
            title={collapsed ? (profile.name ?? 'Profile') : undefined}
            className={`py-2 ${itemClass(profileActive)}`}
          >
            <NavIcon name="person" active={profileActive} />
            {!collapsed && (
              <span className="min-w-0 leading-tight">
                <span className="block truncate">{profile.name ?? 'Profile'}</span>
                {profile.sub && <span className="block truncate text-[11px] font-normal text-white/40">{profile.sub}</span>}
              </span>
            )}
          </Link>

          {/* POST then hard redirect: the route ends the session server-side
              and clears its cookie, and a full location change guarantees no
              client-side cache of the old session survives. */}
          <button
            type="button"
            onClick={async () => {
              await fetch('/api/auth/signout', { method: 'POST' })
              flowStorage.clearAll()
              window.location.href = '/login'
            }}
            title={collapsed ? 'Sign out' : undefined}
            className={`w-full py-2 text-left ${itemClass(false)}`}
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
    case 'flight':
      return (
        <svg {...common}>
          <path d="M17.8 19.2L16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z" />
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
    case 'trips':
      return (
        <svg {...common}>
          <rect x="3" y="7" width="18" height="13" rx="2" />
          <path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 12h18" />
        </svg>
      )
    case 'check':
      return (
        <svg {...common}>
          <path d="M9 11l3 3 8-8" />
          <path d="M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9" />
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
