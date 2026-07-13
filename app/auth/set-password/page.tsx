'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { createBrowserClient } from '@supabase/ssr'

const supabase = createBrowserClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

export default function SetPasswordPage() {
  const router = useRouter()
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [sessionReady, setSessionReady] = useState(false)

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session) {
        router.replace('/login')
        return
      }
      setSessionReady(true)
    })
  }, [router])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')

    if (password.length < 8) {
      setError('Password must be at least 8 characters.')
      return
    }
    if (password !== confirm) {
      setError('Passwords do not match.')
      return
    }

    setLoading(true)
    try {
      const { error: updateError } = await supabase.auth.updateUser({ password })

      if (updateError) {
        setError(updateError.message)
        return
      }

      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { router.replace('/login'); return }

      const res = await fetch('/api/me')
      const data = await res.json()
      const role = data.employee?.role

      if (role === 'tmc_admin') {
        router.replace('/tmc/dashboard')
      } else if (role === 'admin') {
        router.replace('/dashboard')
      }
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
            You've been invited to manage corporate travel for your organisation.
          </p>
        </div>
        <p style={styles.panelFooter}>© {new Date().getFullYear()} Amadeus IT Group</p>
      </div>

      <div style={styles.formPanel}>
        <div style={styles.card}>
          <h1 style={styles.heading}>Set your password</h1>
          <p style={styles.sub}>
            Choose a password to secure your TravelDesk account.
          </p>

          <form onSubmit={handleSubmit} style={styles.form}>
            <div style={styles.field}>
              <label style={styles.label} htmlFor="password">Password</label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="Min. 8 characters"
                required
                disabled={!sessionReady}
                style={styles.input}
              />
            </div>

            <div style={styles.field}>
              <label style={styles.label} htmlFor="confirm">Confirm password</label>
              <input
                id="confirm"
                type="password"
                value={confirm}
                onChange={e => setConfirm(e.target.value)}
                placeholder="Repeat your password"
                required
                disabled={!sessionReady}
                style={styles.input}
              />
            </div>

            {error && <p style={styles.error}>{error}</p>}

            <button
              type="submit"
              disabled={loading || !sessionReady}
              style={{
                ...styles.button,
                opacity: loading || !sessionReady ? 0.6 : 1,
                cursor: loading || !sessionReady ? 'not-allowed' : 'pointer',
              }}
            >
              {loading ? 'Setting password…' : 'Set password & continue →'}
            </button>
          </form>
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
  form: { display: 'flex', flexDirection: 'column', gap: '20px' },
  field: { display: 'flex', flexDirection: 'column', gap: '6px' },
  label: { fontSize: '13px', fontWeight: 500, color: '#374151' },
  input: {
    height: '42px', padding: '0 12px',
    fontSize: '14px', color: '#0A0A14',
    background: '#fff', border: '1px solid #D1D5DB',
    borderRadius: '8px', outline: 'none',
  },
  error: {
    fontSize: '13px', color: '#DC2626',
    background: '#FEF2F2', border: '1px solid #FECACA',
    borderRadius: '6px', padding: '10px 12px', margin: 0,
  },
  button: {
    height: '42px', background: '#000835', color: '#fff',
    fontSize: '14px', fontWeight: 600,
    border: 'none', borderRadius: '8px', marginTop: '4px',
  },
}