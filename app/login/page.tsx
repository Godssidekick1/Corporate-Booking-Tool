'use client'

import { useState, useEffect } from 'react'
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

  useEffect(() => {
    if (typeof window === 'undefined') return
    const hash = window.location.hash
    if (!hash.includes('access_token')) return

    const params = new URLSearchParams(hash.slice(1))
    const type = params.get('type')
    const accessToken = params.get('access_token')
    const refreshToken = params.get('refresh_token')
    if (!accessToken || !refreshToken) return

    supabase.auth.setSession({ access_token: accessToken, refresh_token: refreshToken })
      .then(({ error }) => {
        if (error) { console.error('Session error:', error.message); return }
        if (type === 'invite') {
          router.replace('/auth/set-password')
        } else {
          redirectByRole()
        }
      })
  }, [router])

  async function redirectByRole() {
    const res = await fetch('/api/me')
    const data = await res.json()
    const role = data.employee?.role

    if (role === 'tmc_admin' || role === 'tc') {
      router.push('/tmc/dashboard')
    } else if (role === 'admin') {
      router.push('/dashboard')
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const res = await fetch('/api/auth/signin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error || 'Sign in failed'); return }
      await redirectByRole()
    } catch {
      setError('Something went wrong. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={styles.root}>
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
              <label style={styles.label} htmlFor="password">Password</label>
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
        </div>
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  root: { display: 'flex', minHeight: '100vh', fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif", backgroundColor: '#F7F8FC' },
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
  label: { fontSize: '13px', fontWeight: '500', color: '#374151' },
  input: { height: '42px', padding: '0 12px', fontSize: '14px', color: '#0A0A14', backgroundColor: '#FFFFFF', border: '1px solid #D1D5DB', borderRadius: '8px', outline: 'none' },
  error: { fontSize: '13px', color: '#DC2626', backgroundColor: '#FEF2F2', border: '1px solid #FECACA', borderRadius: '6px', padding: '10px 12px', margin: 0 },
  button: { height: '42px', backgroundColor: '#000835', color: '#FFFFFF', fontSize: '14px', fontWeight: '600', border: 'none', borderRadius: '8px', cursor: 'pointer', marginTop: '4px' },
}