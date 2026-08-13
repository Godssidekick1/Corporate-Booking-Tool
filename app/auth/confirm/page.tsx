'use client'

import { Suspense, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'

// ── /auth/confirm ────────────────────────────────────────────────────────
// Landing point for invite and password-reset links, reached via
// /auth/callback. Deliberately requires a real click before anything is
// verified server-side (see /api/auth/verify) — corporate email security
// (Outlook Safe Links, Google Workspace link scanning) auto-visits links in
// incoming email before a human ever opens them. Since invite/reset tokens
// are one-time-use, an automated pre-visit that completed verification on
// page load would silently burn the token, and the real recipient's click
// would always fail with "already used." Requiring a click means the
// scanner's GET request only ever renders this page — harmless.
//
// useSearchParams() requires a Suspense boundary at the page level (Next.js
// bails out of static prerendering otherwise — see
// https://nextjs.org/docs/messages/missing-suspense-with-csr-bailout).
// This route is inherently dynamic (every visit has different token_hash/
// code params), so the fallback below is never really shown in practice,
// but Next.js still requires the boundary to exist for the build to
// prerender the page shell.
// ─────────────────────────────────────────────────────────────────────────────

export default function AuthConfirmPage() {
  return (
    <Suspense fallback={<div style={styles.root} />}>
      <AuthConfirmInner />
    </Suspense>
  )
}

function AuthConfirmInner() {
  const router = useRouter()
  const params = useSearchParams()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const tokenHash = params.get('token_hash') ?? undefined
  const type = params.get('type') ?? undefined
  const code = params.get('code') ?? undefined
  const next = params.get('next') ?? '/'

  const hasValidParams = Boolean((tokenHash && type) || code)

  async function handleContinue() {
    setLoading(true)
    setError('')
    try {
      const res = await fetch('/api/auth/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tokenHash, type, code, next }),
      })
      const data = await res.json()

      if (!data.ok) {
        setError(data.error || 'Something went wrong. Please try again.')
        return
      }

      router.push(data.destination)
    } catch {
      setError('Something went wrong. Please check your connection and try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={styles.root}>
      <div style={styles.panel}>
        <div>
          <div style={styles.wordmark}>
            <span style={styles.wmMain}>TravelDesk</span>
            <span style={styles.wmBy}>by Amadeus</span>
          </div>
          <p style={styles.tagline}>
            One click to confirm it's really you, then we'll take you straight in.
          </p>
        </div>
        <p style={styles.panelFooter}>© {new Date().getFullYear()} Amadeus IT Group</p>
      </div>

      <div style={styles.formPanel}>
        <div style={styles.card}>
          {!hasValidParams ? (
            <>
              <h1 style={styles.heading}>Link not recognized</h1>
              <p style={styles.sub}>
                This link looks incomplete or has already been opened. If you're trying to accept an invite or
                reset your password, please request a new link.
              </p>
              <button type="button" onClick={() => router.push('/login')} style={styles.button}>
                Back to sign in
              </button>
            </>
          ) : (
            <>
              <h1 style={styles.heading}>Confirm to continue</h1>
              <p style={styles.sub}>
                For your security, we need one click from you to finish this — automated email scanners can't do
                this part for you.
              </p>

              {error && <p style={styles.error}>{error}</p>}

              <button
                type="button"
                onClick={handleContinue}
                disabled={loading}
                style={{ ...styles.button, opacity: loading ? 0.6 : 1, cursor: loading ? 'not-allowed' : 'pointer' }}
              >
                {loading ? 'Confirming…' : 'Continue →'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  root: {
    display: 'flex', minHeight: '100vh',
    fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
    background: '#F7F8FC',
  },
  panel: {
    width: '420px', flexShrink: 0, background: '#000835',
    display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
    padding: '48px 40px',
  },
  wordmark: { display: 'flex', flexDirection: 'column', gap: '4px', marginBottom: '24px' },
  wmMain: { fontSize: '28px', fontWeight: 600, color: '#fff', letterSpacing: '-0.5px' },
  wmBy: {
    fontSize: '11px', color: 'rgba(255,255,255,0.38)',
    letterSpacing: '0.6px', textTransform: 'uppercase' as const,
  },
  tagline: {
    fontSize: '15px', lineHeight: '1.65',
    color: 'rgba(255,255,255,0.55)', maxWidth: '260px', margin: 0,
  },
  panelFooter: { fontSize: '11px', color: 'rgba(255,255,255,0.2)', margin: 0 },
  formPanel: {
    flex: 1, display: 'flex',
    alignItems: 'center', justifyContent: 'center',
    padding: '40px 24px',
  },
  card: { width: '100%', maxWidth: '400px' },
  heading: {
    fontSize: '24px', fontWeight: 600, color: '#0A0A14',
    margin: '0 0 8px', letterSpacing: '-0.3px',
  },
  sub: { fontSize: '14px', color: '#6B7280', margin: '0 0 32px', lineHeight: '1.6' },
  error: {
    fontSize: '13px', color: '#DC2626',
    background: '#FEF2F2', border: '1px solid #FECACA',
    borderRadius: '6px', padding: '10px 12px', margin: '0 0 20px',
  },
  button: {
    height: '42px', width: '100%', background: '#000835', color: '#fff',
    fontSize: '14px', fontWeight: 600, border: 'none', borderRadius: '8px',
  },
}