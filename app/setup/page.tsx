'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

// ─── Wizard sidebar steps definition ─────────────────────────────────────────
const STEPS = [
  { id: 1, label: 'Your company',    desc: 'Basic details' },
  { id: 2, label: 'Travel policy',   desc: 'Pre-filled defaults' },
  { id: 3, label: 'Invite team',     desc: 'Optional' },
]

// ─── Types ────────────────────────────────────────────────────────────────────
interface CompanyForm {
  size: string
  currency: string
  timezone: string
  country: string
}

export default function SetupStep1() {
  const router = useRouter()
  const [form, setForm] = useState<CompanyForm>({
    size: '',
    currency: 'INR',
    timezone: 'Asia/Kolkata',
    country: 'India',
  })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  function handleChange(e: React.ChangeEvent<HTMLSelectElement | HTMLInputElement>) {
    setForm(prev => ({ ...prev, [e.target.name]: e.target.value }))
  }

  async function handleNext() {
    if (!form.size) { setError('Please select a company size to continue.'); return }
    setError('')
    setLoading(true)
    try {
      const res = await fetch('/api/setup/company', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      if (!res.ok) {
        const d = await res.json()
        setError(d.error || 'Something went wrong.')
        return
      }
      router.push('/setup/policy')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={styles.root}>
      <Sidebar currentStep={1} />

      <div style={styles.main}>
        <div style={styles.content}>
          <StepHeader
            step="Step 1 of 3"
            title="Tell us about your company"
            subtitle="We use this to set sensible defaults. You can change everything later in Settings."
          />

          <div style={styles.fieldGroup}>
            <Field label="Company size">
              <select
                name="size"
                value={form.size}
                onChange={handleChange}
                style={styles.select}
              >
                <option value="" disabled>Select size…</option>
                <option value="1-50">1 – 50 employees</option>
                <option value="51-200">51 – 200 employees</option>
                <option value="201-1000">201 – 1,000 employees</option>
                <option value="1001+">1,000+ employees</option>
              </select>
            </Field>

            <Field label="Primary currency">
              <select
                name="currency"
                value={form.currency}
                onChange={handleChange}
                style={styles.select}
              >
                <option value="INR">INR — Indian Rupee</option>
                <option value="USD">USD — US Dollar</option>
                <option value="GBP">GBP — British Pound</option>
                <option value="EUR">EUR — Euro</option>
                <option value="AED">AED — UAE Dirham</option>
                <option value="SGD">SGD — Singapore Dollar</option>
              </select>
            </Field>

            <Field label="Country">
              <select
                name="country"
                value={form.country}
                onChange={handleChange}
                style={styles.select}
              >
                <option value="India">India</option>
                <option value="United States">United States</option>
                <option value="United Kingdom">United Kingdom</option>
                <option value="UAE">UAE</option>
                <option value="Singapore">Singapore</option>
                <option value="Australia">Australia</option>
                <option value="Other">Other</option>
              </select>
            </Field>

            <Field label="Timezone">
              <select
                name="timezone"
                value={form.timezone}
                onChange={handleChange}
                style={styles.select}
              >
                <option value="Asia/Kolkata">Asia/Kolkata — IST (UTC+5:30)</option>
                <option value="America/New_York">America/New_York — EST (UTC-5)</option>
                <option value="Europe/London">Europe/London — GMT (UTC+0)</option>
                <option value="Asia/Dubai">Asia/Dubai — GST (UTC+4)</option>
                <option value="Asia/Singapore">Asia/Singapore — SGT (UTC+8)</option>
                <option value="Australia/Sydney">Australia/Sydney — AEST (UTC+10)</option>
              </select>
            </Field>
          </div>

          {error && <p style={styles.error}>{error}</p>}

          <div style={styles.actions}>
            <button
              onClick={handleNext}
              disabled={loading}
              style={{ ...styles.primaryBtn, opacity: loading ? 0.7 : 1 }}
            >
              {loading ? 'Saving…' : 'Continue →'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Shared sub-components ────────────────────────────────────────────────────

export function Sidebar({ currentStep }: { currentStep: number }) {
  return (
    <div style={sidebarStyles.sidebar}>
      <div>
        <div style={sidebarStyles.wordmark}>
          <span style={sidebarStyles.wordmarkMain}>TravelDesk</span>
          <span style={sidebarStyles.wordmarkBy}>by Amadeus</span>
        </div>

        <p style={sidebarStyles.sectionLabel}>ACCOUNT SETUP</p>

        <div style={sidebarStyles.steps}>
          {STEPS.map((step, i) => {
            const done = currentStep > step.id
            const active = currentStep === step.id
            return (
              <div key={step.id} style={sidebarStyles.stepRow}>
                {/* Connector line above (not for first) */}
                {i > 0 && (
                  <div style={{
                    ...sidebarStyles.connector,
                    backgroundColor: done || active ? 'rgba(255,255,255,0.4)' : 'rgba(255,255,255,0.12)',
                  }} />
                )}
                <div style={sidebarStyles.stepInner}>
                  <div style={{
                    ...sidebarStyles.stepDot,
                    backgroundColor: done ? '#22C55E' : active ? '#FFFFFF' : 'transparent',
                    borderColor: done ? '#22C55E' : active ? '#FFFFFF' : 'rgba(255,255,255,0.25)',
                  }}>
                    {done
                      ? <span style={sidebarStyles.checkmark}>✓</span>
                      : <span style={{
                          ...sidebarStyles.dotNum,
                          color: active ? '#000835' : 'rgba(255,255,255,0.35)',
                          fontWeight: active ? '700' : '400',
                        }}>{step.id}</span>
                    }
                  </div>
                  <div>
                    <p style={{
                      ...sidebarStyles.stepLabel,
                      color: active ? '#FFFFFF' : done ? 'rgba(255,255,255,0.7)' : 'rgba(255,255,255,0.35)',
                      fontWeight: active ? '600' : '400',
                    }}>
                      {step.label}
                    </p>
                    <p style={{
                      ...sidebarStyles.stepDesc,
                      color: active ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.25)',
                    }}>
                      {step.desc}
                    </p>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      <p style={sidebarStyles.footer}>© {new Date().getFullYear()} Amadeus IT Group</p>
    </div>
  )
}

export function StepHeader({
  step, title, subtitle,
}: { step: string; title: string; subtitle: string }) {
  return (
    <div style={styles.header}>
      <p style={styles.stepLabel}>{step}</p>
      <h1 style={styles.heading}>{title}</h1>
      <p style={styles.subheading}>{subtitle}</p>
    </div>
  )
}

export function Field({
  label, children,
}: { label: string; children: React.ReactNode }) {
  return (
    <div style={styles.field}>
      <label style={styles.fieldLabel}>{label}</label>
      {children}
    </div>
  )
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const sidebarStyles: Record<string, React.CSSProperties> = {
  sidebar: {
    width: '280px',
    flexShrink: 0,
    backgroundColor: '#000835',
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'space-between',
    padding: '48px 32px',
  },
  wordmark: { display: 'flex', flexDirection: 'column', gap: '4px', marginBottom: '40px' },
  wordmarkMain: { fontSize: '22px', fontWeight: '700', color: '#FFFFFF', letterSpacing: '-0.5px' },
  wordmarkBy: {
    fontSize: '11px', fontWeight: '400', color: 'rgba(255,255,255,0.4)',
    letterSpacing: '0.6px', textTransform: 'uppercase' as const,
  },
  sectionLabel: {
    fontSize: '10px', fontWeight: '600', color: 'rgba(255,255,255,0.3)',
    letterSpacing: '1.2px', textTransform: 'uppercase' as const,
    marginBottom: '20px', margin: '0 0 20px',
  },
  steps: { display: 'flex', flexDirection: 'column' },
  stepRow: { display: 'flex', flexDirection: 'column' },
  connector: { width: '1.5px', height: '20px', marginLeft: '15px' },
  stepInner: { display: 'flex', alignItems: 'center', gap: '14px' },
  stepDot: {
    width: '30px', height: '30px', borderRadius: '50%',
    border: '2px solid', display: 'flex', alignItems: 'center',
    justifyContent: 'center', flexShrink: 0,
  },
  checkmark: { fontSize: '13px', color: '#FFFFFF', fontWeight: '700' },
  dotNum: { fontSize: '12px' },
  stepLabel: { fontSize: '13px', margin: '0 0 2px' },
  stepDesc: { fontSize: '11px', margin: 0 },
  footer: { fontSize: '11px', color: 'rgba(255,255,255,0.2)', margin: 0 },
}

const styles: Record<string, React.CSSProperties> = {
  root: {
    display: 'flex',
    minHeight: '100vh',
    fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
    backgroundColor: '#F7F8FC',
  },
  main: {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '48px 40px',
  },
  content: { width: '100%', maxWidth: '480px' },
  header: { marginBottom: '36px' },
  stepLabel: {
    fontSize: '11px', fontWeight: '600', color: '#6B7280',
    letterSpacing: '1px', textTransform: 'uppercase' as const,
    margin: '0 0 10px',
  },
  heading: {
    fontSize: '26px', fontWeight: '700', color: '#0A0A14',
    margin: '0 0 8px', letterSpacing: '-0.4px',
  },
  subheading: { fontSize: '14px', color: '#6B7280', margin: 0, lineHeight: '1.6' },
  fieldGroup: { display: 'flex', flexDirection: 'column', gap: '20px' },
  field: { display: 'flex', flexDirection: 'column', gap: '6px' },
  fieldLabel: { fontSize: '13px', fontWeight: '500', color: '#374151' },
  select: {
    height: '42px', padding: '0 12px',
    fontSize: '14px', color: '#0A0A14',
    backgroundColor: '#FFFFFF',
    border: '1px solid #D1D5DB',
    borderRadius: '8px', outline: 'none',
    cursor: 'pointer', appearance: 'auto' as const,
  },
  error: {
    fontSize: '13px', color: '#DC2626',
    backgroundColor: '#FEF2F2', border: '1px solid #FECACA',
    borderRadius: '6px', padding: '10px 12px', margin: '16px 0 0',
  },
  actions: { marginTop: '32px', display: 'flex', justifyContent: 'flex-end' },
  primaryBtn: {
    height: '42px', padding: '0 28px',
    backgroundColor: '#000835', color: '#FFFFFF',
    fontSize: '14px', fontWeight: '600',
    border: 'none', borderRadius: '8px', cursor: 'pointer',
  },
}