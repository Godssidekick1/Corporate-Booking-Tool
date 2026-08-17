'use client'

import { useEffect, useState } from 'react'

// ── /tmc/settings/approvals ─────────────────────────────────────────────
// TMC-side chain builder. One chain per (company, band, travel_type) — pick
// a company, pick a band, pick a travel type, build an ordered list of
// tiers. Mirrors tmc/settings/policy's company-selector pattern.
// ─────────────────────────────────────────────────────────────────────────────

interface Company { id: string; name: string }
interface Band { id: string; code: string; rank: number }
interface ChainTier {
  tier: number
  approver_type: 'manager' | 'finance_role' | 'specific_user' | 'admin' | 'self' | 'any_manager_at'
  min_verdict: 'green' | 'amber' | 'red'
  approver_user_id?: string | null
  min_band_rank?: number | null
}
interface ExistingChain {
  id: string
  band_id: string
  travel_type: string
  tiers: ChainTier[]
  version: number
}

const TRAVEL_TYPES = [
  { value: 'flight_domestic', label: 'Domestic flight' },
  { value: 'flight_international', label: 'International flight' },
  { value: 'hotel', label: 'Hotel' },
  { value: 'car_rental', label: 'Car rental' },
]

const APPROVER_TYPE_META: Record<string, { label: string; desc: string }> = {
  manager: { label: "Traveler's manager", desc: 'Resolves via the employee\u2019s assigned manager (manager_id).' },
  any_manager_at: { label: 'Any manager at band or above', desc: 'Any active manager/admin whose own band rank meets the minimum \u2014 use when the traveler\u2019s direct manager shouldn\u2019t be the approver.' },
  finance_role: { label: 'Finance', desc: 'Any active employee with the Finance role.' },
  admin: { label: 'Corporate admin', desc: 'Any active employee with the Admin role.' },
  specific_user: { label: 'Specific person', desc: 'A named employee, regardless of role.' },
  self: { label: 'Self-approve (no review)', desc: 'Auto-approved and logged \u2014 no human ever has to act. Use for bands exempt from approval (e.g. MD, CEO).' },
}

function emptyTier(nextNumber: number): ChainTier {
  return { tier: nextNumber, approver_type: 'manager', min_verdict: 'amber' }
}

export default function TmcApprovalsPage() {
  const [companies, setCompanies] = useState<Company[]>([])
  const [selectedCompanyId, setSelectedCompanyId] = useState('')
  const [bands, setBands] = useState<Band[]>([])
  const [chains, setChains] = useState<ExistingChain[]>([])
  const [selectedBandId, setSelectedBandId] = useState('')
  const [selectedTravelType, setSelectedTravelType] = useState('flight_domestic')
  const [tiers, setTiers] = useState<ChainTier[]>([])
  const [employees, setEmployees] = useState<{ id: string; full_name: string }[]>([])

  const [loadingCompanies, setLoadingCompanies] = useState(true)
  const [loadingChains, setLoadingChains] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  useEffect(() => {
    fetch('/api/tmc/companies')
      .then(r => r.json())
      .then(d => { if (d.ok) setCompanies(d.companies) })
      .finally(() => setLoadingCompanies(false))
  }, [])

  useEffect(() => {
    if (!selectedCompanyId) { setBands([]); setChains([]); return }
    loadChainsForCompany(selectedCompanyId)
    fetch(`/api/tmc/employee-assignments?companyId=${selectedCompanyId}`)
      .then(r => r.json())
      .then(d => { if (d.ok) setEmployees(d.employees.map((e: { id: string; full_name: string }) => ({ id: e.id, full_name: e.full_name }))) })
      .catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCompanyId])

  useEffect(() => {
    if (!selectedBandId || !selectedTravelType) { setTiers([]); return }
    const existing = chains.find(c => c.band_id === selectedBandId && c.travel_type === selectedTravelType)
    setTiers(existing ? existing.tiers.map(t => ({ ...t })) : [])
  }, [selectedBandId, selectedTravelType, chains])

  async function loadChainsForCompany(companyId: string) {
    setLoadingChains(true)
    setError('')
    try {
      const res = await fetch(`/api/tmc/approval-chains?companyId=${companyId}`)
      const data = await res.json()
      if (!data.ok) {
        setError(data.error || 'Could not load approval chains.')
        return
      }
      setBands(data.bands)
      setChains(data.chains)
      if (data.bands.length > 0 && !selectedBandId) setSelectedBandId(data.bands[0].id)
    } catch {
      setError('Something went wrong loading approval chains.')
    } finally {
      setLoadingChains(false)
    }
  }

  function addTier() {
    setTiers(prev => [...prev, emptyTier(prev.length > 0 ? Math.max(...prev.map(t => t.tier)) + 1 : 1)])
  }

  function removeTier(tierNumber: number) {
    setTiers(prev => prev.filter(t => t.tier !== tierNumber).map((t, i) => ({ ...t, tier: i + 1 })))
  }

  function updateTier(tierNumber: number, patch: Partial<ChainTier>) {
    setTiers(prev => prev.map(t => t.tier === tierNumber ? { ...t, ...patch } : t))
  }

  async function handleSave() {
    setSaving(true)
    setError('')
    setSuccess('')
    try {
      const res = await fetch('/api/tmc/approval-chains', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          companyId: selectedCompanyId,
          bandId: selectedBandId,
          travelType: selectedTravelType,
          tiers,
        }),
      })
      const data = await res.json()
      if (!data.ok) {
        setError(data.error || 'Could not save this chain.')
        return
      }
      setSuccess('Approval chain saved.')
      loadChainsForCompany(selectedCompanyId)
    } catch {
      setError('Something went wrong saving this chain.')
    } finally {
      setSaving(false)
    }
  }

  const selectedBand = bands.find(b => b.id === selectedBandId)

  return (
    <div style={s.page}>
      <div style={s.header}>
        <h1 style={s.heading}>Approval chains</h1>
        <p style={s.sub}>Configure who approves out-of-policy bookings, per band and travel type.</p>
      </div>

      <div style={s.selectorRow}>
        <select
          value={selectedCompanyId}
          onChange={e => { setSelectedCompanyId(e.target.value); setSelectedBandId('') }}
          style={s.select}
          disabled={loadingCompanies}
        >
          <option value="">Select a company…</option>
          {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </div>

      {error && <div style={s.errorBanner}><span style={s.bannerIcon}>⚠</span> {error}</div>}
      {success && <div style={s.successBanner}><span style={s.bannerIcon}>✓</span> {success}</div>}

      {selectedCompanyId && !loadingChains && (
        <>
          <div style={s.tabRow}>
            {bands.map(b => (
              <button
                key={b.id}
                type="button"
                onClick={() => setSelectedBandId(b.id)}
                style={{ ...s.bandTab, ...(selectedBandId === b.id ? s.bandTabActive : {}) }}
              >
                {b.code}
              </button>
            ))}
          </div>

          <div style={s.travelTypeRow}>
            {TRAVEL_TYPES.map(tt => (
              <button
                key={tt.value}
                type="button"
                onClick={() => setSelectedTravelType(tt.value)}
                style={{ ...s.travelTypeTab, ...(selectedTravelType === tt.value ? s.travelTypeTabActive : {}) }}
              >
                {tt.label}
              </button>
            ))}
          </div>

          {selectedBand && (
            <div style={s.card}>
              <div style={s.cardHeader}>
                <h2 style={s.cardTitle}>
                  {selectedBand.code} · {TRAVEL_TYPES.find(t => t.value === selectedTravelType)?.label}
                </h2>
                <p style={s.cardSub}>
                  Tiers are checked in order. A booking's verdict (green/amber/red) determines which tier applies —
                  the first tier whose minimum verdict is met is the one that's created.
                </p>
              </div>

              {tiers.length === 0 && (
                <div style={s.emptyTiers}>
                  No tiers configured — bookings for this band/travel type will be auto-approved with no review.
                </div>
              )}

              <div style={s.tierList}>
                {tiers.map(tier => (
                  <div key={tier.tier} style={s.tierCard}>
                    <div style={s.tierHeader}>
                      <span style={s.tierBadge}>Tier {tier.tier}</span>
                      <button type="button" onClick={() => removeTier(tier.tier)} style={s.removeBtn}>Remove</button>
                    </div>

                    <div style={s.tierFields}>
                      <div style={s.field}>
                        <label style={s.label}>Triggers at</label>
                        <select
                          value={tier.min_verdict}
                          onChange={e => updateTier(tier.tier, { min_verdict: e.target.value as ChainTier['min_verdict'] })}
                          style={s.input}
                        >
                          <option value="green">Green or worse (always)</option>
                          <option value="amber">Amber or worse</option>
                          <option value="red">Red only</option>
                        </select>
                      </div>

                      <div style={s.field}>
                        <label style={s.label}>Approver</label>
                        <select
                          value={tier.approver_type}
                          onChange={e => updateTier(tier.tier, { approver_type: e.target.value as ChainTier['approver_type'] })}
                          style={s.input}
                        >
                          {Object.entries(APPROVER_TYPE_META).map(([key, meta]) => (
                            <option key={key} value={key}>{meta.label}</option>
                          ))}
                        </select>
                        <p style={s.fieldHint}>{APPROVER_TYPE_META[tier.approver_type].desc}</p>
                      </div>

                      {tier.approver_type === 'specific_user' && (
                        <div style={s.field}>
                          <label style={s.label}>Person</label>
                          <select
                            value={tier.approver_user_id ?? ''}
                            onChange={e => updateTier(tier.tier, { approver_user_id: e.target.value })}
                            style={s.input}
                          >
                            <option value="">Select…</option>
                            {employees.map(emp => <option key={emp.id} value={emp.id}>{emp.full_name}</option>)}
                          </select>
                        </div>
                      )}

                      {tier.approver_type === 'any_manager_at' && (
                        <div style={s.field}>
                          <label style={s.label}>Minimum band rank</label>
                          <select
                            value={tier.min_band_rank ?? ''}
                            onChange={e => updateTier(tier.tier, { min_band_rank: Number(e.target.value) })}
                            style={s.input}
                          >
                            <option value="">Select…</option>
                            {bands.map(b => <option key={b.id} value={b.rank}>{b.code} (rank {b.rank}) or above</option>)}
                          </select>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              <button type="button" onClick={addTier} style={s.addTierBtn}>+ Add tier</button>

              <button
                type="button"
                onClick={handleSave}
                disabled={saving}
                style={{ ...s.saveBtn, opacity: saving ? 0.7 : 1 }}
              >
                {saving ? 'Saving…' : 'Save chain'}
              </button>
            </div>
          )}
        </>
      )}

      {selectedCompanyId && loadingChains && (
        <div style={s.loadingRow}><div style={s.spinner} /></div>
      )}
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  page: { fontFamily: "'Inter', -apple-system, sans-serif", padding: '32px', maxWidth: '820px', margin: '0 auto' },

  header: { marginBottom: '20px' },
  heading: { fontSize: '22px', fontWeight: 700, color: '#0A0A14', margin: '0 0 6px', letterSpacing: '-0.4px' },
  sub: { fontSize: '13px', color: '#6B7280', margin: 0, lineHeight: 1.5 },

  selectorRow: { marginBottom: '20px' },
  select: {
    height: '38px', padding: '0 12px', fontSize: '13px', color: '#111827',
    background: '#fff', border: '1px solid #E5E7EB', borderRadius: '8px', outline: 'none', minWidth: '260px',
  },

  errorBanner: { display: 'flex', alignItems: 'center', gap: '8px', background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: '10px', padding: '11px 14px', fontSize: '13px', color: '#DC2626', marginBottom: '16px' },
  successBanner: { display: 'flex', alignItems: 'center', gap: '8px', background: '#F0FDF4', border: '1px solid #BBF7D0', borderRadius: '10px', padding: '11px 14px', fontSize: '13px', color: '#166534', marginBottom: '16px' },
  bannerIcon: { fontSize: '14px' },

  loadingRow: { display: 'flex', justifyContent: 'center', padding: '60px 0' },
  spinner: { width: '22px', height: '22px', border: '2.5px solid #E5E7EB', borderTopColor: '#000835', borderRadius: '50%' },

  tabRow: { display: 'flex', gap: '6px', marginBottom: '12px', flexWrap: 'wrap' as const },
  bandTab: {
    fontSize: '13px', fontWeight: 600, color: '#6B7280', background: '#fff', border: '1px solid #E5E7EB',
    borderRadius: '8px', padding: '7px 14px', cursor: 'pointer',
  },
  bandTabActive: { color: '#fff', background: '#000835', borderColor: '#000835' },

  travelTypeRow: { display: 'flex', gap: '6px', marginBottom: '20px', flexWrap: 'wrap' as const },
  travelTypeTab: {
    fontSize: '12px', fontWeight: 600, color: '#6B7280', background: '#F9FAFB', border: '1px solid #E5E7EB',
    borderRadius: '7px', padding: '6px 12px', cursor: 'pointer',
  },
  travelTypeTabActive: { color: '#000835', background: '#EEF2FF', borderColor: '#000835' },

  card: { background: '#fff', border: '1px solid #E5E7EB', borderRadius: '14px', padding: '20px' },
  cardHeader: { marginBottom: '16px' },
  cardTitle: { fontSize: '15px', fontWeight: 700, color: '#111827', margin: '0 0 6px' },
  cardSub: { fontSize: '12px', color: '#9CA3AF', margin: 0, lineHeight: 1.5 },

  emptyTiers: { fontSize: '12.5px', color: '#92400E', background: '#FFFBEB', border: '1px solid #FDE68A', borderRadius: '8px', padding: '12px 14px', marginBottom: '16px', lineHeight: 1.5 },

  tierList: { display: 'flex', flexDirection: 'column' as const, gap: '12px', marginBottom: '14px' },
  tierCard: { border: '1px solid #E5E7EB', borderRadius: '10px', padding: '14px', background: '#F9FAFB' },
  tierHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' },
  tierBadge: { fontSize: '11px', fontWeight: 700, color: '#3730A3', background: '#EEF2FF', padding: '3px 9px', borderRadius: '6px' },
  removeBtn: { fontSize: '11.5px', color: '#DC2626', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600 },

  tierFields: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' },
  field: { display: 'flex', flexDirection: 'column' as const, gap: '5px' },
  label: { fontSize: '11px', fontWeight: 500, color: '#374151' },
  input: { height: '36px', padding: '0 10px', fontSize: '12.5px', color: '#111827', background: '#fff', border: '1px solid #E5E7EB', borderRadius: '7px', outline: 'none' },
  fieldHint: { fontSize: '10.5px', color: '#9CA3AF', margin: '2px 0 0', lineHeight: 1.4 },

  addTierBtn: {
    fontSize: '12.5px', fontWeight: 600, color: '#000835', background: '#fff', border: '1px dashed #D1D5DB',
    borderRadius: '8px', padding: '9px 14px', cursor: 'pointer', width: '100%', marginBottom: '16px',
  },
  saveBtn: {
    height: '42px', width: '100%', background: '#000835', color: '#fff', fontSize: '13.5px', fontWeight: 700,
    border: 'none', borderRadius: '9px', cursor: 'pointer',
  },
}