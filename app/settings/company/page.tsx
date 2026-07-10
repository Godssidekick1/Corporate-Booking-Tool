'use client'

import { useEffect, useState } from 'react'

interface Company {
  id: string
  name: string
  timezone: string
  currency: string
  country: string | null
  booking_mode: 'sbt' | 'cbt' | 'both'
}

const TIMEZONES = [
  'Asia/Kolkata',
  'Asia/Dubai',
  'Asia/Singapore',
  'Europe/London',
  'America/New_York',
]

const CURRENCIES = ['INR', 'USD', 'EUR', 'GBP', 'AED', 'SGD']

const BOOKING_MODE_LABEL: Record<Company['booking_mode'], string> = {
  sbt: 'Self-Booking Tool (SBT) — employees book their own travel',
  cbt: 'Consultant-Booking Tool (CBT) — a travel counsellor books on your behalf',
  both: 'Hybrid — both SBT and CBT are enabled',
}

export default function SettingsCompanyPage() {
  const [company, setCompany] = useState<Company | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  const [form, setForm] = useState({ name: '', timezone: '', currency: '', country: '' })

  useEffect(() => {
    fetch('/api/me')
      .then(r => r.json())
      .then(data => {
        if (!data.ok || !data.company) {
          setError('Could not load company details.')
          return
        }
        const c: Company = data.company
        setCompany(c)
        setForm({
          name: c.name ?? '',
          timezone: c.timezone ?? 'Asia/Kolkata',
          currency: c.currency ?? 'INR',
          country: c.country ?? '',
        })
      })
      .catch(() => setError('Could not load company details.'))
      .finally(() => setLoading(false))
  }, [])

  function handleChange(e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) {
    setForm(prev => ({ ...prev, [e.target.name]: e.target.value }))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setSuccess('')
    setSaving(true)
    try {
      const res = await fetch('/api/settings/company', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error || 'Could not save changes.')
        return
      }
      setCompany(prev => prev ? { ...prev, ...data.company } : data.company)
      setSuccess('Company details updated.')
    } catch {
      setError('Could not save changes. Please try again.')
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return <div style={s.root}><p style={s.loadingText}>Loading…</p></div>
  }

  return (
    <div style={s.root}>
      <div style={s.header}>
        <h1 style={s.heading}>Company</h1>
        <p style={s.sub}>Basic details about your organisation.</p>
      </div>

      <form onSubmit={handleSubmit} style={s.card}>
        <div style={s.field}>
          <label style={s.label} htmlFor="name">Company name</label>
          <input
            id="name" name="name" type="text" required
            value={form.name} onChange={handleChange}
            style={s.input}
          />
        </div>

        <div style={s.row}>
          <div style={s.field}>
            <label style={s.label} htmlFor="timezone">Timezone</label>
            <select
              id="timezone" name="timezone"
              value={form.timezone} onChange={handleChange}
              style={s.input}
            >
              {TIMEZONES.map(tz => <option key={tz} value={tz}>{tz}</option>)}
            </select>
          </div>

          <div style={s.field}>
            <label style={s.label} htmlFor="currency">Currency</label>
            <select
              id="currency" name="currency"
              value={form.currency} onChange={handleChange}
              style={s.input}
            >
              {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
        </div>

        <div style={s.field}>
          <label style={s.label} htmlFor="country">Country</label>
          <input
            id="country" name="country" type="text"
            value={form.country} onChange={handleChange}
            placeholder="e.g. India"
            style={s.input}
          />
        </div>

        <div style={s.divider} />

        <div style={s.field}>
          <span style={s.label}>Booking mode</span>
          <div style={s.readOnlyBox}>
            <span style={s.readOnlyValue}>
              {company ? BOOKING_MODE_LABEL[company.booking_mode] : '—'}
            </span>
            <span style={s.readOnlyHint}>Set by your TMC. Contact them to change this.</span>
          </div>
        </div>

        {error && <p style={s.error}>{error}</p>}
        {success && <p style={s.success}>{success}</p>}

        <button type="submit" disabled={saving} style={{ ...s.button, opacity: saving ? 0.7 : 1 }}>
          {saving ? 'Saving…' : 'Save changes'}
        </button>
      </form>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  root: { maxWidth: '560px', fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif" },
  loadingText: { fontSize: '13px', color: '#9CA3AF' },
  header: { marginBottom: '20px' },
  heading: { fontSize: '20px', fontWeight: 600, color: '#0A0A14', margin: '0 0 4px', letterSpacing: '-0.3px' },
  sub: { fontSize: '13px', color: '#6B7280', margin: 0 },
  card: {
    background: '#fff', border: '1px solid #E5E7EB', borderRadius: '10px',
    padding: '24px', display: 'flex', flexDirection: 'column', gap: '18px',
  },
  row: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' },
  field: { display: 'flex', flexDirection: 'column', gap: '6px' },
  label: { fontSize: '12px', fontWeight: 500, color: '#374151' },
  input: {
    height: '38px', padding: '0 10px', fontSize: '13px', color: '#111827',
    background: '#fff', border: '1px solid #D1D5DB', borderRadius: '7px', outline: 'none',
  },
  divider: { height: '1px', background: '#F3F4F6', margin: '2px 0' },
  readOnlyBox: {
    background: '#F9FAFB', border: '1px solid #E5E7EB', borderRadius: '7px',
    padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: '3px',
  },
  readOnlyValue: { fontSize: '13px', color: '#374151', fontWeight: 500 },
  readOnlyHint: { fontSize: '11px', color: '#9CA3AF' },
  error: {
    fontSize: '13px', color: '#DC2626', background: '#FEF2F2',
    border: '1px solid #FECACA', borderRadius: '6px', padding: '10px 12px', margin: 0,
  },
  success: {
    fontSize: '13px', color: '#065F46', background: '#ECFDF5',
    border: '1px solid #A7F3D0', borderRadius: '6px', padding: '10px 12px', margin: 0,
  },
  button: {
    height: '38px', background: '#000835', color: '#fff', fontSize: '13px', fontWeight: 600,
    border: 'none', borderRadius: '8px', cursor: 'pointer', alignSelf: 'flex-start', padding: '0 18px',
  },
}