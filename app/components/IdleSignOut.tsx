'use client'

import { useEffect, useRef, useState } from 'react'
import { usePathname } from 'next/navigation'
import { isProtectedPath } from '@/app/lib/navigation/protectedPaths'
import { flowStorage } from '@/app/lib/book/flowStorage'
import {
  LAST_ACTIVITY_KEY, SIGNED_OUT_KEY, idlePhase, keepAliveDue, type IdlePhase,
} from '@/app/lib/auth/idle'

// ── Idle sign-out (user, 2026-11-19) ─────────────────────────────────────────
// On every signed-in page: after 10 minutes without a person's input the page
// signs out, with a minute's warning first (the timing: app/lib/auth/idle.ts).
// Input in any tab keeps every tab signed in; a sign-out in one signs out the
// others. While someone is active on a page that makes no requests, the
// server's own 10-minute clock is moved on (POST /api/auth/keepalive) at most
// once a minute. Mounted once, in the root layout; off on public pages.
// ─────────────────────────────────────────────────────────────────────────────

const INPUT_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'scroll'] as const

// A full load, not a client navigation: nothing of the old session stays in
// memory; replace, so Back does not return to the signed-out page.
function toLogin() {
  window.location.replace(new URL('/login?reason=idle', window.location.origin).href)
}

function readShared(): number {
  try { return Number(localStorage.getItem(LAST_ACTIVITY_KEY)) || 0 } catch { return 0 }
}
function writeShared(key: string, at: number) {
  try { localStorage.setItem(key, String(at)) } catch { /* private mode: this tab alone */ }
}

export default function IdleSignOut() {
  const pathname = usePathname()
  const armed = isProtectedPath(pathname ?? '')
  const [state, setState] = useState<IdlePhase>({ phase: 'active' })
  const lastActivity = useRef(0)
  const lastShared = useRef(0)
  const lastKeepAlive = useRef(0)
  const signingOut = useRef(false)

  useEffect(() => {
    if (!armed) return
    const start = Date.now()
    lastActivity.current = Math.max(start, readShared())
    lastKeepAlive.current = start   // the page load itself reached the server
    writeShared(LAST_ACTIVITY_KEY, lastActivity.current)

    function signOut() {
      if (signingOut.current) return
      signingOut.current = true
      writeShared(SIGNED_OUT_KEY, Date.now())
      flowStorage.clearAll()
      fetch('/api/auth/signout?reason=idle', { method: 'POST', redirect: 'manual' })
        .catch(() => {})
        .finally(() => { toLogin() })
    }

    function keepAlive(now: number) {
      lastKeepAlive.current = now
      fetch('/api/auth/keepalive', { method: 'POST' })
        .then(res => { if (res.status === 401) signOut() })   // already ended on the server
        .catch(() => {})                                      // offline: the clock still runs
    }

    function onInput() {
      if (signingOut.current) return
      const now = Date.now()
      lastActivity.current = now
      // Shared with other tabs every few seconds, not on every pointer move.
      if (now - lastShared.current > 5_000) { lastShared.current = now; writeShared(LAST_ACTIVITY_KEY, now) }
      if (keepAliveDue(lastKeepAlive.current, now)) keepAlive(now)
    }

    function onStorage(e: StorageEvent) {
      if (e.key === LAST_ACTIVITY_KEY && e.newValue) lastActivity.current = Math.max(lastActivity.current, Number(e.newValue) || 0)
      if (e.key === SIGNED_OUT_KEY && !signingOut.current) {
        signingOut.current = true
        toLogin()
      }
    }

    function tick() {
      if (signingOut.current) return
      const phase = idlePhase(Math.max(lastActivity.current, readShared()), Date.now())
      if (phase.phase === 'expired') { signOut(); return }
      setState(prev => (prev.phase === phase.phase && (prev.phase !== 'warning' || prev.secondsLeft === (phase as { secondsLeft: number }).secondsLeft) ? prev : phase))
    }

    for (const ev of INPUT_EVENTS) window.addEventListener(ev, onInput, { passive: true, capture: true })
    window.addEventListener('storage', onStorage)
    const timer = window.setInterval(tick, 1000)
    return () => {
      for (const ev of INPUT_EVENTS) window.removeEventListener(ev, onInput, { capture: true })
      window.removeEventListener('storage', onStorage)
      window.clearInterval(timer)
    }
  }, [armed])

  if (!armed || state.phase !== 'warning') return null

  return (
    <div style={s.backdrop} role="alertdialog" aria-modal="true" aria-labelledby="idle-title" aria-describedby="idle-text">
      <div style={s.card}>
        <p id="idle-title" style={s.title}>Still there?</p>
        <p id="idle-text" style={s.text}>
          For your security, you’ll be signed out in <strong>{state.secondsLeft} second{state.secondsLeft === 1 ? '' : 's'}</strong> because
          of inactivity.
        </p>
        {/* Any input counts, so pressing this (or moving the mouse) keeps the
            session; the button says so plainly. */}
        <button type="button" style={s.primary} autoFocus>Stay signed in</button>
      </div>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  backdrop: {
    position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0, 8, 53, 0.45)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
  },
  card: {
    width: '100%', maxWidth: 380, background: '#fff', borderRadius: 14, padding: '22px 22px 18px',
    boxShadow: '0 24px 64px rgba(0, 8, 53, 0.28)', fontFamily: 'inherit',
  },
  title: { fontSize: 17, fontWeight: 700, color: '#0A0A14', margin: '0 0 8px' },
  text: { fontSize: 13.5, color: '#374151', lineHeight: 1.55, margin: '0 0 16px' },
  primary: {
    width: '100%', height: 42, background: '#000835', color: '#fff', border: 'none', borderRadius: 10,
    fontSize: 14, fontWeight: 700, cursor: 'pointer',
  },
}
