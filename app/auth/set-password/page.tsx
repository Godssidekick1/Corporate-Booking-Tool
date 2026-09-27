'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import AuthShell, { authStyles as s } from '@/app/components/AuthShell'
import PasswordInput from '@/app/components/PasswordInput'

// ── /auth/set-password ───────────────────────────────────────────────────────
// Replacing a starting password an admin chose. proxy.ts sends anyone whose
// account has must_change_password here from every protected page, until they
// have. The flag is a server-owned column now. It used to sit in GoTrue's
// user_metadata, where the user could clear it on themselves and skip this.
//
// The starting password is asked for again: /api/auth/password/change always
// requires the current one.
//
// Invite and reset links do not come here; they set a password on
// /auth/confirm.
// ─────────────────────────────────────────────────────────────────────────────

const MIN = 8

export default function SetPasswordPage() {
  const router = useRouter()
  const [current, setCurrent] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    if (password.length < MIN) { setError(`Password must be at least ${MIN} characters.`); return }
    if (password !== confirm) { setError('Passwords do not match.'); return }

    setLoading(true)
    let navigating = false
    try {
      const res = await fetch('/api/auth/password/change', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: current, newPassword: password }),
      })
      if (res.status === 401) { navigating = true; router.replace('/login'); return }
      const data = await res.json()
      if (!res.ok) { setError(data.error || 'Something went wrong. Please try again.'); return }

      const me = await (await fetch('/api/me')).json()
      const role = me.employee?.role
      navigating = true
      router.replace(role === 'tmc_admin' || role === 'tc' ? '/tmc/dashboard' : '/dashboard')
    } catch {
      setError('Something went wrong. Please check your connection and try again.')
    } finally {
      if (!navigating) setLoading(false)
    }
  }

  return (
    <AuthShell tagline="Your administrator set a starting password for you. Replace it with one only you know.">
      <h1 style={s.heading}>Choose your password</h1>
      <p style={s.sub}>Enter the starting password you were given, then a new one of at least {MIN} characters.</p>

      <form onSubmit={handleSubmit} style={s.form}>
        <div style={s.field}>
          <label style={s.label} htmlFor="current">Starting password</label>
          <PasswordInput id="current" autoComplete="current-password" value={current} onChange={setCurrent}
            required style={s.input} />
        </div>
        <div style={s.field}>
          <label style={s.label} htmlFor="password">New password</label>
          <PasswordInput id="password" autoComplete="new-password" value={password} onChange={setPassword}
            placeholder={`Min. ${MIN} characters`} required style={s.input} />
        </div>
        <div style={s.field}>
          <label style={s.label} htmlFor="confirm">Confirm new password</label>
          <PasswordInput id="confirm" autoComplete="new-password" value={confirm} onChange={setConfirm}
            placeholder="Repeat your password" required style={s.input} />
        </div>

        {error && <p style={s.error}>{error}</p>}

        <button type="submit" disabled={loading} style={{ ...s.button, opacity: loading ? 0.6 : 1 }}>
          {loading ? 'Saving…' : 'Save password & continue →'}
        </button>
      </form>
    </AuthShell>
  )
}
