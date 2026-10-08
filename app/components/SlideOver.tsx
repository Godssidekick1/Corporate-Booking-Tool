'use client'

import { useEffect } from 'react'

// ── SlideOver ────────────────────────────────────────────────────────────────
// The right-hand editor the master screens open over their table: backdrop,
// a panel holding a header (title, optional line under it, Close), a scrolling
// body and a footer for the actions. Escape or a click on the backdrop closes.
//
// Looks exactly like the editor on Deal codes and Forms of payment, which
// still carry their own copies of these styles.
// ─────────────────────────────────────────────────────────────────────────────

interface SlideOverProps {
  open: boolean
  onClose: () => void
  title: React.ReactNode
  subtitle?: React.ReactNode
  footer?: React.ReactNode
  children: React.ReactNode
}

export default function SlideOver({ open, onClose, title, subtitle, footer, children }: SlideOverProps) {
  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null
  return (
    <>
      <div onClick={onClose} style={s.backdrop} />
      <div role="dialog" aria-modal="true" style={s.panel}>
        <div style={s.head}>
          <div style={{ minWidth: 0 }}>
            <h2 style={s.title}>{title}</h2>
            {subtitle && <div style={s.subtitle}>{subtitle}</div>}
          </div>
          <button type="button" onClick={onClose} style={s.close}>Close</button>
        </div>
        <div style={s.body}>{children}</div>
        {footer && <div style={s.foot}>{footer}</div>}
      </div>
    </>
  )
}

const s: Record<string, React.CSSProperties> = {
  backdrop: { position: 'fixed', inset: 0, background: 'rgba(10,10,20,0.28)', zIndex: 40 },
  panel: { position: 'fixed', top: 0, right: 0, bottom: 0, width: 'min(560px, 92vw)', background: '#fff', zIndex: 41, display: 'flex', flexDirection: 'column', boxShadow: '-8px 0 32px rgba(0,8,53,0.12)' },
  head: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, padding: '16px 20px', borderBottom: '1px solid var(--color-line)' },
  title: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 15, fontWeight: 600, color: 'var(--color-ink)', margin: 0 },
  subtitle: { fontSize: 12, color: 'var(--color-secondary)', marginTop: 4, lineHeight: 1.5 },
  close: { height: 30, padding: '0 11px', background: '#fff', color: '#374151', fontSize: 12, border: '1px solid var(--color-line-strong)', borderRadius: 6, cursor: 'pointer', flexShrink: 0 },
  body: { flex: 1, overflowY: 'auto', padding: '16px 20px' },
  foot: { display: 'flex', alignItems: 'center', gap: 8, padding: '14px 20px', borderTop: '1px solid var(--color-line)' },
}
