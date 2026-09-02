'use client'

import { useEffect, useState } from 'react'
import CityDropdown from '@/app/components/CityDropdown'
import CountryDropdown from '@/app/components/CountryDropdown'  

interface Client {
  id: string
  name: string
  timezone: string
  currency: string
  country: string | null
  booking_mode: 'sbt' | 'cbt' | 'both'
}

const BOOKING_MODE_LABEL: Record<Client['booking_mode'], string> = {
  sbt: 'Self-Booking Tool (SBT) — employees book their own travel',
  cbt: 'Consultant-Booking Tool (CBT) — a travel counsellor books on your behalf',
  both: 'Hybrid — both SBT and CBT are enabled',
}

export default function SettingsClientPage() {
  const [client, setClient] = useState<Client | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    fetch('/api/me')
      .then(r => r.json())
      .then(data => {
        if (!data.ok || !data.client) {
          setError('Could not load company details.')
          return
        }
        setClient(data.client)
      })
      .catch(() => setError('Could not load company details.'))
      .finally(() => setLoading(false))
  }, [])

  if (loading) {
    return <div style={s.root}><p style={s.loadingText}>Loading…</p></div>
  }

  if (error || !client) {
    return <div style={s.root}><p style={s.errorMsg}>{error || 'Could not load company details.'}</p></div>
  }

  return (
    <div style={s.root}>
      <div style={s.header}>
        <h1 style={s.heading}>Company</h1>
        <p style={s.sub}>Your organisation's account details.</p>
      </div>

      <div style={s.banner}>
        These details are managed by your TMC. Contact them if anything needs to change.
      </div>

      <div style={s.card}>
        <DetailRow label="Company name" value={client.name} />
        <DetailRow label="Timezone" value={client.timezone} />
        <DetailRow label="Currency" value={client.currency} />
        <DetailRow label="Country" value={client.country || '—'} />
        <DetailRow
          label="Booking mode"
          value={BOOKING_MODE_LABEL[client.booking_mode]}
          last
        />
      </div>
    </div>
  )
}

function DetailRow({ label, value, last }: { label: string; value: string; last?: boolean }) {
  return (
    <div style={{ ...s.row, borderBottom: last ? 'none' : '1px solid #F3F4F6' }}>
      <span style={s.rowLabel}>{label}</span>
      <span style={s.rowValue}>{value}</span>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  root: { maxWidth: '560px', fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif" },
  loadingText: { fontSize: '13px', color: '#9CA3AF' },
  header: { marginBottom: '16px' },
  heading: { fontSize: '20px', fontWeight: 600, color: '#0A0A14', margin: '0 0 4px', letterSpacing: '-0.3px' },
  sub: { fontSize: '13px', color: '#6B7280', margin: 0 },
  banner: {
    fontSize: '12px', color: '#3730A3', background: '#EEF2FF', border: '1px solid #C7D2FE',
    borderRadius: '8px', padding: '10px 14px', marginBottom: '18px', lineHeight: '1.5',
  },
  card: {
    background: '#fff', border: '1px solid #E5E7EB', borderRadius: '10px', overflow: 'hidden',
  },
  row: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '14px 18px',
  },
  rowLabel: { fontSize: '12px', color: '#9CA3AF', fontWeight: 500 },
  rowValue: { fontSize: '13px', color: '#111827', fontWeight: 500, textAlign: 'right' as const },
  errorMsg: {
    fontSize: '13px', color: '#DC2626', background: '#FEF2F2',
    border: '1px solid #FECACA', borderRadius: '6px', padding: '10px 12px',
  },
}