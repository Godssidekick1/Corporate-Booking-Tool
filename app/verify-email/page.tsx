'use client'

import { useState } from 'react'

export default function VerifyEmailPage() {
  const [resent, setResent] = useState(false)
  const [loading, setLoading] = useState(false)

  async function handleResend() {
    setLoading(true)
    try {
      await fetch('/api/auth/resend-verification', { method: 'POST' })
      setResent(true)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={styles.root}>
      {/* Left panel — same language as login/register */}
      <div style={styles.panel}>
        <div style={styles.panelInner}>
          <div style={styles.wordmark}>
            <span style={styles.wordmarkMain}>TravelDesk</span>
            <span style={styles.wordmarkBy}>by Amadeus</span>
          </div>
          <p style={styles.panelTagline}>
            Secure, policy-governed corporate travel for your entire organisation.
          </p>
        </div>
        <p style={styles.panelFooter}>© {new Date().getFullYear()} Amadeus IT Group</p>
      </div>

      {/* Right panel */}
      <div style={styles.formPanel}>
        <div style={styles.card}>
          {/* Icon */}
          <div style={styles.iconWrap}>
            <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
              <rect width="28" height="28" rx="8" fill="#EEF2FF" />
              <path
                d="M6 9.5L14 15.5L22 9.5M6 9C6 8.448 6.448 8 7 8H21C21.552 8 22 8.448 22 9V19C22 19.552 21.552 20 21 20H7C6.448 20 6 19.552 6 19V9Z"
                stroke="#000835"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>

          <h1 style={styles.heading}>Check your inbox</h1>
          <p style={styles.body}>
            We've sent a verification link to your work email. Click it to activate
            your account and continue setup.
          </p>

          <div style={styles.hint}>
            <span style={styles.hintDot} />
            The link expires in 24 hours.
          </div>
          <div style={styles.hint}>
            <span style={styles.hintDot} />
            Check your spam folder if you don't see it within a minute.
          </div>

          <div style={styles.divider} />

          {resent ? (
            <p style={styles.resentMsg}>
              ✓ Verification email resent. Give it a moment.
            </p>
          ) : (
            <button
              onClick={handleResend}
              disabled={loading}
              style={{ ...styles.resendBtn, opacity: loading ? 0.6 : 1 }}
            >
              {loading ? 'Sending…' : 'Resend verification email'}
            </button>
          )}

          <p style={styles.footer}>
            Wrong email?{' '}
            <a href="/register" style={styles.link}>Go back and re-register</a>
          </p>
        </div>
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  root: {
    display: 'flex',
    minHeight: '100vh',
    fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
    backgroundColor: '#F7F8FC',
  },
  panel: {
    width: '420px',
    flexShrink: 0,
    backgroundColor: '#000835',
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'space-between',
    padding: '48px 40px',
  },
  panelInner: { display: 'flex', flexDirection: 'column', gap: '24px' },
  wordmark: { display: 'flex', flexDirection: 'column', gap: '4px' },
  wordmarkMain: {
    fontSize: '28px', fontWeight: '700', color: '#FFFFFF', letterSpacing: '-0.5px',
  },
  wordmarkBy: {
    fontSize: '13px', fontWeight: '400', color: 'rgba(255,255,255,0.45)',
    letterSpacing: '0.5px', textTransform: 'uppercase' as const,
  },
  panelTagline: {
    fontSize: '15px', lineHeight: '1.6', color: 'rgba(255,255,255,0.6)',
    maxWidth: '260px', margin: 0,
  },
  panelFooter: { fontSize: '12px', color: 'rgba(255,255,255,0.25)', margin: 0 },
  formPanel: {
    flex: 1, display: 'flex', alignItems: 'center',
    justifyContent: 'center', padding: '40px 24px',
  },
  card: { width: '100%', maxWidth: '420px' },
  iconWrap: { marginBottom: '24px' },
  heading: {
    fontSize: '24px', fontWeight: '700', color: '#0A0A14',
    margin: '0 0 12px', letterSpacing: '-0.3px',
  },
  body: {
    fontSize: '15px', lineHeight: '1.65', color: '#4B5563', margin: '0 0 24px',
  },
  hint: {
    display: 'flex', alignItems: 'center', gap: '8px',
    fontSize: '13px', color: '#6B7280', marginBottom: '10px',
  },
  hintDot: {
    width: '5px', height: '5px', borderRadius: '50%',
    backgroundColor: '#9CA3AF', flexShrink: 0,
  },
  divider: {
    height: '1px', backgroundColor: '#E5E7EB', margin: '24px 0',
  },
  resentMsg: {
    fontSize: '13px', color: '#059669',
    backgroundColor: '#ECFDF5', border: '1px solid #A7F3D0',
    borderRadius: '6px', padding: '10px 12px', margin: '0 0 16px',
  },
  resendBtn: {
    width: '100%', height: '40px',
    backgroundColor: 'transparent',
    color: '#000835', fontSize: '13px', fontWeight: '600',
    border: '1.5px solid #000835', borderRadius: '8px',
    cursor: 'pointer', marginBottom: '16px',
  },
  footer: { fontSize: '13px', color: '#6B7280', textAlign: 'center' as const },
  link: { color: '#000835', fontWeight: '500', textDecoration: 'none' },
}