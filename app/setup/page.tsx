'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'

const STEPS = [
  { id: 1, label: 'Confirm details', desc: 'Pre-filled by your TMC' },
  { id: 2, label: 'Travel policy',   desc: 'Inherited defaults' },
  { id: 3, label: 'Invite team',     desc: 'Optional' },
]

interface CompanyDetails {
  name: string
  timezone: string
  currency: string
  country: string
}

export default function SetupStep1() {
  const router = useRouter()
  const [details, setDetails] = useState<CompanyDetails | null>(null)
  const [loading, setLoading] = useState(true)
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    async function fetchDetails() {
      try {
        const res = await fetch('/api/me')
        const data = await res.json()
        setDetails({
          name:     data.company?.name ?? '',
          timezone: data.company?.settings?.timezone ?? 'Asia/Kolkata',
          currency: data.company?.settings?.currency ?? 'INR',
          country:  data.company?.settings?.country  ?? '',
        })
      } catch {
        setError('Could not load your company details. Please try again.')
      } finally {
        setLoading(false)
      }
    }
    fetchDetails()
  }, [])

  async function handleConfirm() {
    setConfirming(true)
    setError('')
    try {
      const res = await fetch('/api/setup/company', { method: 'POST' })
      if (!res.ok) {
        const d = await res.json()
        setError(d.error || 'Something went wrong.')
        return
      }
      router.push('/setup/policy')
    } finally {
      setConfirming(false)
    }
  }

  return (
    <div style={styles.root}>
      <Sidebar currentStep={1} />

      <div style={styles.main}>
        <div style={styles.content}>

          <div style={styles.header}>
            <p style={styles.eyebrow}>Step 1 of 3</p>
            <h1 style={styles.heading}>Confirm your details</h1>
            <p style={styles.sub}>
              These details were set up by your TMC. If anything looks wrong,
              contact them — you won't need to change anything here.
            </p>
          </div>

          {loading ? (
            <div style={styles.card}>
              {[1, 2, 3, 4].map(i => (
                <div key={i} style={{
                  ...styles.row,
                  borderBottom: i < 4 ? '1px solid #F3F4F6' : 'none',
                }}>
                  <div style={styles.skeletonLabel} />
                  <div style={styles.skeletonValue} />
                </div>
              ))}
            </div>
          ) : details ? (
            <div style={styles.card}>
              <DetailRow label="Company"  value={details.name}     />
              <DetailRow label="Country"  value={details.country}  />
              <DetailRow label="Currency" value={details.currency} />
              <DetailRow label="Timezone" value={details.timezone} last />
            </div>
          ) : null}

          {error && <p style={styles.error}>{error}</p>}

          <button
            onClick={handleConfirm}
            disabled={confirming || loading || !details}
            style={{
              ...styles.btn,
              opacity: confirming || loading || !details ? 0.6 : 1,
              cursor: confirming || loading || !details ? 'not-allowed' : 'pointer',
            }}
          >
            {confirming ? 'Confirming…' : 'Looks good, continue →'}
          </button>

          <p style={styles.helpText}>
            Something incorrect?{' '}
            <a href="mailto:support@traveldesk.com" style={styles.link}>
              Contact your TMC
            </a>
          </p>

        </div>
      </div>
    </div>
  )
}

function DetailRow({ label, value, last }: {
  label: string
  value: string
  last?: boolean
}) {
  return (
    <div style={{
      ...styles.row,
      borderBottom: last ? 'none' : '1px solid #F3F4F6',
    }}>
      <span style={styles.rowLabel}>{label}</span>
      <span style={styles.rowValue}>
        {value || <span style={styles.empty}>Not set</span>}
      </span>
    </div>
  )
}

function Sidebar({ currentStep }: { currentStep: number }) {
  return (
    <div style={sidebar.root}>
      <div>
        <div style={sidebar.wordmark}>
          <span style={sidebar.wmMain}>TravelDesk</span>
          <span style={sidebar.wmBy}>by Amadeus</span>
        </div>
        <p style={sidebar.sectionLabel}>Account setup</p>
        <div style={sidebar.steps}>
          {STEPS.map((step, i) => {
            const done   = currentStep > step.id
            const active = currentStep === step.id
            return (
              <div key={step.id}>
                {i > 0 && (
                  <div style={{
                    ...sidebar.connector,
                    background: done || active
                      ? 'rgba(255,255,255,0.35)'
                      : 'rgba(255,255,255,0.1)',
                  }} />
                )}
                <div style={sidebar.stepRow}>
                  <div style={{
                    ...sidebar.dot,
                    background:  done ? '#22C55E' : active ? '#fff' : 'transparent',
                    borderColor: done ? '#22C55E' : active ? '#fff' : 'rgba(255,255,255,0.22)',
                  }}>
                    {done
                      ? <span style={sidebar.check}>✓</span>
                      : <span style={{
                          ...sidebar.num,
                          color: active ? '#000835' : 'rgba(255,255,255,0.3)',
                          fontWeight: active ? 600 : 400,
                        }}>{step.id}</span>
                    }
                  </div>
                  <div>
                    <p style={{
                      ...sidebar.stepLabel,
                      color: active ? '#fff'
                           : done   ? 'rgba(255,255,255,0.65)'
                           :          'rgba(255,255,255,0.3)',
                      fontWeight: active ? 500 : 400,
                    }}>{step.label}</p>
                    <p style={{
                      ...sidebar.stepDesc,
                      color: active
                        ? 'rgba(255,255,255,0.5)'
                        : 'rgba(255,255,255,0.2)',
                    }}>{step.desc}</p>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </div>
      <p style={sidebar.footer}>© {new Date().getFullYear()} Amadeus IT Group</p>
    </div>
  )
}

const sidebar: Record<string, React.CSSProperties> = {
  root: {
    width: '260px', flexShrink: 0, background: '#000835',
    display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
    padding: '40px 28px',
  },
  wordmark: { display: 'flex', flexDirection: 'column', gap: '3px', marginBottom: '36px' },
  wmMain: { fontSize: '20px', fontWeight: 600, color: '#fff', letterSpacing: '-0.4px' },
  wmBy: {
    fontSize: '10px', color: 'rgba(255,255,255,0.35)',
    letterSpacing: '0.6px', textTransform: 'uppercase' as const,
  },
  sectionLabel: {
    fontSize: '9px', fontWeight: 600, color: 'rgba(255,255,255,0.28)',
    letterSpacing: '1.1px', textTransform: 'uppercase' as const,
    margin: '0 0 18px',
  },
  steps:     { display: 'flex', flexDirection: 'column' },
  connector: { width: '1.5px', height: '18px', marginLeft: '12px' },
  stepRow:   { display: 'flex', alignItems: 'center', gap: '12px' },
  dot: {
    width: '26px', height: '26px', borderRadius: '50%', border: '2px solid',
    display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
  },
  check:     { fontSize: '12px', color: '#fff', fontWeight: 700 },
  num:       { fontSize: '11px' },
  stepLabel: { fontSize: '12px', margin: '0 0 1px' },
  stepDesc:  { fontSize: '10px', margin: 0 },
  footer:    { fontSize: '10px', color: 'rgba(255,255,255,0.18)', margin: 0 },
}

const styles: Record<string, React.CSSProperties> = {
  root: {
    display: 'flex', minHeight: '100vh',
    fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
    background: '#F7F8FC',
  },
  main: {
    flex: 1, display: 'flex',
    alignItems: 'center', justifyContent: 'center',
    padding: '48px 40px',
  },
  content: { width: '100%', maxWidth: '380px' },
  header:  { marginBottom: '24px' },
  eyebrow: {
    fontSize: '10px', fontWeight: 600, color: '#9CA3AF',
    letterSpacing: '0.9px', textTransform: 'uppercase' as const,
    margin: '0 0 10px',
  },
  heading: {
    fontSize: '22px', fontWeight: 600, color: '#0A0A14',
    margin: '0 0 8px', letterSpacing: '-0.3px',
  },
  sub: { fontSize: '13px', color: '#6B7280', margin: 0, lineHeight: '1.6' },
  card: {
    background: '#fff', border: '1px solid #E5E7EB',
    borderRadius: '10px', overflow: 'hidden', marginBottom: '20px',
  },
  row: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '12px 16px',
  },
  rowLabel: { fontSize: '12px', color: '#9CA3AF', fontWeight: 500 },
  rowValue: { fontSize: '13px', color: '#111827', fontWeight: 500 },
  empty:    { color: '#D1D5DB', fontStyle: 'italic' as const, fontWeight: 400 },
  skeletonLabel: {
    height: '10px', width: '52px',
    background: '#F3F4F6', borderRadius: '4px',
  },
  skeletonValue: {
    height: '10px', width: '100px',
    background: '#F3F4F6', borderRadius: '4px',
  },
  error: {
    fontSize: '12px', color: '#DC2626',
    background: '#FEF2F2', border: '1px solid #FECACA',
    borderRadius: '6px', padding: '10px 12px', margin: '0 0 16px',
  },
  btn: {
    width: '100%', height: '40px',
    background: '#000835', color: '#fff',
    fontSize: '13px', fontWeight: 600,
    border: 'none', borderRadius: '8px',
    marginBottom: '14px',
  },
  helpText: {
    fontSize: '12px', color: '#9CA3AF',
    textAlign: 'center' as const, margin: 0,
  },
  link: { color: '#6B7280', fontWeight: 500 },
}