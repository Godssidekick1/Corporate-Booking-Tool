'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'

// ── StatusScreen ─────────────────────────────────────────────────────────────
// The one screen for "this page does not exist" and "this page crashed",
// wherever it happens: app/not-found.tsx, and the error.tsx of each section
// (corporate, TMC, booking, platform, and the root). Inside a section it sits
// in the content area, so the rail stays and the person can move on.
//
// Our own look, kept simple: a small route drawn as a dashed flight path (to
// an empty destination when the page is not there; looping in a holding
// pattern when it crashed), a boarding-pass strip with the status and, for a
// crash, the reference the server logged it under, one plain sentence of
// what to do, and at most two actions.
// ─────────────────────────────────────────────────────────────────────────────

export interface StatusScreenProps {
  kind: 'not-found' | 'error'
  title: string
  message: string
  // An extra line for where it matters, e.g. the booking flow: "check My
  // trips before booking again".
  note?: string
  // The id the server logged the error under (error.digest), for support.
  reference?: string
  onRetry?: () => void
  // Fill the screen (no shell around it) or sit in a shell's content area.
  fullScreen?: boolean
}

const NAVY = 'var(--color-rail)'

export default function StatusScreen({ kind, title, message, note, reference, onRetry, fullScreen }: StatusScreenProps) {
  // When it happened, for a crash with no server reference (one thrown in the
  // browser). Set after mount: the server's clock and time zone would differ.
  const [time, setTime] = useState('—')
  useEffect(() => {
    const id = setTimeout(() => setTime(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })), 0)
    return () => clearTimeout(id)
  }, [])

  return (
    <main style={{ ...s.wrap, minHeight: fullScreen ? 'var(--full-height)' : '62vh' }}>
      <div style={s.card} role={kind === 'error' ? 'alert' : undefined}>
        <RouteArt kind={kind} />

        <div style={s.stub} aria-hidden>
          <div>
            <span style={s.stubLabel}>Status</span>
            <span style={{ ...s.stubValue, color: kind === 'error' ? 'var(--color-warn-fg)' : NAVY }}>
              {kind === 'error' ? 'Interrupted' : 'Not found'}
            </span>
          </div>
          <div style={{ textAlign: 'right' }}>
            <span style={s.stubLabel}>{kind === 'error' ? (reference ? 'Reference' : 'Time') : 'Code'}</span>
            <span style={{ ...s.stubValue, fontFamily: 'var(--font-mono)' }}>
              {kind === 'error' ? (reference ? reference.slice(0, 12) : time) : '404'}
            </span>
          </div>
        </div>

        <h1 style={s.title}>{title}</h1>
        <p style={s.message}>{message}</p>
        {note && <p style={s.note}>{note}</p>}

        <div style={s.actions}>
          {onRetry && <button type="button" onClick={onRetry} style={s.primary}>Try again</button>}
          {/* /login sends a signed-in person on to their own home page (proxy.ts). */}
          <Link href="/login" style={onRetry ? s.secondary : s.primary}>Go to my home page</Link>
          {!onRetry && (
            <button type="button" onClick={() => history.back()} style={s.secondary}>Go back</button>
          )}
        </div>
        {kind === 'error' && reference && (
          <p style={s.ref}>If it keeps happening, send your travel desk this reference: <code style={s.code}>{reference}</code></p>
        )}
      </div>
    </main>
  )
}

// What every section's error.tsx renders. The thrown value may be anything
// (a client component can throw a non-Error); errors from the server carry a
// digest, the id under which the server logged the real cause, while their
// message is deliberately generic in production, so only the digest is shown.
export function ErrorScreen({ error, retry, note, fullScreen }: {
  error: unknown; retry: () => void; note?: string; fullScreen?: boolean
}) {
  const digest = error instanceof Error && 'digest' in error && typeof error.digest === 'string' ? error.digest : undefined
  return (
    <StatusScreen
      kind="error"
      title="Something went wrong on this page"
      message="It's a problem on our side, not something you did. Try again; if that doesn't work, go to your home page and come back to this later."
      note={note}
      reference={digest}
      onRetry={retry}
      fullScreen={fullScreen}
    />
  )
}

// A short route: origin, a dashed arc, and either an empty destination with a
// question mark (not found) or a holding loop (error).
function RouteArt({ kind }: { kind: StatusScreenProps['kind'] }) {
  const dash = { strokeDasharray: '6 8', animation: 'route-dash 1.6s linear infinite' }
  return (
    <svg viewBox="0 0 260 90" width="100%" height="90" aria-hidden style={{ display: 'block', marginBottom: 18 }}>
      <circle cx="22" cy="70" r="6" fill={NAVY} />
      {kind === 'not-found' ? (
        <>
          <path d="M22 70 Q 130 -6 234 62" fill="none" stroke="var(--color-line-strong)" strokeWidth="2" style={dash} />
          <circle cx="234" cy="66" r="12" fill="var(--color-surface)" stroke={NAVY} strokeWidth="2" strokeDasharray="4 4" />
          <text x="234" y="71" textAnchor="middle" fontSize="14" fontWeight="700" fill={NAVY} fontFamily="var(--font-sans)">?</text>
          <Plane x={128} y={30} rotate={2} />
        </>
      ) : (
        <>
          <path d="M22 70 Q 90 20 150 42" fill="none" stroke="var(--color-line-strong)" strokeWidth="2" style={dash} />
          <ellipse cx="190" cy="42" rx="42" ry="22" fill="none" stroke="var(--color-warn-line)" strokeWidth="2" style={dash} />
          <circle cx="190" cy="42" r="4" fill="var(--color-warn-fg)" />
          <Plane x={190} y={20} rotate={0} />
        </>
      )}
    </svg>
  )
}

function Plane({ x, y, rotate }: { x: number; y: number; rotate: number }) {
  // A simple top-down plane, pointing right.
  return (
    <g transform={`translate(${x} ${y}) rotate(${rotate}) translate(-11 -11)`}>
      <path d="M21 11.5 13 10V4.5L11.4 4 9.5 10 3 9.2 2 10.3l6.5 1.2L6.8 17l1.2.5 3.7-5 8.3.5z" fill={NAVY} />
    </g>
  )
}

const s: Record<string, React.CSSProperties> = {
  wrap: { display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '40px 16px', width: '100%', background: 'var(--color-canvas)' },
  card: {
    width: '100%', maxWidth: 460, background: 'var(--color-surface)', border: '1px solid var(--color-line)',
    borderRadius: 16, padding: '28px 28px 24px', boxShadow: '0 1px 2px rgba(10,10,20,0.04), 0 12px 32px -16px rgba(0,8,53,0.18)',
  },
  stub: {
    display: 'flex', justifyContent: 'space-between', gap: 12, padding: '10px 0', marginBottom: 18,
    borderTop: '1px dashed var(--color-line-strong)', borderBottom: '1px dashed var(--color-line-strong)',
  },
  stubLabel: { display: 'block', fontSize: 10, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--color-muted)' },
  stubValue: { display: 'block', fontSize: 14, fontWeight: 700, color: 'var(--color-ink)', marginTop: 2 },
  title: { fontSize: 20, fontWeight: 700, color: 'var(--color-ink)', margin: '0 0 6px', letterSpacing: '-0.3px' },
  message: { fontSize: 14, lineHeight: 1.55, color: 'var(--color-secondary)', margin: 0 },
  note: {
    fontSize: 13, lineHeight: 1.5, color: 'var(--color-warn-fg)', background: 'var(--color-warn-bg)',
    border: '1px solid var(--color-warn-line)', borderRadius: 8, padding: '8px 10px', margin: '12px 0 0',
  },
  actions: { display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 20 },
  primary: {
    background: NAVY, color: '#fff', border: 'none', borderRadius: 8, padding: '9px 16px', fontSize: 13,
    fontWeight: 600, cursor: 'pointer', textDecoration: 'none', fontFamily: 'inherit',
  },
  secondary: {
    background: 'var(--color-surface)', color: 'var(--color-body)', border: '1px solid var(--color-line-strong)',
    borderRadius: 8, padding: '8px 15px', fontSize: 13, fontWeight: 600, cursor: 'pointer', textDecoration: 'none', fontFamily: 'inherit',
  },
  ref: { fontSize: 12, color: 'var(--color-muted)', margin: '16px 0 0', lineHeight: 1.5 },
  code: { fontFamily: 'var(--font-mono)', color: 'var(--color-body)', background: 'var(--color-canvas)', padding: '1px 5px', borderRadius: 4 },
}
