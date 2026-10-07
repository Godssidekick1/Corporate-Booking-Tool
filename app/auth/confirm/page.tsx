'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import AuthShell, { authStyles as s } from '@/app/components/AuthShell'
import PasswordInput from '@/app/components/PasswordInput'

// ── /auth/confirm ────────────────────────────────────────────────────────────
// Where invite and password-reset links land:
//
//   /auth/confirm#type=invite&token=…      /auth/confirm#type=reset&token=…
//
// THE TOKEN IS IN THE FRAGMENT. Browsers never send a fragment to any server,
// so it stays out of access logs, proxies and Referer headers. This page
// reads it, removes it from the address bar, and posts it.
//
// NOTHING IS SPENT ON LOAD. Corporate email security (Outlook Safe Links,
// Google Workspace scanning) opens links before the recipient does. Loading
// this page only asks whether the link is still good (/api/auth/verify, which
// does not consume it). The token is spent by /api/auth/password/set, when
// the person submits a password. A scanner does not do that.
// ─────────────────────────────────────────────────────────────────────────────

const MIN = 8

type State =
  | { kind: 'checking' }
  | { kind: 'missing' }
  | { kind: 'dead'; error: string }
  | { kind: 'ready'; token: string; email: string; purpose: 'invite' | 'reset' }

export default function AuthConfirmPage() {
  const router = useRouter()
  const [state, setState] = useState<State>({ kind: 'checking' })
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  // The token is read ONCE. React runs effects twice in development, and the
  // first run removes it from the address bar -- so a second read found
  // nothing and flashed "Link not recognized" (with a "Back to sign in"
  // button) until the first run's answer arrived.
  const tokenRef = useRef<string | null>(null)

  useEffect(() => {
    if (tokenRef.current === null) {
      tokenRef.current = new URLSearchParams(window.location.hash.slice(1)).get('token') ?? ''
      // Out of the address bar (and so out of history and screenshots) at once.
      window.history.replaceState(null, '', window.location.pathname)
    }
    const token = tokenRef.current

    // NO router.prefetch of where they go next: before the password is set
    // there is no session, so the proxy would answer with a redirect to /login,
    // and a prefetched static page is kept for five minutes -- the navigation
    // after saving would replay it.

    // Every outcome arrives through the promise, so nothing is set
    // synchronously here and a superseded run cannot overwrite a later one.
    let live = true
    const check: Promise<State> = !token
      ? Promise.resolve({ kind: 'missing' })
      : fetch('/api/auth/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        })
          .then(r => r.json())
          .then((data): State => data.ok
            ? { kind: 'ready', token, email: data.email, purpose: data.purpose }
            : { kind: 'dead', error: data.error })
          .catch((): State => ({ kind: 'dead', error: 'Something went wrong. Please check your connection and reload.' }))
    check.then(next => { if (live) setState(next) })
    return () => { live = false }
  }, [])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (state.kind !== 'ready') return
    setError('')
    if (password.length < MIN) { setError(`Password must be at least ${MIN} characters.`); return }
    if (password !== confirm) { setError('Passwords do not match.'); return }

    setSaving(true)
    let navigating = false
    try {
      const res = await fetch('/api/auth/password/set', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: state.token, password }),
      })
      const data = await res.json()
      if (!data.ok) { setError(data.error || 'Something went wrong. Please try again.'); return }
      navigating = true
      router.replace(data.destination)
    } catch {
      setError('Something went wrong. Please check your connection and try again.')
    } finally {
      if (!navigating) setSaving(false)
    }
  }

  const tagline = state.kind === 'ready' && state.purpose === 'reset'
    ? 'Choose a new password, and you are straight back in.'
    : 'You have been invited to manage corporate travel for your organisation.'

  return (
    <AuthShell tagline={tagline}>
      {state.kind === 'checking' && <p style={s.sub}>Checking your link…</p>}

      {(state.kind === 'missing' || state.kind === 'dead') && (
        <>
          <h1 style={s.heading}>{state.kind === 'missing' ? 'Link not recognized' : 'This link no longer works'}</h1>
          <p style={s.sub}>
            {state.kind === 'dead'
              ? state.error
              : 'This link looks incomplete. If you are trying to accept an invite or reset your password, please request a new link.'}
          </p>
          <button type="button" onClick={() => router.push('/login')} style={s.button}>
            Back to sign in
          </button>
        </>
      )}

      {state.kind === 'ready' && (
        <>
          <h1 style={s.heading}>{state.purpose === 'invite' ? 'Set your password' : 'Choose a new password'}</h1>
          <p style={s.sub}>For <strong>{state.email}</strong>. At least {MIN} characters.</p>
          <form onSubmit={submit} style={s.form}>
            <div style={s.field}>
              <label style={s.label} htmlFor="password">New password</label>
              <PasswordInput id="password" autoComplete="new-password" value={password} onChange={setPassword}
                placeholder={`Min. ${MIN} characters`} required style={s.input} />
            </div>
            <div style={s.field}>
              <label style={s.label} htmlFor="confirm">Confirm password</label>
              <PasswordInput id="confirm" autoComplete="new-password" value={confirm} onChange={setConfirm}
                placeholder="Repeat your password" required style={s.input} />
            </div>
            {error && <p style={s.error}>{error}</p>}
            <button type="submit" disabled={saving} style={{ ...s.button, opacity: saving ? 0.6 : 1 }}>
              {saving ? 'Saving…' : 'Save password & continue →'}
            </button>
          </form>
        </>
      )}
    </AuthShell>
  )
}
