'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

// ─── Re-export shared components (in a real project, import from '@/components/setup') ──
// For file-per-page delivery, we inline what's needed.

const STEPS = [
  { id: 1, label: 'Your company',  desc: 'Basic details' },
  { id: 2, label: 'Travel policy', desc: 'Pre-filled defaults' },
  { id: 3, label: 'Invite team',   desc: 'Optional' },
]

// ─── Policy data model ────────────────────────────────────────────────────────

interface BandPolicy {
  band: string
  title: string
  domesticFlight: number   // INR
  intlFlight: number       // INR
  flightClassShortHaul: string
  flightClassLongHaul: string  // >8 hr
  advanceBookingDays: number
  hotelMajorCity: number   // INR per night
  hotelOtherCity: number   // INR per night
  hotelStars: number       // max
  carRentalPerDay: number  // USD
  carClass: string
  autoApproveLimit: number // INR
  managerApproveLimit: number // INR  (above this → finance)
}

// SOR defaults — your pre-filled sensible policy
const DEFAULT_POLICY: BandPolicy[] = [
  {
    band: 'L1', title: 'Staff',
    domesticFlight: 6000, intlFlight: 50000,
    flightClassShortHaul: 'Economy', flightClassLongHaul: 'Economy',
    advanceBookingDays: 7,
    hotelMajorCity: 4000, hotelOtherCity: 3000, hotelStars: 3,
    carRentalPerDay: 50, carClass: 'Economy',
    autoApproveLimit: 25000, managerApproveLimit: 75000,
  },
  {
    band: 'L2', title: 'Associate',
    domesticFlight: 8000, intlFlight: 75000,
    flightClassShortHaul: 'Economy', flightClassLongHaul: 'Economy',
    advanceBookingDays: 7,
    hotelMajorCity: 6500, hotelOtherCity: 5000, hotelStars: 3,
    carRentalPerDay: 60, carClass: 'Economy',
    autoApproveLimit: 40000, managerApproveLimit: 100000,
  },
  {
    band: 'L3', title: 'Manager',
    domesticFlight: 12000, intlFlight: 125000,
    flightClassShortHaul: 'Economy', flightClassLongHaul: 'Economy',
    advanceBookingDays: 5,
    hotelMajorCity: 9000, hotelOtherCity: 7500, hotelStars: 4,
    carRentalPerDay: 80, carClass: 'Standard',
    autoApproveLimit: 75000, managerApproveLimit: 200000,
  },
  {
    band: 'L4', title: 'Director',
    domesticFlight: 16000, intlFlight: 200000,
    flightClassShortHaul: 'Economy', flightClassLongHaul: 'Business',
    advanceBookingDays: 3,
    hotelMajorCity: 15000, hotelOtherCity: 12500, hotelStars: 5,
    carRentalPerDay: 100, carClass: 'Standard / SUV',
    autoApproveLimit: 100000, managerApproveLimit: 350000,
  },
  {
    band: 'L5', title: 'VP & Above',
    domesticFlight: 20000, intlFlight: 500000,
    flightClassShortHaul: 'Business', flightClassLongHaul: 'Business',
    advanceBookingDays: 0,
    hotelMajorCity: 25000, hotelOtherCity: 20000, hotelStars: 5,
    carRentalPerDay: 150, carClass: 'Any',
    autoApproveLimit: 150000, managerApproveLimit: 500000,
  },
]

type PolicyKey = keyof BandPolicy

// ─── Column definitions ───────────────────────────────────────────────────────
interface ColDef {
  key: PolicyKey
  label: string
  unit: string
  type: 'number' | 'text' | 'select'
  options?: string[]
  width: number
}

const COLUMNS: ColDef[] = [
  { key: 'domesticFlight',      label: 'Domestic flight',       unit: '₹',   type: 'number', width: 110 },
  { key: 'intlFlight',          label: 'Intl. flight',          unit: '₹',   type: 'number', width: 140 },
  { key: 'flightClassShortHaul',label: 'Class (short haul)',    unit: '',    type: 'select',
    options: ['Economy', 'Business', 'First'], width: 120 },
  { key: 'flightClassLongHaul', label: 'Class (>8 hr)',         unit: '',    type: 'select',
    options: ['Economy', 'Business', 'First'], width: 120 },
  { key: 'advanceBookingDays',  label: 'Advance booking',       unit: 'days',type: 'number', width: 60 },
  { key: 'hotelMajorCity',      label: 'Hotel (major city)',    unit: '₹/night',type: 'number', width: 110 },
  { key: 'hotelOtherCity',      label: 'Hotel (other city)',    unit: '₹/night',type: 'number', width: 110 },
  { key: 'hotelStars',          label: 'Hotel stars (max)',     unit: '★',   type: 'number', width: 80 },
  { key: 'carRentalPerDay',     label: 'Car rental',            unit: '$/day',type: 'number', width: 90 },
  { key: 'autoApproveLimit',    label: 'Auto-approve under',    unit: '₹',   type: 'number', width: 120 },
  { key: 'managerApproveLimit', label: 'Finance approval over', unit: '₹',   type: 'number', width: 130 },
]

// ─── Component ────────────────────────────────────────────────────────────────

export default function SetupPolicyPage() {
  const router = useRouter()
  const [policy, setPolicy] = useState<BandPolicy[]>(DEFAULT_POLICY)
  const [approvalModel, setApprovalModel] = useState<'single' | 'two-tier'>('two-tier')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  function handleCellChange(
    bandIndex: number,
    key: PolicyKey,
    value: string
  ) {
    setPolicy(prev => prev.map((row, i) => {
      if (i !== bandIndex) return row
      const col = COLUMNS.find(c => c.key === key)
      return {
        ...row,
        [key]: col?.type === 'number' ? (Number(value) || 0) : value,
      }
    }))
  }

  async function handleSave() {
    setSaving(true)
    setError('')
    try {
      const res = await fetch('/api/setup/policy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ policy, approvalModel }),
      })
      if (!res.ok) {
        const d = await res.json()
        setError(d.error || 'Something went wrong.')
        return
      }
      router.push('/setup/invite')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={styles.root}>
      <Sidebar currentStep={2} />

      <div style={styles.main}>
        <div style={styles.content}>
          {/* Header */}
          <div style={styles.header}>
            <p style={styles.stepLabel}>Step 2 of 3</p>
            <h1 style={styles.heading}>Your travel policy</h1>
            <p style={styles.subheading}>
              We've pre-filled a standard policy based on your SOR. Every cell is editable —
              click any value to adjust it. You can refine this anytime in{' '}
              <strong>Settings → Policy</strong>.
            </p>
          </div>

          {/* Approval model toggle */}
          <div style={styles.toggleCard}>
            <div>
              <p style={styles.toggleTitle}>Approval model</p>
              <p style={styles.toggleDesc}>
                {approvalModel === 'two-tier'
                  ? 'Manager approves in-band requests. Finance approves above the finance threshold.'
                  : 'All approval requests go to the direct manager only.'}
              </p>
            </div>
            <div style={styles.toggleWrap}>
              <button
                onClick={() => setApprovalModel('single')}
                style={{
                  ...styles.toggleBtn,
                  backgroundColor: approvalModel === 'single' ? '#000835' : 'transparent',
                  color: approvalModel === 'single' ? '#fff' : '#6B7280',
                  border: `1.5px solid ${approvalModel === 'single' ? '#000835' : '#D1D5DB'}`,
                }}
              >
                Single-tier
              </button>
              <button
                onClick={() => setApprovalModel('two-tier')}
                style={{
                  ...styles.toggleBtn,
                  backgroundColor: approvalModel === 'two-tier' ? '#000835' : 'transparent',
                  color: approvalModel === 'two-tier' ? '#fff' : '#6B7280',
                  border: `1.5px solid ${approvalModel === 'two-tier' ? '#000835' : '#D1D5DB'}`,
                }}
              >
                Two-tier (recommended)
              </button>
            </div>
          </div>

          {/* Policy table */}
          <div style={styles.tableWrap}>
            <div style={styles.tableScroll}>
              <table style={styles.table}>
                <thead>
                  <tr>
                    <th style={{ ...styles.th, ...styles.stickyCol, width: 120 }}>Band</th>
                    {COLUMNS.map(col => (
                      <th key={String(col.key)} style={{ ...styles.th, width: col.width }}>
                        <span style={styles.colLabel}>{col.label}</span>
                        {col.unit && <span style={styles.colUnit}>{col.unit}</span>}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {policy.map((row, rowIdx) => (
                    <tr key={row.band} style={rowIdx % 2 === 0 ? styles.rowEven : styles.rowOdd}>
                      {/* Band cell */}
                      <td style={{ ...styles.td, ...styles.stickyCol }}>
                        <div style={styles.bandCell}>
                          <span style={styles.bandBadge}>{row.band}</span>
                          <span style={styles.bandTitle}>{row.title}</span>
                        </div>
                      </td>
                      {/* Data cells */}
                      {COLUMNS.map(col => (
                        <td key={String(col.key)} style={styles.td}>
                          {col.type === 'select' ? (
                            <select
                              value={String(row[col.key])}
                              onChange={e => handleCellChange(rowIdx, col.key, e.target.value)}
                              style={styles.cellSelect}
                            >
                              {col.options!.map(opt => (
                                <option key={opt} value={opt}>{opt}</option>
                              ))}
                            </select>
                          ) : (
                            <input
                              type="number"
                              value={Number(row[col.key])}
                              onChange={e => handleCellChange(rowIdx, col.key, e.target.value)}
                              style={styles.cellInput}
                              min={0}
                            />
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p style={styles.tableNote}>
              ↔ Scroll horizontally to see all columns · Major cities: Dubai, London, New York, Singapore, Paris, Tokyo, Sydney, Frankfurt, Hong Kong, Zurich
            </p>
          </div>

          {error && <p style={styles.error}>{error}</p>}

          {/* Actions */}
          <div style={styles.actions}>
            <button onClick={() => router.push('/setup')} style={styles.backBtn}>
              ← Back
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              style={{ ...styles.primaryBtn, opacity: saving ? 0.7 : 1 }}
            >
              {saving ? 'Saving…' : 'Save & continue →'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Sidebar (inlined — extract to shared component in real project) ──────────

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
  main: {
    flex: 1, overflowX: 'auto',
    display: 'flex', justifyContent: 'center',
    padding: '48px 40px',
  },
  content: { width: '100%', maxWidth: '1080px' },
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

  // Approval toggle
  toggleCard: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: '#FFFFFF', border: '1px solid #E5E7EB',
    borderRadius: '10px', padding: '16px 20px', marginBottom: '24px',
    gap: '16px', flexWrap: 'wrap' as const,
  },
  toggleTitle: { fontSize: '13px', fontWeight: '600', color: '#111827', margin: '0 0 2px' },
  toggleDesc: { fontSize: '12px', color: '#6B7280', margin: 0 },
  toggleWrap: { display: 'flex', gap: '8px' },
  toggleBtn: {
    height: '34px', padding: '0 14px', borderRadius: '6px',
    fontSize: '12px', fontWeight: '500', cursor: 'pointer',
  },

  // Table
  tableWrap: {
    backgroundColor: '#FFFFFF', border: '1px solid #E5E7EB',
    borderRadius: '10px', overflow: 'hidden', marginBottom: '8px',
  },
  tableScroll: { overflowX: 'auto' as const },
  table: { borderCollapse: 'collapse' as const, width: '100%', minWidth: '900px' },
  th: {
    padding: '10px 12px', textAlign: 'left' as const,
    backgroundColor: '#F9FAFB', borderBottom: '1px solid #E5E7EB',
    whiteSpace: 'nowrap' as const,
  },
  colLabel: { display: 'block', fontSize: '11px', fontWeight: '600', color: '#374151' },
  colUnit: { fontSize: '10px', color: '#9CA3AF', fontWeight: '400' },
  stickyCol: {
    position: 'sticky' as const, left: 0, zIndex: 1,
    backgroundColor: '#F9FAFB', borderRight: '1px solid #E5E7EB',
  },
  td: {
    padding: '8px 10px', borderBottom: '1px solid #F3F4F6', verticalAlign: 'middle' as const,
  },
  rowEven: { backgroundColor: '#FFFFFF' },
  rowOdd: { backgroundColor: '#FAFAFA' },
  bandCell: { display: 'flex', alignItems: 'center', gap: '8px' },
  bandBadge: {
    display: 'inline-block', padding: '2px 7px',
    backgroundColor: '#EEF2FF', color: '#3730A3',
    fontSize: '11px', fontWeight: '700', borderRadius: '4px',
  },
  bandTitle: { fontSize: '12px', color: '#374151', fontWeight: '500' },
  cellInput: {
    width: '150%', height: '30px', padding: '0 8px',
    fontSize: '13px', color: '#111827',
    backgroundColor: '#F9FAFB', border: '1px solid transparent',
    borderRadius: '5px', outline: 'none',
    transition: 'border-color 0.15s, background-color 0.15s',
  },
  cellSelect: {
    width: '150%', height: '30px', padding: '0 6px',
    fontSize: '12px', color: '#111827',
    backgroundColor: '#F9FAFB', border: '1px solid transparent',
    borderRadius: '5px', outline: 'none', cursor: 'pointer',
  },
  tableNote: {
    fontSize: '11px', color: '#9CA3AF',
    padding: '8px 16px', borderTop: '1px solid #F3F4F6', margin: 0,
  },

  error: {
    fontSize: '13px', color: '#DC2626',
    backgroundColor: '#FEF2F2', border: '1px solid #FECACA',
    borderRadius: '6px', padding: '10px 12px', margin: '16px 0 0',
  },
  actions: {
    marginTop: '28px', display: 'flex',
    justifyContent: 'space-between', alignItems: 'center',
  },
  backBtn: {
    height: '42px', padding: '0 20px',
    backgroundColor: 'transparent', color: '#6B7280',
    fontSize: '14px', fontWeight: '500',
    border: '1px solid #D1D5DB', borderRadius: '8px', cursor: 'pointer',
  },
  primaryBtn: {
    height: '42px', padding: '0 28px',
    backgroundColor: '#000835', color: '#FFFFFF',
    fontSize: '14px', fontWeight: '600',
    border: 'none', borderRadius: '8px', cursor: 'pointer',
  },
}