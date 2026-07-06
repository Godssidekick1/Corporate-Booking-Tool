'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

const STEPS = [
  { id: 1, label: 'Your company',  desc: 'Basic details' },
  { id: 2, label: 'Travel policy', desc: 'Pre-filled defaults' },
  { id: 3, label: 'Invite team',   desc: 'Optional' },
]

const ROLES = ['Employee', 'Manager', 'Finance', 'Admin'] as const
type Role = typeof ROLES[number]
const BANDS = ['L1', 'L2', 'L3', 'L4', 'L5'] as const
type Band = typeof BANDS[number]

interface Invite {
  id: number
  email: string
  role: Role
  band: Band
}

let nextId = 2

export default function SetupInvitePage() {
  const router = useRouter()
  const [invites, setInvites] = useState<Invite[]>([
    { id: 1, email: '', role: 'Employee', band: 'L2' },
  ])
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')

  function addRow() {
    setInvites(prev => [...prev, { id: nextId++, email: '', role: 'Employee', band: 'L2' }])
  }

  function removeRow(id: number) {
    setInvites(prev => prev.filter(r => r.id !== id))
  }

  function updateRow(id: number, field: keyof Omit<Invite, 'id'>, value: string) {
    setInvites(prev => prev.map(r => r.id === id ? { ...r, [field]: value } : r))
  }

  async function handleSendInvites() {
    const filled = invites.filter(r => r.email.trim() !== '')
    if (filled.length === 0) {
      // Skip — same as hitting "Skip for now"
      router.push('/dashboard')
      return
    }
    // Basic email validation
    const invalid = filled.find(r => !r.email.includes('@'))
    if (invalid) {
      setError(`"${invalid.email}" doesn't look like a valid email.`)
      return
    }
    setSending(true)
    setError('')
    try {
      const res = await fetch('/api/setup/invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invites: filled }),
      })
      if (!res.ok) {
        const d = await res.json()
        setError(d.error || 'Something went wrong sending invites.')
        return
      }
      router.push('/dashboard')
    } finally {
      setSending(false)
    }
  }

  function handleSkip() {
    router.push('/dashboard')
  }

  const filledCount = invites.filter(r => r.email.trim() !== '').length

  return (
    <div style={styles.root}>
      <Sidebar currentStep={3} />

      <div style={styles.main}>
        <div style={styles.content}>
          {/* Header */}
          <div style={styles.header}>
            <p style={styles.stepLabel}>Step 3 of 3 — Optional</p>
            <h1 style={styles.heading}>Invite your team</h1>
            <p style={styles.subheading}>
              Add team members now while you're set up. You can always do this later from{' '}
              <strong>Settings → Users</strong>. Band assignments control travel entitlements.
            </p>
          </div>

          {/* Invite rows */}
          <div style={styles.inviteCard}>
            {/* Column headers */}
            <div style={styles.columnHeaders}>
              <span style={{ ...styles.colHeader, flex: 3 }}>Work email</span>
              <span style={{ ...styles.colHeader, flex: 1.5 }}>Role</span>
              <span style={{ ...styles.colHeader, flex: 1 }}>Band</span>
              <span style={{ width: '32px' }} /> {/* remove btn placeholder */}
            </div>

            {/* Rows */}
            <div style={styles.rowList}>
              {invites.map((inv) => (
                <div key={inv.id} style={styles.inviteRow}>
                  <input
                    type="email"
                    placeholder="colleague@company.com"
                    value={inv.email}
                    onChange={e => updateRow(inv.id, 'email', e.target.value)}
                    style={{ ...styles.input, flex: 3 }}
                  />
                  <select
                    value={inv.role}
                    onChange={e => updateRow(inv.id, 'role', e.target.value)}
                    style={{ ...styles.select, flex: 1.5 }}
                  >
                    {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
                  </select>
                  <select
                    value={inv.band}
                    onChange={e => updateRow(inv.id, 'band', e.target.value)}
                    style={{ ...styles.select, flex: 1 }}
                  >
                    {BANDS.map(b => <option key={b} value={b}>{b}</option>)}
                  </select>
                  <button
                    onClick={() => removeRow(inv.id)}
                    disabled={invites.length === 1}
                    style={{
                      ...styles.removeBtn,
                      opacity: invites.length === 1 ? 0.3 : 1,
                      cursor: invites.length === 1 ? 'default' : 'pointer',
                    }}
                    aria-label="Remove row"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>

            {/* Add row */}
            <button onClick={addRow} style={styles.addRowBtn}>
              + Add another
            </button>
          </div>

          {/* Role legend */}
          <div style={styles.legend}>
            {[
              { role: 'Employee', desc: 'Can search and request bookings' },
              { role: 'Manager', desc: 'Can approve in-band requests' },
              { role: 'Finance', desc: 'Can approve high-value requests and view reports' },
              { role: 'Admin', desc: 'Full access: settings, users, policy' },
            ].map(item => (
              <div key={item.role} style={styles.legendItem}>
                <span style={styles.legendRole}>{item.role}</span>
                <span style={styles.legendDesc}>{item.desc}</span>
              </div>
            ))}
          </div>

          {error && <p style={styles.error}>{error}</p>}

          {/* Actions */}
          <div style={styles.actions}>
            <button onClick={() => router.push('/setup/policy')} style={styles.backBtn}>
              ← Back
            </button>
            <div style={styles.rightActions}>
              <button onClick={handleSkip} style={styles.skipBtn}>
                Skip for now
              </button>
              <button
                onClick={handleSendInvites}
                disabled={sending}
                style={{ ...styles.primaryBtn, opacity: sending ? 0.7 : 1 }}
              >
                {sending
                  ? 'Sending…'
                  : filledCount > 0
                    ? `Send ${filledCount} invite${filledCount > 1 ? 's' : ''} →`
                    : 'Go to dashboard →'
                }
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Sidebar ──────────────────────────────────────────────────────────────────

function Sidebar({ currentStep }: { currentStep: number }) {
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
                    }}>{step.label}</p>
                    <p style={{
                      ...sidebarStyles.stepDesc,
                      color: active ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.25)',
                    }}>{step.desc}</p>
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

// ─── Styles ───────────────────────────────────────────────────────────────────

const sidebarStyles: Record<string, React.CSSProperties> = {
  sidebar: {
    width: '280px', flexShrink: 0, backgroundColor: '#000835',
    display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
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
    letterSpacing: '1.2px', textTransform: 'uppercase' as const, margin: '0 0 20px',
  },
  steps: { display: 'flex', flexDirection: 'column' },
  stepRow: { display: 'flex', flexDirection: 'column' },
  connector: { width: '1.5px', height: '20px', marginLeft: '15px' },
  stepInner: { display: 'flex', alignItems: 'center', gap: '14px' },
  stepDot: {
    width: '30px', height: '30px', borderRadius: '50%', border: '2px solid',
    display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
  },
  checkmark: { fontSize: '13px', color: '#FFFFFF', fontWeight: '700' },
  dotNum: { fontSize: '12px' },
  stepLabel: { fontSize: '13px', margin: '0 0 2px' },
  stepDesc: { fontSize: '11px', margin: 0 },
  footer: { fontSize: '11px', color: 'rgba(255,255,255,0.2)', margin: 0 },
}

const styles: Record<string, React.CSSProperties> = {
  root: {
    display: 'flex', minHeight: '100vh',
    fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
    backgroundColor: '#F7F8FC',
  },
  main: { flex: 1, display: 'flex', justifyContent: 'center', padding: '48px 40px' },
  content: { width: '100%', maxWidth: '640px' },
  header: { marginBottom: '28px' },
  stepLabel: {
    fontSize: '11px', fontWeight: '600', color: '#6B7280',
    letterSpacing: '1px', textTransform: 'uppercase' as const, margin: '0 0 10px',
  },
  heading: {
    fontSize: '26px', fontWeight: '700', color: '#0A0A14',
    margin: '0 0 8px', letterSpacing: '-0.4px',
  },
  subheading: { fontSize: '14px', color: '#6B7280', margin: 0, lineHeight: '1.6' },

  inviteCard: {
    backgroundColor: '#FFFFFF', border: '1px solid #E5E7EB',
    borderRadius: '10px', padding: '20px', marginBottom: '16px',
  },
  columnHeaders: {
    display: 'flex', gap: '10px', alignItems: 'center',
    marginBottom: '12px', paddingBottom: '10px', borderBottom: '1px solid #F3F4F6',
  },
  colHeader: {
    fontSize: '11px', fontWeight: '600', color: '#9CA3AF',
    textTransform: 'uppercase' as const, letterSpacing: '0.5px',
  },
  rowList: { display: 'flex', flexDirection: 'column', gap: '10px' },
  inviteRow: { display: 'flex', gap: '10px', alignItems: 'center' },
  input: {
    height: '38px', padding: '0 10px',
    fontSize: '13px', color: '#111827',
    backgroundColor: '#F9FAFB', border: '1px solid #E5E7EB',
    borderRadius: '7px', outline: 'none', minWidth: 0,
  },
  select: {
    height: '38px', padding: '0 8px',
    fontSize: '13px', color: '#111827',
    backgroundColor: '#F9FAFB', border: '1px solid #E5E7EB',
    borderRadius: '7px', outline: 'none', cursor: 'pointer', minWidth: 0,
  },
  removeBtn: {
    width: '32px', height: '32px', border: 'none',
    backgroundColor: 'transparent', color: '#9CA3AF',
    fontSize: '13px', borderRadius: '5px', flexShrink: 0,
  },
  addRowBtn: {
    marginTop: '14px', backgroundColor: 'transparent',
    border: '1px dashed #D1D5DB', borderRadius: '7px',
    width: '100%', height: '36px',
    fontSize: '13px', color: '#6B7280', cursor: 'pointer',
  },
  legend: {
    display: 'flex', flexDirection: 'column', gap: '6px',
    backgroundColor: '#F9FAFB', border: '1px solid #E5E7EB',
    borderRadius: '8px', padding: '14px 16px', marginBottom: '8px',
  },
  legendItem: { display: 'flex', gap: '10px', alignItems: 'baseline' },
  legendRole: { fontSize: '12px', fontWeight: '600', color: '#374151', minWidth: '70px' },
  legendDesc: { fontSize: '12px', color: '#6B7280' },

  error: {
    fontSize: '13px', color: '#DC2626',
    backgroundColor: '#FEF2F2', border: '1px solid #FECACA',
    borderRadius: '6px', padding: '10px 12px', margin: '12px 0 0',
  },
  actions: {
    marginTop: '28px', display: 'flex',
    justifyContent: 'space-between', alignItems: 'center',
  },
  rightActions: { display: 'flex', gap: '10px', alignItems: 'center' },
  backBtn: {
    height: '42px', padding: '0 20px',
    backgroundColor: 'transparent', color: '#6B7280',
    fontSize: '14px', fontWeight: '500',
    border: '1px solid #D1D5DB', borderRadius: '8px', cursor: 'pointer',
  },
  skipBtn: {
    height: '42px', padding: '0 18px',
    backgroundColor: 'transparent', color: '#6B7280',
    fontSize: '14px', fontWeight: '500',
    border: 'none', cursor: 'pointer', textDecoration: 'underline' as const,
  },
  primaryBtn: {
    height: '42px', padding: '0 28px',
    backgroundColor: '#000835', color: '#FFFFFF',
    fontSize: '14px', fontWeight: '600',
    border: 'none', borderRadius: '8px', cursor: 'pointer',
  },
}