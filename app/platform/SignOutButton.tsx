'use client'

import { useState } from 'react'

// ── SignOutButton ────────────────────────────────────────────────────────────
// The platform header is a server component, and signing out needs a click, so
// this is the one client island in it.
//
// It exists because the first cut of /platform had no way out at all: a platform
// admin has no employees row, so neither the corporate sidebar nor the TMC rail
// is reachable, and those are where every other sign-out button lives. The only
// escape was the browser console.
//
// redirect: 'manual' because the route answers with a 302 to /login. Letting
// fetch follow it would fetch the login PAGE and discard it — the browser has to
// navigate, so the redirect is swallowed here and the navigation done properly.
// ─────────────────────────────────────────────────────────────────────────────

export default function SignOutButton() {
  const [busy, setBusy] = useState(false)

  return (
    <button
      onClick={async () => {
        setBusy(true)
        try {
          await fetch('/api/auth/signout', { method: 'POST', redirect: 'manual' })
        } finally {
          // A hard navigation, not router.push: every cached server component
          // above this was rendered for a session that no longer exists.
          window.location.href = '/login'
        }
      }}
      disabled={busy}
      style={{
        height: 28,
        padding: '0 11px',
        background: 'rgba(255,255,255,0.08)',
        color: 'rgba(255,255,255,0.75)',
        fontSize: 12,
        border: '1px solid rgba(255,255,255,0.18)',
        borderRadius: 6,
        cursor: busy ? 'default' : 'pointer',
      }}
    >
      {busy ? 'Signing out…' : 'Sign out'}
    </button>
  )
}
