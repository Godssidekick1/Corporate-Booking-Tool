'use client'

import React from 'react'

// ── Loaders for the booking flow ─────────────────────────────────────────────
// Three of the steps in this flow call the airline, and those calls are slow in
// a way that is not our code's fault and not going to change: a measured
// FlightAvailability round trip is 7-8 seconds, and booking and ticketing are
// the same order of magnitude.
//
// Every one of those buttons already dimmed itself and swapped its label to
// "Booking…". That is a weak signal for a wait this long, because NOTHING MOVES
// — after two seconds of a static screen people click again, and on the confirm
// step a second click is a second attempt at creating a PNR.
//
// So there are two pieces here, used for different reasons:
//
//   Spinner       something is moving, inline, at the point of action.
//   BusyOverlay   the page is genuinely unavailable until this finishes.
//
// The overlay is deliberately NOT used everywhere. It takes the screen away, so
// it is reserved for the steps that talk to the airline and cannot be repeated
// safely. A step that merely navigates gets the inline spinner.
//
// The `spin` keyframe lives in globals.css and is already covered by the
// prefers-reduced-motion block there.
// ─────────────────────────────────────────────────────────────────────────────

export function Spinner({
  size = 16,
  // Defaults to the button foreground, since that is where most of these sit.
  color = '#FFFFFF',
  track = 'rgba(255,255,255,0.35)',
}: {
  size?: number
  color?: string
  track?: string
}) {
  return (
    <span
      aria-hidden="true"
      style={{
        display: 'inline-block',
        width: `${size}px`,
        height: `${size}px`,
        border: `${Math.max(2, Math.round(size / 8))}px solid ${track}`,
        borderTopColor: color,
        borderRadius: '50%',
        flexShrink: 0,
        animation: 'spin 0.7s linear infinite',
      }}
    />
  )
}

// A label that keeps its spinner and its text on one line and centred, so a
// button does not change width or jump when it becomes busy.
export function ButtonBusy({ label }: { label: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '9px' }}>
      <Spinner />
      {label}
    </span>
  )
}

export function BusyOverlay({
  title,
  note,
}: {
  title: string
  // What is actually happening and why waiting is the right thing to do. A
  // spinner with no words is indistinguishable from a page that has hung.
  note?: string
}) {
  return (
    <div
      // Announced rather than silent: a sighted user sees the screen change, a
      // screen-reader user gets nothing unless it is said.
      role="status"
      aria-live="polite"
      // Never follows the page onto paper — see the @media print block.
      className="no-print"
      style={s.backdrop}
    >
      <div style={s.card}>
        <Spinner size={30} color="#000835" track="#E5E7EB" />
        <p style={s.title}>{title}</p>
        {note && <p style={s.note}>{note}</p>}
        {/* Said plainly, because the reason to stay on the page is real: these
            calls create or issue something with the airline, and a reload
            mid-flight leaves a booking whose status we have to reconcile. */}
        <p style={s.warn}>Please don&apos;t close or refresh this page.</p>
      </div>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  backdrop: {
    position: 'fixed',
    inset: 0,
    zIndex: 60,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '24px',
    background: 'rgba(247, 248, 252, 0.82)',
    backdropFilter: 'blur(2px)',
    WebkitBackdropFilter: 'blur(2px)',
  },
  card: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '14px',
    maxWidth: '340px',
    width: '100%',
    padding: '28px 24px',
    background: '#fff',
    border: '1px solid #E5E7EB',
    borderRadius: '16px',
    boxShadow: '0 12px 32px rgba(10, 10, 20, 0.10)',
    textAlign: 'center',
  },
  title: { margin: 0, fontSize: '15px', fontWeight: 700, color: '#111827' },
  note: { margin: 0, fontSize: '12.5px', color: '#6B7280', lineHeight: 1.55 },
  warn: { margin: 0, fontSize: '11.5px', color: '#9CA3AF' },
}
