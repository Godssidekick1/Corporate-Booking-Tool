'use client'

import { useRouter } from 'next/navigation'

interface TravelOption {
  id: 'flights' | 'hotels' | 'cabs'
  label: string
  desc: string
  icon: string
  href: string
  available: boolean
}

const OPTIONS: TravelOption[] = [
  {
    id: 'flights',
    label: 'Flights',
    desc: 'Search live fares and book within your travel policy.',
    icon: '✈',
    href: '/book/flights',
    available: true,
  },
  {
    id: 'hotels',
    label: 'Hotels',
    desc: 'Find and book stays for your trip.',
    icon: '🏨',
    href: '/book/hotels',
    available: false,
  },
  {
    id: 'cabs',
    label: 'Cabs',
    desc: 'Arrange ground transport at your destination.',
    icon: '🚗',
    href: '/book/cabs',
    available: false,
  },
]

export default function BookLandingPage() {
  const router = useRouter()

  return (
    <div style={s.page}>
      <div style={s.root}>
        <div style={s.header}>
          <h1 style={s.heading}>Book travel</h1>
          <p style={s.sub}>What would you like to book?</p>
        </div>

        <div style={s.optionsGrid}>
          {OPTIONS.map(opt => (
            <button
              key={opt.id}
              type="button"
              onClick={() => router.push(opt.href)}
              style={s.optionCard}
            >
              <div style={s.optionIcon}>{opt.icon}</div>
              <div style={s.optionLabelRow}>
                <span style={s.optionLabel}>{opt.label}</span>
                {!opt.available && <span style={s.comingSoonTag}>Coming soon</span>}
              </div>
              <p style={s.optionDesc}>{opt.desc}</p>
              <span style={s.optionCta}>
                {opt.available ? 'Search flights →' : 'Preview →'}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  page: { background: '#F9FAFB', minHeight: '100vh' },
  root: { fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif", maxWidth: '820px', margin: '0 auto', padding: '32px 24px 64px' },

  header: { marginBottom: '24px' },
  heading: { fontSize: '24px', fontWeight: 700, color: '#0A0A14', margin: '0 0 6px', letterSpacing: '-0.4px' },
  sub: { fontSize: '14px', color: '#6B7280', margin: 0 },

  optionsGrid: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '16px' },
  optionCard: {
    display: 'flex', flexDirection: 'column', alignItems: 'flex-start', textAlign: 'left' as const,
    background: '#fff', border: '1px solid #E5E7EB', borderRadius: '16px', padding: '22px 20px',
    cursor: 'pointer', boxShadow: '0 1px 3px rgba(0,0,0,0.04)', transition: 'border-color 0.15s, transform 0.15s',
    font: 'inherit',
  },
  optionIcon: {
    width: '44px', height: '44px', borderRadius: '12px', background: '#EEF2FF',
    display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '20px', marginBottom: '14px',
  },
  optionLabelRow: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' },
  optionLabel: { fontSize: '16px', fontWeight: 700, color: '#0A0A14', letterSpacing: '-0.2px' },
  comingSoonTag: { fontSize: '9px', fontWeight: 700, color: '#92400E', background: '#FEF3C7', padding: '2px 7px', borderRadius: '5px', letterSpacing: '0.3px', textTransform: 'uppercase' as const },
  optionDesc: { fontSize: '12.5px', color: '#6B7280', lineHeight: '1.5', margin: '0 0 16px' },
  optionCta: { fontSize: '12px', fontWeight: 600, color: '#000835', marginTop: 'auto' },
}