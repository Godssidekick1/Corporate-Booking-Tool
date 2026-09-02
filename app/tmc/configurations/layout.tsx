'use client'

import { useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import Link from 'next/link'
import { canAccess } from '@/app/lib/permissions/canAccess'
import { CONFIG_GROUPS, isActive, groupContaining } from '@/app/lib/navigation/tmcNav'

// ── Configurations layout ────────────────────────────────────────────────────
// The second column, rendered inside the persistent shell rather than replacing
// it. This layout used to supply the ONLY sidebar, which is why entering
// settings dropped the main rail entirely.
//
// Groups collapse to keep ~15 entries navigable. Open/closed persists in
// localStorage so the column doesn't reset on every navigation, and the group
// containing the current route is force-opened regardless — otherwise deep
// links land on a page whose own nav entry is hidden.
// ─────────────────────────────────────────────────────────────────────────────

const STORAGE_KEY = 'tmc.config.openGroups'

export default function ConfigurationsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? ''

  const [role, setRole] = useState<string>()
  const [permissions, setPermissions] = useState<string[]>([])
  const [loaded, setLoaded] = useState(false)
  const [open, setOpen] = useState<Record<string, boolean>>({})

  useEffect(() => {
    let cancelled = false

    fetch('/api/me')
      .then(r => r.json())
      .then(d => {
        if (cancelled || !d.ok) return
        setRole(d.employee?.role)
        setPermissions(d.permissions ?? [])
      })
      .finally(() => { if (!cancelled) setLoaded(true) })

    return () => { cancelled = true }
  }, [])

  // Read once on mount. Wrapped because localStorage throws outright in some
  // privacy modes rather than returning null.
  useEffect(() => {
    let stored: Record<string, boolean> = {}
    try {
      stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
    } catch {
      stored = {}
    }

    const activeGroup = groupContaining(pathname)
    const next: Record<string, boolean> = {}

    for (const group of CONFIG_GROUPS) {
      // Default open on first visit — a nav that starts fully collapsed hides
      // what the product can even do.
      next[group.label] = stored[group.label] ?? true
    }
    if (activeGroup) next[activeGroup] = true

    // set-state-in-effect is disabled deliberately. localStorage does not exist
    // during server render, so the stored state cannot be read in a useState
    // initializer without either crashing on the server or producing a
    // hydration mismatch when the user's saved state differs from the default.
    // Rendering the default and syncing after mount is the correct shape for
    // this; the rule's own guidance permits subscribing to an external store.
    //
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOpen(next)

    // Mount-only on purpose: re-running when pathname changes would re-open the
    // group the user just collapsed while inside it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function toggle(label: string) {
    setOpen(prev => {
      const next = { ...prev, [label]: !prev[label] }
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)) } catch { /* non-fatal */ }
      return next
    })
  }

  // A group whose every child is permission-hidden must not render a heading
  // with nothing under it. "Soon" items count as visible — they are the point.
  const groups = CONFIG_GROUPS
    .map(group => ({
      ...group,
      items: group.items.filter(i => i.soon || !i.permission || canAccess(role, permissions, i.permission)),
    }))
    .filter(group => group.items.length > 0)

  return (
    <div className="flex min-h-screen">
      <nav className="w-subnav shrink-0 border-r border-line bg-surface">
        <div className="px-5 py-6">
          <h2 className="text-[15px] font-semibold text-ink">Configurations</h2>
        </div>

        <div className="pb-8">
          {!loaded ? (
            <div className="space-y-2 px-5">
              {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="skeleton h-4" style={{ width: `${55 + ((i * 13) % 35)}%` }} />
              ))}
            </div>
          ) : (
            groups.map(group => {
              const isOpen = open[group.label] ?? true
              return (
                <div key={group.label} className="mb-1">
                  <button
                    type="button"
                    onClick={() => toggle(group.label)}
                    aria-expanded={isOpen}
                    className="flex w-full items-center justify-between px-5 py-2 text-[10px] font-semibold uppercase tracking-wider text-secondary transition-colors hover:text-body"
                  >
                    {group.label}
                    <svg
                      className="h-3 w-3 transition-transform duration-200"
                      style={{ transform: isOpen ? 'rotate(180deg)' : 'rotate(0deg)' }}
                      viewBox="0 0 24 24" fill="none" stroke="currentColor"
                      strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                    >
                      <path d="M6 9l6 6 6-6" />
                    </svg>
                  </button>

                  {/* grid-template-rows 0fr -> 1fr, see .collapsible in
                      globals.css. Animating height would need a measured pixel
                      value and would break when content reflows. */}
                  <div className="collapsible" data-open={isOpen}>
                    <div>
                      {group.items.map(item =>
                        item.soon ? (
                          <div
                            key={item.label}
                            aria-disabled="true"
                            className="flex cursor-not-allowed items-center justify-between py-2 pl-5 pr-4 text-[13px] text-muted"
                          >
                            {item.label}
                            <span className="rounded bg-canvas px-1.5 py-0.5 text-[10px] font-semibold text-muted">
                              Soon
                            </span>
                          </div>
                        ) : (
                          <Link
                            key={item.href}
                            href={item.href}
                            aria-current={isActive(pathname, item.href) ? 'page' : undefined}
                            className={[
                              'flex items-center border-l-2 py-2 pl-[18px] pr-4 text-[13px] transition-colors',
                              isActive(pathname, item.href)
                                ? 'border-rail bg-info-bg/60 font-semibold text-rail'
                                : 'border-transparent text-body hover:bg-canvas',
                            ].join(' ')}
                          >
                            {item.label}
                          </Link>
                        )
                      )}
                    </div>
                  </div>
                </div>
              )
            })
          )}
        </div>
      </nav>

      <div className="min-w-0 flex-1 px-8 py-7">{children}</div>
    </div>
  )
}
