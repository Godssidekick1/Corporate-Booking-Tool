'use client'

import { useState } from 'react'

// ── SettingsSection ──────────────────────────────────────────────────────────
// One collapsible panel of Corporate Settings.
//
// Same interaction as the policy screen's categories, extracted because this
// page has nine of them and the alternative is nine copies of the same open/
// closed markup. The chevron, the header colour and the "n set" badge all read
// the same way there, so the two screens do not feel like different products.
//
// CLOSED BY DEFAULT, one exception. Nine open panels is a wall of fields with no
// way to find anything; the first section opens so the page does not look empty
// on arrival.
//
// `onFirstOpen` is what makes the heavier sections cheap: corporate cards,
// mandatory information and admin access each need their own request, and
// firing all three on page load would mean three round trips for panels most
// visits never expand.
// ─────────────────────────────────────────────────────────────────────────────

interface SettingsSectionProps {
  title: string
  description?: string
  // Shown on the right of the header — a count, a status, whatever tells you
  // whether this section needs attention without opening it.
  badge?: React.ReactNode
  defaultOpen?: boolean
  onFirstOpen?: () => void
  children: React.ReactNode
}

export default function SettingsSection({
  title, description, badge, defaultOpen = false, onFirstOpen, children,
}: SettingsSectionProps) {
  const [open, setOpen] = useState(defaultOpen)
  const [hasOpened, setHasOpened] = useState(defaultOpen)

  function toggle() {
    const next = !open
    setOpen(next)
    if (next && !hasOpened) {
      setHasOpened(true)
      onFirstOpen?.()
    }
  }

  return (
    <div style={s.block}>
      <button onClick={toggle} style={s.header} aria-expanded={open}>
        <span style={s.headerLeft}>
          <span style={s.title}>{title}</span>
          {badge}
        </span>
        <span style={{ ...s.chevron, transform: open ? 'rotate(180deg)' : 'rotate(0deg)' }}>▾</span>
      </button>

      {open && (
        <div style={s.body}>
          {description && <p style={s.description}>{description}</p>}
          {children}
        </div>
      )}
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  block: { background: '#fff', border: '1px solid #E5E7EB', borderRadius: 10, marginBottom: 10, overflow: 'hidden' },
  header: {
    width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    gap: 12, padding: '13px 16px', background: '#F9FAFB', border: 'none',
    cursor: 'pointer', textAlign: 'left',
  },
  headerLeft: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  title: { fontSize: 13.5, fontWeight: 600, color: '#111827' },
  chevron: { fontSize: 12, color: '#6B7280', transition: 'transform 140ms ease', flexShrink: 0 },
  body: { padding: '16px', borderTop: '1px solid #E5E7EB' },
  description: { fontSize: 12, color: '#6B7280', lineHeight: 1.6, margin: '0 0 14px', maxWidth: 640 },
}
