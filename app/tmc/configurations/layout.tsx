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
// Accordion: exactly one group open at a time. With ~15 entries, everything
// open is the same wall of links the grouping was meant to break up.
//
// Master opens by default — it is the reference data a TMC configures first and
// returns to most. The group containing the current route wins over both the
// default and the stored value, since a deep link must never land on a page
// whose own nav entry is hidden inside a collapsed group.
// ─────────────────────────────────────────────────────────────────────────────

// v2 key. v1 stored a Record<string, boolean> under `tmc.config.openGroups`;
// this stores a single string. Using a new key rather than migrating means an
// old value is simply ignored instead of being JSON.parsed into the wrong
// shape — parse succeeds and hands back an object, so a type check would be the
// only thing catching it.
const STORAGE_KEY = 'tmc.config.openGroup'
const DEFAULT_GROUP = 'Master'

export default function ConfigurationsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? ''

  const [role, setRole] = useState<string>()
  const [permissions, setPermissions] = useState<string[]>([])
  const [loaded, setLoaded] = useState(false)
  // One group, not a set — the accordion rule is expressed by the type.
  const [openGroup, setOpenGroup] = useState<string | null>(DEFAULT_GROUP)

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

  // Read after mount. localStorage does not exist during server render, so
  // reading it in a useState initializer would either crash on the server or
  // hydrate to a different value than the HTML. It also throws outright in some
  // privacy modes rather than returning null, hence the try/catch.
  useEffect(() => {
    // The active group wins over both the stored value and the default: landing
    // on a page whose nav entry is hidden is worse than ignoring a preference.
    const active = groupContaining(pathname)
    if (active) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setOpenGroup(active)
      return
    }

    let stored: string | null = null
    try { stored = localStorage.getItem(STORAGE_KEY) } catch { /* non-fatal */ }

    // Guard against a group that has since been renamed or removed — a stale
    // value would otherwise leave every group closed with no way to tell why.
    const valid = stored && CONFIG_GROUPS.some(g => g.label === stored)

    setOpenGroup(valid ? stored : DEFAULT_GROUP)

    // Mount-only on purpose: re-running when pathname changes would yank the
    // open group away from under someone who just opened a different one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function toggle(label: string) {
    setOpenGroup(prev => {
      // Clicking the open group closes it, leaving none open. That is a valid
      // state — collapsing everything to see the whole structure is useful.
      const next = prev === label ? null : label
      try {
        if (next) localStorage.setItem(STORAGE_KEY, next)
        else localStorage.removeItem(STORAGE_KEY)
      } catch { /* non-fatal */ }
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
              const isOpen = openGroup === group.label
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
