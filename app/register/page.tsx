'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'

// ── Default data shown in the wizard ──────────────────────────────────────────

const DEFAULT_BANDS = [
  { code: 'L1', label: 'Junior',    rank: 1 },
  { code: 'L2', label: 'Associate', rank: 2 },
  { code: 'L3', label: 'Senior',    rank: 3 },
  { code: 'L4', label: 'Manager',   rank: 4 },
  { code: 'L5', label: 'Director',  rank: 5 },
]

const TRAVEL_TYPES = [
  { key: 'flight_domestic',      label: 'Domestic flight' },
  { key: 'flight_international', label: 'International flight' },
  { key: 'hotel',                label: 'Hotel (per night)' },
]

const DEFAULT_LIMITS: Record<string, Record<string, number>> = {
  L1: { flight_domestic: 8000,   flight_international: 60000,  hotel: 4000  },
  L2: { flight_domestic: 10000,  flight_international: 80000,  hotel: 5500  },
  L3: { flight_domestic: 15000,  flight_international: 120000, hotel: 8000  },
  L4: { flight_domestic: 25000,  flight_international: 200000, hotel: 12000 },
  L5: { flight_domestic: 40000,  flight_international: 300000, hotel: 20000 },
}

const ENTITLEMENTS = [
  { key: 'business_class',        label: 'Business class' },
  { key: 'premium_economy',       label: 'Premium economy' },
  { key: 'breakfast_included',    label: 'Breakfast included' },
  { key: 'personal_travel',       label: 'Personal travel' },
]

const DEFAULT_ENTITLEMENTS: Record<string, Record<string, boolean>> = {
  L1: { business_class: false, premium_economy: false, breakfast_included: false, personal_travel: false },
  L2: { business_class: false, premium_economy: false, breakfast_included: true,  personal_travel: false },
  L3: { business_class: false, premium_economy: true,  breakfast_included: true,  personal_travel: false },
  L4: { business_class: true,  premium_economy: true,  breakfast_included: true,  personal_travel: true  },
  L5: { business_class: true,  premium_economy: true,  breakfast_included: true,  personal_travel: true  },
}

type Step = 1 | 2 | 3

export default function RegisterPage() {
  const router = useRouter()
  const [step, setStep] = useState<Step>(1)
  const [form, setForm] = useState({ companyName: '', fullName: '', email: '', password: '' })
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    setForm(prev => ({ ...prev, [e.target.name]: e.target.value }))
  }

  function validateStep1() {
    if (!form.companyName.trim()) return 'Company name is required'
    if (!form.fullName.trim()) return 'Your name is required'
    if (!form.email.trim()) return 'Work email is required'
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) return 'Enter a valid email address'
    if (form.password.length < 8) return 'Password must be at least 8 characters'
    return null
  }

  function handleNext() {
    const err = validateStep1()
    if (err) { setError(err); return }
    setError('')
    setStep(2)
  }

  async function handleSubmit() {
    setError('')
    setLoading(true)
    try {
      const res = await fetch('/api/auth/register-company', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error || 'Registration failed'); setLoading(false); return }

      const signinRes = await fetch('/api/auth/signin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: form.email, password: form.password }),
      })
      router.push(signinRes.ok ? '/dashboard' : '/login')
    } catch {
      setError('Something went wrong. Please try again.')
      setLoading(false)
    }
  }

  return (
    <div style={s.root}>
      {/* Left panel */}
      <div style={s.panel}>
        <div style={s.panelTop}>
          <div style={s.wordmark}>
            <span style={s.wordmarkMain}>TravelDesk</span>
            <span style={s.wordmarkSub}>by Amadeus</span>
          </div>
          <p style={s.tagline}>Set up your company in minutes. Manage travel policy, approvals, and bookings — all in one place.</p>
        </div>
        <div style={s.steps}>
          {(['Account', 'Bands', 'Policy'] as const).map((label, i) => {
            const n = (i + 1) as Step
            const active = step === n
            const done = step > n
            return (
              <div key={label} style={s.stepRow}>
                <div style={{
                  ...s.stepDot,
                  backgroundColor: done ? '#0066CC' : active ? '#FFFFFF' : 'transparent',
                  borderColor: done ? '#0066CC' : active ? '#FFFFFF' : 'rgba(255,255,255,0.25)',
                }}>
                  {done
                    ? <span style={{ color: '#fff', fontSize: '10px' }}>✓</span>
                    : <span style={{ color: active ? '#000835' : 'rgba(255,255,255,0.4)', fontSize: '11px', fontWeight: 700 }}>{n}</span>
                  }
                </div>
                <span style={{ fontSize: '13px', fontWeight: active ? 600 : 400, color: active ? '#FFFFFF' : done ? 'rgba(255,255,255,0.7)' : 'rgba(255,255,255,0.35)' }}>
                  {label}
                </span>
              </div>
            )
          })}
        </div>
        <p style={s.panelFooter}>© {new Date().getFullYear()} Amadeus IT Group</p>
      </div>

      {/* Right panel */}
      <div style={s.right}>
        <div style={s.card}>

          {step === 1 && (
            <>
              <h1 style={s.heading}>Create your account</h1>
              <p style={s.sub}>You'll be set up as the company admin.</p>
              <div style={s.form}>
                <Field label="Company name" id="companyName">
                  <input id="companyName" name="companyName" type="text" required value={form.companyName} onChange={handleChange} style={s.input} placeholder="Acme Corp" />
                </Field>
                <Field label="Your full name" id="fullName">
                  <input id="fullName" name="fullName" type="text" required value={form.fullName} onChange={handleChange} style={s.input} placeholder="Jane Smith" />
                </Field>
                <Field label="Work email" id="email">
                  <input id="email" name="email" type="email" required value={form.email} onChange={handleChange} style={s.input} placeholder="jane@acmecorp.com" />
                </Field>
                <Field label="Password" id="password" hint="Min. 8 characters">
                  <input id="password" name="password" type="password" required minLength={8} value={form.password} onChange={handleChange} style={s.input} placeholder="••••••••" />
                  <PasswordStrength password={form.password} />
                </Field>
                {error && <ErrorBox message={error} />}
                <button style={s.btn} onClick={handleNext}>Continue →</button>
              </div>
              <p style={s.footerNote}>Already have an account? <Link href="/login" style={s.link}>Sign in</Link></p>
            </>
          )}

          {step === 2 && (
            <>
              <h1 style={s.heading}>Employee bands</h1>
              <p style={s.sub}>TravelDesk uses five default bands to apply travel policies. You can rename them from company settings at any time.</p>
              <div style={s.table}>
                <div style={s.tableHead}>
                  <span style={{ ...s.tableCell, ...s.tableCellFirst }}>Code</span>
                  <span style={s.tableCell}>Label</span>
                  <span style={{ ...s.tableCell, color: '#9CA3AF' }}>Seniority</span>
                </div>
                {DEFAULT_BANDS.map((band, i) => (
                  <div key={band.code} style={{ ...s.tableRow, backgroundColor: i % 2 === 0 ? '#F9FAFB' : '#FFFFFF' }}>
                    <span style={{ ...s.tableCell, ...s.tableCellFirst }}><span style={s.badge}>{band.code}</span></span>
                    <span style={{ ...s.tableCell, fontWeight: 500, color: '#111827' }}>{band.label}</span>
                    <span style={{ ...s.tableCell, color: '#6B7280' }}>{'● '.repeat(band.rank).trim()}</span>
                  </div>
                ))}
              </div>
              <p style={s.hint}>Policy limits and entitlements are set per band — you'll see the defaults on the next screen.</p>
              <div style={s.btnRow}>
                <button style={s.btnGhost} onClick={() => setStep(1)}>← Back</button>
                <button style={s.btn} onClick={() => setStep(3)}>Continue →</button>
              </div>
              <SkipLink onSkip={handleSubmit} loading={loading} />
            </>
          )}

          {step === 3 && (
            <>
              <h1 style={s.heading}>Default travel policy</h1>
              <p style={s.sub}>These limits apply per trip in INR. All values can be changed from company settings.</p>

              <p style={s.sectionLabel}>Spending limits (₹)</p>
              <div style={{ ...s.table, marginBottom: '24px' }}>
                <div style={s.tableHead}>
                  <span style={{ ...s.tableCell, ...s.tableCellFirst }}>Band</span>
                  {TRAVEL_TYPES.map(t => <span key={t.key} style={s.tableCell}>{t.label}</span>)}
                </div>
                {DEFAULT_BANDS.map((band, i) => (
                  <div key={band.code} style={{ ...s.tableRow, backgroundColor: i % 2 === 0 ? '#F9FAFB' : '#FFFFFF' }}>
                    <span style={{ ...s.tableCell, ...s.tableCellFirst }}><span style={s.badge}>{band.code}</span></span>
                    {TRAVEL_TYPES.map(t => (
                      <span key={t.key} style={{ ...s.tableCell, color: '#111827', fontWeight: 500 }}>
                        {DEFAULT_LIMITS[band.code][t.key].toLocaleString('en-IN')}
                      </span>
                    ))}
                  </div>
                ))}
              </div>

              <p style={s.sectionLabel}>Entitlements</p>
              <div style={s.table}>
                <div style={s.tableHead}>
                  <span style={{ ...s.tableCell, ...s.tableCellFirst }}>Band</span>
                  {ENTITLEMENTS.map(e => <span key={e.key} style={{ ...s.tableCell, fontSize: '11px' }}>{e.label}</span>)}
                </div>
                {DEFAULT_BANDS.map((band, i) => (
                  <div key={band.code} style={{ ...s.tableRow, backgroundColor: i % 2 === 0 ? '#F9FAFB' : '#FFFFFF' }}>
                    <span style={{ ...s.tableCell, ...s.tableCellFirst }}><span style={s.badge}>{band.code}</span></span>
                    {ENTITLEMENTS.map(e => (
                      <span key={e.key} style={s.tableCell}>
                        <span style={{ fontSize: '13px', color: DEFAULT_ENTITLEMENTS[band.code][e.key] ? '#16A34A' : '#D1D5DB' }}>
                          {DEFAULT_ENTITLEMENTS[band.code][e.key] ? '✓' : '✕'}
                        </span>
                      </span>
                    ))}
                  </div>
                ))}
              </div>

              {error && <div style={{ marginTop: '16px' }}><ErrorBox message={error} /></div>}

              <div style={{ ...s.btnRow, marginTop: '28px' }}>
                <button style={s.btnGhost} onClick={() => setStep(2)}>← Back</button>
                <button style={{ ...s.btn, opacity: loading ? 0.7 : 1 }} onClick={handleSubmit} disabled={loading}>
                  {loading ? 'Creating account…' : 'Create account'}
                </button>
              </div>
              <SkipLink onSkip={handleSubmit} loading={loading} />
            </>
          )}

        </div>
      </div>
    </div>
  )
}

function Field({ label, id, hint, children }: { label: string; id: string; hint?: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <label htmlFor={id} style={{ fontSize: '13px', fontWeight: 500, color: '#374151' }}>{label}</label>
        {hint && <span style={{ fontSize: '11px', color: '#9CA3AF' }}>{hint}</span>}
      </div>
      {children}
    </div>
  )
}

function PasswordStrength({ password }: { password: string }) {
  const len = password.length
  const strength = len === 0 ? 0 : len < 8 ? 1 : len < 12 ? 2 : 3
  const colors = ['#E5E7EB', '#EF4444', '#F59E0B', '#16A34A']
  const labels = ['', 'Weak', 'Good', 'Strong']
  if (len === 0) return null
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '4px' }}>
      {[1, 2, 3].map(n => (
        <div key={n} style={{ height: '3px', flex: 1, borderRadius: '2px', backgroundColor: n <= strength ? colors[strength] : '#E5E7EB', transition: 'background-color 0.2s' }} />
      ))}
      <span style={{ fontSize: '11px', color: colors[strength], fontWeight: 500, minWidth: 36 }}>{labels[strength]}</span>
    </div>
  )
}

function ErrorBox({ message }: { message: string }) {
  return (
    <p style={{ fontSize: '13px', color: '#DC2626', backgroundColor: '#FEF2F2', border: '1px solid #FECACA', borderRadius: '6px', padding: '10px 12px', margin: 0 }}>
      {message}
    </p>
  )
}

function SkipLink({ onSkip, loading }: { onSkip: () => void; loading: boolean }) {
  return (
    <p style={{ textAlign: 'center', marginTop: '16px', fontSize: '13px', color: '#9CA3AF' }}>
      <button onClick={onSkip} disabled={loading} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9CA3AF', fontSize: '13px', textDecoration: 'underline', padding: 0 }}>
        Skip and use all defaults
      </button>
    </p>
  )
}

const s: Record<string, React.CSSProperties> = {
  root: { display: 'flex', minHeight: '100vh', fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif", backgroundColor: '#F7F8FC' },
  panel: { width: '320px', flexShrink: 0, backgroundColor: '#000835', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', padding: '48px 36px' },
  panelTop: { display: 'flex', flexDirection: 'column', gap: '24px' },
  wordmark: { display: 'flex', flexDirection: 'column', gap: '4px' },
  wordmarkMain: { fontSize: '26px', fontWeight: 700, color: '#FFFFFF', letterSpacing: '-0.5px' },
  wordmarkSub: { fontSize: '12px', color: 'rgba(255,255,255,0.4)', letterSpacing: '0.6px', textTransform: 'uppercase' },
  tagline: { fontSize: '14px', lineHeight: '1.65', color: 'rgba(255,255,255,0.55)', margin: 0, maxWidth: '240px' },
  steps: { display: 'flex', flexDirection: 'column', gap: '16px' },
  stepRow: { display: 'flex', alignItems: 'center', gap: '12px' },
  stepDot: { width: '24px', height: '24px', borderRadius: '50%', border: '1.5px solid', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, transition: 'all 0.2s' },
  panelFooter: { fontSize: '11px', color: 'rgba(255,255,255,0.2)', margin: 0 },
  right: { flex: 1, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '48px 24px', overflowY: 'auto' },
  card: { width: '100%', maxWidth: '580px' },
  heading: { fontSize: '22px', fontWeight: 700, color: '#0A0A14', margin: '0 0 6px', letterSpacing: '-0.3px' },
  sub: { fontSize: '14px', color: '#6B7280', margin: '0 0 28px', lineHeight: '1.5' },
  form: { display: 'flex', flexDirection: 'column', gap: '18px' },
  input: { height: '42px', padding: '0 12px', fontSize: '14px', color: '#0A0A14', backgroundColor: '#FFFFFF', border: '1px solid #D1D5DB', borderRadius: '8px', outline: 'none', width: '100%', boxSizing: 'border-box' },
  btn: { height: '42px', padding: '0 20px', backgroundColor: '#000835', color: '#FFFFFF', fontSize: '14px', fontWeight: 600, border: 'none', borderRadius: '8px', cursor: 'pointer' },
  btnGhost: { height: '42px', padding: '0 20px', backgroundColor: 'transparent', color: '#6B7280', fontSize: '14px', fontWeight: 500, border: '1px solid #D1D5DB', borderRadius: '8px', cursor: 'pointer' },
  btnRow: { display: 'flex', gap: '12px', justifyContent: 'flex-end', marginTop: '24px' },
  footerNote: { fontSize: '13px', color: '#6B7280', textAlign: 'center', marginTop: '20px' },
  link: { color: '#000835', fontWeight: 500, textDecoration: 'none' },
  hint: { fontSize: '13px', color: '#9CA3AF', marginTop: '16px', lineHeight: '1.5' },
  sectionLabel: { fontSize: '12px', fontWeight: 600, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.5px', margin: '0 0 10px' },
  table: { border: '1px solid #E5E7EB', borderRadius: '8px', overflow: 'hidden' },
  tableHead: { display: 'flex', backgroundColor: '#F3F4F6', borderBottom: '1px solid #E5E7EB', padding: '0 12px' },
  tableRow: { display: 'flex', padding: '0 12px', borderBottom: '1px solid #F3F4F6' },
  tableCell: { flex: 1, padding: '10px 8px', fontSize: '13px', color: '#6B7280', display: 'flex', alignItems: 'center' },
  tableCellFirst: { flex: '0 0 56px' },
  badge: { display: 'inline-block', padding: '2px 8px', backgroundColor: '#EFF6FF', color: '#1D4ED8', borderRadius: '4px', fontSize: '12px', fontWeight: 600 },
}