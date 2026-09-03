'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createBrowserClient } from '@supabase/ssr'

const supabase = createBrowserClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

export default function SignInPage() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const [mode, setMode] = useState<'signin' | 'forgot'>('signin')
  const [resetEmail, setResetEmail] = useState('')
  const [resetSent, setResetSent] = useState(false)
  const [resetLoading, setResetLoading] = useState(false)
  const [resetError, setResetError] = useState('')

  // Invite and password-reset links both route through /auth/callback now
  // (a server-side code exchange, exempt from proxy.ts's "authenticated
  // user visiting /login -> redirect to dashboard" rule) rather than
  // landing here with a hash-fragment token. This page no longer needs to
  // parse anything off the URL on load — see /auth/callback/route.ts.

  // Returns true when a navigation was started, so the caller knows to KEEP the
  // loading state up rather than clearing it. router.push resolves immediately
  // while the destination is still loading, so clearing here left the button
  // idle and the screen blank for the whole wait.
  async function redirectByRole(): Promise<boolean> {
    const res = await fetch('/api/me')
    const data = await res.json()
    const role = data.employee?.role

    // Only tmc_admin/tc are TMC-side — every other real role (admin,
    // manager, employee, finance, ...) is corporate-side and belongs on
    // /dashboard. Previously this only handled role === 'admin' explicitly,
    // so manager/employee/finance accounts fell through both branches and
    // silently never redirected at all — stuck on /login with a valid
    // session and no visible error, since nothing here threw.
    if (role === 'tmc_admin' || role === 'tc') {
      router.push('/tmc/dashboard')
      return true
    } else if (role) {
      router.push('/dashboard')
      return true
    } else {
      // No role at all (e.g. employee row missing) — same failure mode
      // /dashboard's own fetch handler treats as unauthenticated.
      setError('Could not determine your account role. Please contact support.')
      return false
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    let navigating = false
    try {
      const res = await fetch('/api/auth/signin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error || 'Sign in failed'); return }
      navigating = await redirectByRole()
    } catch {
      setError('Something went wrong. Please try again.')
    } finally {
      // Left up on success: this component unmounts when the destination
      // renders, and clearing it here is what made the spinner stop while the
      // dashboard was still fetching.
      if (!navigating) setLoading(false)
    }
  }

  async function handleResetRequest(e: React.FormEvent) {
    e.preventDefault()
    setResetError('')
    setResetLoading(true)
    try {
      // Routed through /auth/callback, not /login — two separate problems
      // with sending this to /login:
      // 1. resetPasswordForEmail() issues a different link format than
      //    inviteUserByEmail() does; /login only ever parsed hash-fragment
      //    tokens (#access_token=...), so a link that arrives as a ?code=
      //    query param instead would land on /login and do nothing.
      // 2. Even for a hash-token link, proxy.ts redirects an authenticated
      //    user away from /login server-side, before the browser ever runs
      //    the client-side code that reads the hash — so anyone with an
      //    existing session cookie in that browser never gets a chance to
      //    process the reset link at all.
      // /auth/callback does a proper server-side code exchange and is
      // exempt from that redirect, and next=/auth/set-password tells it
      // where to land afterward instead of its default role-based redirect.
      const { error: resetErr } = await supabase.auth.resetPasswordForEmail(resetEmail, {
        redirectTo: `${window.location.origin}/auth/callback?next=/auth/set-password`,
      })
      if (resetErr) {
        setResetError(resetErr.message)
        return
      }
      setResetSent(true)
    } catch {
      setResetError('Something went wrong. Please try again.')
    } finally {
      setResetLoading(false)
    }
  }

  return (
    <div style={styles.root}>
      {/* Covers the gap between "credentials accepted" and "dashboard painted",
          which is the longest wait in the whole app and previously showed
          nothing at all. Sits above the panel so the form cannot be resubmitted
          while a navigation is already under way. */}
      {loading && (
        <div style={styles.signingIn} role="status" aria-live="polite">
          <div style={styles.signingInCard}>
            <span style={styles.spinner} />
            <span style={styles.signingInText}>Signing you in…</span>
          </div>
        </div>
      )}

      <div style={styles.panel}>
        <div style={styles.panelInner}>
          <div style={styles.wordmark}>
            <span style={styles.wordmarkMain}>TravelDesk</span>
            <span style={styles.wordmarkBy}>by Amadeus</span>
          </div>
          <p style={styles.panelTagline}>
            Corporate travel management built for modern teams.
          </p>
        </div>
        <p style={styles.panelFooter}>© {new Date().getFullYear()} Amadeus IT Group</p>
      </div>

      <div style={styles.formPanel}>
        <div style={styles.formCard}>
          {mode === 'signin' ? (
            <>
              <h1 style={styles.heading}>Welcome back</h1>
              <p style={styles.subheading}>Sign in to your account</p>

              <form onSubmit={handleSubmit} style={styles.form}>
                <div style={styles.field}>
                  <label style={styles.label} htmlFor="email">Work email</label>
                  <input
                    id="email" type="email" autoComplete="email" required
                    value={email} onChange={e => setEmail(e.target.value)}
                    style={styles.input} placeholder="you@company.com"
                  />
                </div>
                <div style={styles.field}>
                  <div style={styles.labelRow}>
                    <label style={styles.label} htmlFor="password">Password</label>
                    <button
                      type="button"
                      onClick={() => { setMode('forgot'); setError(''); setResetError(''); setResetSent(false) }}
                      style={styles.forgotLink}
                      aria-label="Forgot password"
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="3" y="11" width="18" height="11" rx="2" />
                        <path d="M7 11V7a5 5 0 0 1 9.9-1" />
                      </svg>
                      Forgot password?
                    </button>
                  </div>
                  <input
                    id="password" type="password" autoComplete="current-password" required
                    value={password} onChange={e => setPassword(e.target.value)}
                    style={styles.input} placeholder="••••••••"
                  />
                </div>
                {error && <p style={styles.error}>{error}</p>}
                <button
                  type="submit" disabled={loading}
                  style={{ ...styles.button, opacity: loading ? 0.7 : 1 }}
                >
                  {loading ? 'Signing in…' : 'Sign in'}
                </button>
              </form>
            </>
          ) : (
            <>
              <h1 style={styles.heading}>Reset your password</h1>
              <p style={styles.subheading}>
                {resetSent
                  ? 'Check your email for a reset link.'
                  : 'Enter your work email and we\u2019ll send you a link to set a new password.'}
              </p>

              {resetSent ? (
                <div style={styles.form}>
                  <p style={styles.resetSentNote}>
                    If an account exists for <strong>{resetEmail}</strong>, a password reset link is on its way.
                    The link will bring you back here to set a new password.
                  </p>
                  <button
                    type="button"
                    onClick={() => { setMode('signin'); setResetSent(false); setResetEmail('') }}
                    style={styles.button}
                  >
                    ← Back to sign in
                  </button>
                </div>
              ) : (
                <form onSubmit={handleResetRequest} style={styles.form}>
                  <div style={styles.field}>
                    <label style={styles.label} htmlFor="resetEmail">Work email</label>
                    <input
                      id="resetEmail" type="email" autoComplete="email" required
                      value={resetEmail} onChange={e => setResetEmail(e.target.value)}
                      style={styles.input} placeholder="you@company.com"
                    />
                  </div>
                  {resetError && <p style={styles.error}>{resetError}</p>}
                  <button
                    type="submit" disabled={resetLoading}
                    style={{ ...styles.button, opacity: resetLoading ? 0.7 : 1 }}
                  >
                    {resetLoading ? 'Sending…' : 'Send reset link'}
                  </button>
                  <button
                    type="button"
                    onClick={() => { setMode('signin'); setResetError('') }}
                    style={styles.backLink}
                  >
                    ← Back to sign in
                  </button>
                </form>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  root: { display: 'flex', minHeight: '100vh', fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif", backgroundColor: '#F7F8FC' },

  signingIn: {
    position: 'fixed', inset: 0, zIndex: 60,
    background: 'rgba(0, 8, 53, 0.55)', backdropFilter: 'blur(2px)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  signingInCard: {
    display: 'flex', alignItems: 'center', gap: 12,
    background: '#fff', borderRadius: 12, padding: '18px 24px',
    boxShadow: '0 24px 64px rgba(0,8,53,0.28)',
  },
  spinner: {
    width: 18, height: 18, borderRadius: '50%',
    border: '2px solid #E5E7EB', borderTopColor: '#000835',
    // `spin` is defined once in globals.css rather than per component.
    animation: 'spin 0.7s linear infinite', flexShrink: 0,
  },
  signingInText: { fontSize: 14, fontWeight: 500, color: '#0A0A14' },
  panel: { width: '420px', flexShrink: 0, backgroundColor: '#000835', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', padding: '48px 40px' },
  panelInner: { display: 'flex', flexDirection: 'column', gap: '24px' },
  wordmark: { display: 'flex', flexDirection: 'column', gap: '4px' },
  wordmarkMain: { fontSize: '28px', fontWeight: '700', color: '#FFFFFF', letterSpacing: '-0.5px' },
  wordmarkBy: { fontSize: '13px', fontWeight: '400', color: 'rgba(255,255,255,0.45)', letterSpacing: '0.5px', textTransform: 'uppercase' as const },
  panelTagline: { fontSize: '15px', lineHeight: '1.6', color: 'rgba(255,255,255,0.6)', maxWidth: '260px', margin: 0 },
  panelFooter: { fontSize: '12px', color: 'rgba(255,255,255,0.25)', margin: 0 },
  formPanel: { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '40px 24px' },
  formCard: { width: '100%', maxWidth: '400px' },
  heading: { fontSize: '24px', fontWeight: '700', color: '#0A0A14', margin: '0 0 8px', letterSpacing: '-0.3px' },
  subheading: { fontSize: '14px', color: '#6B7280', margin: '0 0 32px' },
  form: { display: 'flex', flexDirection: 'column', gap: '20px' },
  field: { display: 'flex', flexDirection: 'column', gap: '6px' },
  labelRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  label: { fontSize: '13px', fontWeight: '500', color: '#374151' },
  forgotLink: {
    display: 'flex', alignItems: 'center', gap: '5px', background: 'none', border: 'none',
    fontSize: '12px', fontWeight: 500, color: '#6B7280', cursor: 'pointer', padding: 0,
  },
  backLink: {
    background: 'none', border: 'none', fontSize: '13px', fontWeight: 500, color: '#6B7280',
    cursor: 'pointer', padding: '2px 0', textAlign: 'left' as const,
  },
  resetSentNote: { fontSize: '13px', color: '#374151', lineHeight: '1.6', margin: '0 0 4px' },
  input: { height: '42px', padding: '0 12px', fontSize: '14px', color: '#0A0A14', backgroundColor: '#FFFFFF', border: '1px solid #D1D5DB', borderRadius: '8px', outline: 'none' },
  error: { fontSize: '13px', color: '#DC2626', backgroundColor: '#FEF2F2', border: '1px solid #FECACA', borderRadius: '6px', padding: '10px 12px', margin: 0 },
  button: { height: '42px', backgroundColor: '#000835', color: '#FFFFFF', fontSize: '14px', fontWeight: '600', border: 'none', borderRadius: '8px', cursor: 'pointer', marginTop: '4px' },
}