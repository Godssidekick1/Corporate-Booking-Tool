'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import TmcShell from '@/app/components/TmcShell'

interface Company {
  id: string
  name: string
  status: string
  setup_completed: boolean
  timezone: string
  currency: string
  country: string | null
  booking_mode: 'sbt' | 'cbt' | 'both'
  branch_id: string | null
  created_at: string
}

interface Branch {
  id: string
  name: string
  city: string | null
}

const TIMEZONES = ['Asia/Kolkata', 'Asia/Dubai', 'Asia/Singapore', 'Europe/London', 'America/New_York']
const CURRENCIES = ['INR']
const BOOKING_MODES: { value: Company['booking_mode']; label: string }[] = [
  { value: 'sbt', label: 'SBT — Self-Booking Tool' },
  { value: 'cbt', label: 'CBT — Consultant-Booking Tool' },
  { value: 'both', label: 'Hybrid — Both SBT and CBT' },
]

export default function TmcCompanyDetailPage() {
  const params = useParams()
  const companyId = params.id as string

  const [company, setCompany] = useState<Company | null>(null)
  const [branches, setBranches] = useState<Branch[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  const [form, setForm] = useState({
    name: '', timezone: '', currency: '', country: '', booking_mode: 'sbt' as Company['booking_mode'], branch_id: '',
  })

  useEffect(() => {
    Promise.all([
      fetch(`/api/tmc/companies/${companyId}`).then(r => r.json()),
      fetch('/api/tmc/branches').then(r => r.json()),
    ]).then(([companyData, branchesData]) => {
        if (!companyData.ok) {
          setError(companyData.error || 'Could not load company.')
          return
        }
        const c: Company = companyData.company
        setCompany(c)
        setForm({
          name: c.name ?? '',
          timezone: c.timezone ?? 'Asia/Kolkata',
          currency: c.currency ?? 'INR',
          country: c.country ?? '',
          booking_mode: c.booking_mode ?? 'sbt',
          branch_id: c.branch_id ?? '',
        })
        if (branchesData.ok) setBranches(branchesData.branches)
      })
      .catch(() => setError('Could not load company.'))
      .finally(() => setLoading(false))
  }, [companyId])

  function handleChange(e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) {
    setForm(prev => ({ ...prev, [e.target.name]: e.target.value }))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setSuccess('')
    setSaving(true)
    try {
      const res = await fetch(`/api/tmc/companies/${companyId}`, {
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
      setSuccess('Company updated.')
    } catch {
      setError('Could not save changes. Please try again.')
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return <TmcShell activeLabel="Companies"><div style={s.root}><p style={s.loadingText}>Loading…</p></div></TmcShell>
  }

  if (!company) {
    return <TmcShell activeLabel="Companies"><div style={s.root}><p style={s.error}>{error || 'Company not found.'}</p></div></TmcShell>
  }

  return (
    <TmcShell activeLabel="Companies">
    <div style={s.root}>
      <div style={s.header}>
        <a href="/tmc/companies" style={s.backLink}>← All companies</a>
        <h1 style={s.heading}>{company.name}</h1>
        <p style={s.sub}>Manage this client's account details, currency, and booking mode.</p>
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
            <select id="timezone" name="timezone" value={form.timezone} onChange={handleChange} style={s.input}>
              {TIMEZONES.map(tz => <option key={tz} value={tz}>{tz}</option>)}
            </select>
          </div>

          <div style={s.field}>
            <label style={s.label} htmlFor="currency">Currency</label>
            <select
              id="currency" name="currency" value={form.currency} onChange={handleChange}
              disabled={CURRENCIES.length === 1}
              style={{ ...s.input, opacity: CURRENCIES.length === 1 ? 0.6 : 1 }}
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

        <div style={s.field}>
          <label style={s.label} htmlFor="branch_id">Branch</label>
          {branches.length === 0 ? (
            <p style={s.hint}>
              No branches yet — <a href="/tmc/settings/branches" style={s.inlineLink}>create one</a> to assign this company.
            </p>
          ) : (
            <select id="branch_id" name="branch_id" value={form.branch_id} onChange={handleChange} style={s.input}>
              <option value="">Unassigned</option>
              {branches.map(b => (
                <option key={b.id} value={b.id}>{b.name}{b.city ? ` — ${b.city}` : ''}</option>
              ))}
            </select>
          )}
        </div>

        <div style={s.divider} />

        <div style={s.field}>
          <label style={s.label} htmlFor="booking_mode">Booking mode</label>
          <select id="booking_mode" name="booking_mode" value={form.booking_mode} onChange={handleChange} style={s.input}>
            {BOOKING_MODES.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
          <p style={s.hint}>
            This determines whether the corporate's employees book for themselves (SBT),
            travel counsellors book on their behalf (CBT), or both. Only you can change this.
          </p>
        </div>

        {error && <p style={s.errorMsg}>{error}</p>}
        {success && <p style={s.success}>{success}</p>}

        <button type="submit" disabled={saving} style={{ ...s.button, opacity: saving ? 0.7 : 1 }}>
          {saving ? 'Saving…' : 'Save changes'}
        </button>
      </form>
    </div>
    </TmcShell>
  )
}

const s: Record<string, React.CSSProperties> = {
  root: { maxWidth: '600px', fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif", padding: '32px 40px' },
  loadingText: { fontSize: '13px', color: '#9CA3AF' },
  header: { marginBottom: '20px' },
  backLink: { fontSize: '12px', color: '#9CA3AF', textDecoration: 'none', display: 'block', marginBottom: '10px' },
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
  hint: { fontSize: '11px', color: '#9CA3AF', margin: '4px 0 0', lineHeight: '1.5' },
  inlineLink: { color: '#000835', fontWeight: 600, textDecoration: 'underline' },
  errorMsg: {
    fontSize: '13px', color: '#DC2626', background: '#FEF2F2',
    border: '1px solid #FECACA', borderRadius: '6px', padding: '10px 12px', margin: 0,
  },
  error: { fontSize: '13px', color: '#DC2626' },
  success: {
    fontSize: '13px', color: '#065F46', background: '#ECFDF5',
    border: '1px solid #A7F3D0', borderRadius: '6px', padding: '10px 12px', margin: 0,
  },
  button: {
    height: '38px', background: '#000835', color: '#fff', fontSize: '13px', fontWeight: 600,
    border: 'none', borderRadius: '8px', cursor: 'pointer', alignSelf: 'flex-start', padding: '0 18px',
  },
}