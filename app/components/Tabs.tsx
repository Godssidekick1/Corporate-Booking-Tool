'use client'

import { useEffect, useState } from 'react'

// ── Tabs ─────────────────────────────────────────────────────────────────────
// One tab row for the whole app.
//
// There were three conventions before this: policy's underline row, approvals'
// segmented pill row, and deal-codes/forms-of-payment's underline-with-count.
// Same control, three looks, and nothing to say which was the real one. This is
// policy's, because that is the one that was asked for, carrying the count badge
// from deal codes and the hint line from approvals so the two it replaces lose
// nothing on the way over.
// ─────────────────────────────────────────────────────────────────────────────

export interface TabDef<T extends string = string> {
  id: T
  label: string
  // A number beside the label — how many rows are behind this tab. Omit rather
  // than passing 0 while loading; a count that flickers 0 → 14 reads as data
  // disappearing.
  count?: number
  // One line under the row explaining what this tab is for, shown only while
  // it is the active one.
  hint?: string
}

interface TabsProps<T extends string> {
  tabs: TabDef<T>[]
  active: T
  onChange: (id: T) => void
}

export default function Tabs<T extends string>({ tabs, active, onChange }: TabsProps<T>) {
  const hint = tabs.find(t => t.id === active)?.hint

  return (
    <>
      <div style={s.tabRow} role="tablist">
        {tabs.map(t => (
          <button
            key={t.id}
            role="tab"
            aria-selected={t.id === active}
            onClick={() => onChange(t.id)}
            style={{ ...s.tabBtn, ...(t.id === active ? s.tabActive : {}) }}
          >
            {t.label}
            {t.count !== undefined && <span style={s.tabCount}>{t.count}</span>}
          </button>
        ))}
      </div>
      {hint && <p style={s.tabHint}>{hint}</p>}
    </>
  )
}

// ── useUrlTab ────────────────────────────────────────────────────────────────
// Tab state that survives being linked to, so "take me to this client's policy
// groups" can be one href.
//
// Deliberately NOT useSearchParams(). Two reasons, both already learned the hard
// way in this codebase: it forces a Suspense boundary at the page level (see
// app/profile/page.tsx), and under Next 16's Cache Components it can hand back a
// stale value right after a client-side navigation — the URL bar is correct and
// the hook has not caught up (see the note in app/book/flights/page.tsx, where
// that silently dropped a tripId). The URL is only needed once, on mount, which
// is exactly the case that note describes.
//
// Reading in an effect rather than a useState initialiser keeps the first client
// render identical to the server's — an initialiser that reads window would
// render a different tab than was prerendered and trip hydration.
// ─────────────────────────────────────────────────────────────────────────────
export function useUrlTab<T extends string>(
  param: string,
  fallback: T,
  valid: readonly T[]
): [T, (next: T) => void] {
  const [tab, setTab] = useState<T>(fallback)

  useEffect(() => {
    const fromUrl = new URLSearchParams(window.location.search).get(param)
    if (fromUrl && (valid as readonly string[]).includes(fromUrl)) {
      // set-state-in-effect is disabled rather than obeyed. The alternative is a
      // useState initialiser that reads window, which renders a different tab
      // than was prerendered and trips hydration. One extra render on arrival is
      // the cheaper of the two, and only when the URL actually names a tab.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setTab(fromUrl as T)
    }
    // Mount only: this reads the URL you arrived on, not every later change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function choose(next: T) {
    setTab(next)
    // replaceState rather than router.replace: this is a view preference, not a
    // navigation. Pushing it would make Back walk through tabs instead of
    // leaving the page, and a router round trip would re-render for nothing.
    const url = new URL(window.location.href)
    url.searchParams.set(param, next)
    window.history.replaceState(null, '', url)
  }

  return [tab, choose]
}

const s: Record<string, React.CSSProperties> = {
  tabRow: { display: 'flex', gap: 0, marginBottom: 20, borderBottom: '1px solid #E5E7EB' },
  tabBtn: {
    padding: '9px 16px', background: 'transparent', border: 'none',
    borderBottom: '2px solid transparent', fontSize: 13, color: '#6B7280',
    cursor: 'pointer', marginBottom: -1,
  },
  tabActive: { color: '#000835', fontWeight: 600, borderBottomColor: '#000835' },
  tabCount: { marginLeft: 6, fontSize: 11, color: '#6B7280', background: '#F3F4F6', borderRadius: 10, padding: '1px 7px' },
  tabHint: { fontSize: 12.5, color: '#9CA3AF', lineHeight: 1.6, margin: '-10px 0 18px', maxWidth: 680 },
}
