'use client'

import { useEffect, useState } from 'react'
import SearchableSelect, { SearchableOption } from '@/app/components/SearchableSelect'

// ── /tmc/settings/approvals ─────────────────────────────────────────────
// Per-employee chain builder. Pick a company, pick an employee (both via
// searchable/typable dropdowns), then build an ordered tier list for each
// of the two routing categories — flights_hotels and misc — shown side by
// side as separate cards. Replaces the old band+travel_type model: chains
// are assigned directly to a specific employee, not derived from their
// band.
// ─────────────────────────────────────────────────────────────────────────────

interface Company { id: string; name: string }
interface Band { id: string; code: string; rank: number }
interface Employee { id: string; full_name: string; email: string; band_code: string | null; status: string }
type ApprovalCategory = 'flights_hotels' | 'misc'
interface ChainTier {
  tier: number
  approver_type: 'manager' | 'finance_role' | 'specific_user' | 'admin' | 'self' | 'any_manager_at'
  min_verdict: 'green' | 'amber' | 'red'
  approver_user_id?: string | null
  min_band_rank?: number | null
}
interface ExistingChain {
  id: string
  employee_id: string
  category: ApprovalCategory
  tiers: ChainTier[]
  version: number
}

const CATEGORY_META: Record<ApprovalCategory, { label: string; desc: string }> = {
  flights_hotels: { label: 'Flights & hotels', desc: 'Approver chain for flight and hotel bookings.' },
  misc: { label: 'Miscellaneous', desc: 'Approver chain for car rentals, expenses, and anything else — often routed to Finance.' },
}

const APPROVER_TYPE_META: Record<string, { label: string; desc: string }> = {
  manager: { label: "Traveler's manager", desc: 'Resolves via the employee\u2019s assigned manager (manager_id).' },
  any_manager_at: { label: 'Any manager at band or above', desc: 'Any active manager/admin whose own band rank meets the minimum \u2014 use when the traveler\u2019s direct manager shouldn\u2019t be the approver.' },
  finance_role: { label: 'Finance', desc: 'Any active employee with the Finance role.' },
  admin: { label: 'Corporate admin', desc: 'Any active employee with the Admin role.' },
  specific_user: { label: 'Specific person', desc: 'A named employee, regardless of role.' },
  self: { label: 'Self-approve (no review)', desc: 'Auto-approved and logged \u2014 no human ever has to act. Use for employees exempt from approval (e.g. MD, CEO).' },
}

function emptyTier(nextNumber: number): ChainTier {
  return { tier: nextNumber, approver_type: 'manager', min_verdict: 'amber' }
}

export default function TmcApprovalsPage() {
  const [companies, setCompanies] = useState<Company[]>([])
  const [selectedCompanyId, setSelectedCompanyId] = useState('')
  const [bands, setBands] = useState<Band[]>([])
  const [employees, setEmployees] = useState<Employee[]>([])
  const [chains, setChains] = useState<ExistingChain[]>([])
  const [selectedEmployeeId, setSelectedEmployeeId] = useState('')

  // Both category cards' tier lists live here at once, keyed by category —
  // this is what lets the two cards be edited independently and saved
  // independently, per the "side by side" decision.
  const [tiersByCategory, setTiersByCategory] = useState<Record<ApprovalCategory, ChainTier[]>>({
    flights_hotels: [], misc: [],
  })

  const [loadingCompanies, setLoadingCompanies] = useState(true)
  const [loadingChains, setLoadingChains] = useState(false)
  const [savingCategory, setSavingCategory] = useState<ApprovalCategory | null>(null)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  useEffect(() => {
    fetch('/api/tmc/companies')
      .then(r => r.json())
      .then(d => { if (d.ok) setCompanies(d.companies) })
      .finally(() => setLoadingCompanies(false))
  }, [])

  useEffect(() => {
    if (!selectedCompanyId) { setBands([]); setEmployees([]); setChains([]); setSelectedEmployeeId(''); return }
    loadChainsForCompany(selectedCompanyId)
    setSelectedEmployeeId('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCompanyId])

  useEffect(() => {
    if (!selectedEmployeeId) {
      setTiersByCategory({ flights_hotels: [], misc: [] })
      return
    }
    const flightsHotels = chains.find(c => c.employee_id === selectedEmployeeId && c.category === 'flights_hotels')
    const misc = chains.find(c => c.employee_id === selectedEmployeeId && c.category === 'misc')
    setTiersByCategory({
      flights_hotels: flightsHotels ? flightsHotels.tiers.map(t => ({ ...t })) : [],
      misc: misc ? misc.tiers.map(t => ({ ...t })) : [],
    })
  }, [selectedEmployeeId, chains])

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
      setEmployees(data.employees)
      setChains(data.chains)
    } catch {
      setError('Something went wrong loading approval chains.')
    } finally {
      setLoadingChains(false)
    }
  }

  function addTier(category: ApprovalCategory) {
    setTiersByCategory(prev => {
      const current = prev[category]
      const nextNumber = current.length > 0 ? Math.max(...current.map(t => t.tier)) + 1 : 1
      return { ...prev, [category]: [...current, emptyTier(nextNumber)] }
    })
  }

  function removeTier(category: ApprovalCategory, tierNumber: number) {
    setTiersByCategory(prev => ({
      ...prev,
      [category]: prev[category].filter(t => t.tier !== tierNumber).map((t, i) => ({ ...t, tier: i + 1 })),
    }))
  }

  function updateTier(category: ApprovalCategory, tierNumber: number, patch: Partial<ChainTier>) {
    setTiersByCategory(prev => ({
      ...prev,
      [category]: prev[category].map(t => t.tier === tierNumber ? { ...t, ...patch } : t),
    }))
  }

  async function handleSave(category: ApprovalCategory) {
    setSavingCategory(category)
    setError('')
    setSuccess('')
    try {
      const res = await fetch('/api/tmc/approval-chains', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          companyId: selectedCompanyId,
          employeeId: selectedEmployeeId,
          category,
          tiers: tiersByCategory[category],
        }),
      })
      const data = await res.json()
      if (!data.ok) {
        setError(data.error || 'Could not save this chain.')
        return
      }
      setSuccess(`${CATEGORY_META[category].label} chain saved.`)
      loadChainsForCompany(selectedCompanyId)
    } catch {
      setError('Something went wrong saving this chain.')
    } finally {
      setSavingCategory(null)
    }
  }

  const companyOptions: SearchableOption[] = companies.map(c => ({ id: c.id, label: c.name }))
  const employeeOptions: SearchableOption[] = employees.map(e => ({
    id: e.id,
    label: e.full_name,
    sublabel: [e.email, e.band_code].filter(Boolean).join(' · '),
  }))
  const approverOptions: SearchableOption[] = employees
    .filter(e => e.status === 'active')
    .map(e => ({ id: e.id, label: e.full_name, sublabel: e.email }))

  const selectedEmployee = employees.find(e => e.id === selectedEmployeeId)

  return (
    <div style={s.page}>
      <div style={s.header}>
        <h1 style={s.heading}>Approval chains</h1>
        <p style={s.sub}>Assign who approves out-of-policy bookings, per employee — one chain for flights &amp; hotels, one for everything else.</p>
      </div>

      <div style={s.selectorGrid}>
        <div style={s.selectorField}>
          <label style={s.selectorLabel}>Company</label>
          <SearchableSelect
            value={selectedCompanyId}
            onChange={id => setSelectedCompanyId(id)}
            options={companyOptions}
            placeholder={loadingCompanies ? 'Loading companies…' : 'Search for a company…'}
            disabled={loadingCompanies}
            emptyMessage="No companies found"
          />
        </div>

        {selectedCompanyId && (
          <div style={s.selectorField}>
            <label style={s.selectorLabel}>Employee</label>
            <SearchableSelect
              value={selectedEmployeeId}
              onChange={id => setSelectedEmployeeId(id)}
              options={employeeOptions}
              placeholder={loadingChains ? 'Loading employees…' : 'Search for an employee…'}
              disabled={loadingChains}
              emptyMessage="No employees found"
            />
          </div>
        )}
      </div>

      {error && <div style={s.errorBanner}><span style={s.bannerIcon}>⚠</span> {error}</div>}
      {success && <div style={s.successBanner}><span style={s.bannerIcon}>✓</span> {success}</div>}

      {selectedEmployeeId && selectedEmployee && !loadingChains && (
        <>
          <div style={s.employeeHeader}>
            <span style={s.employeeName}>{selectedEmployee.full_name}</span>
            <span style={s.employeeMeta}>{[selectedEmployee.email, selectedEmployee.band_code].filter(Boolean).join(' · ')}</span>
          </div>

          <div style={s.categoryGrid}>
            {(['flights_hotels', 'misc'] as const).map(category => {
              const tiers = tiersByCategory[category]
              return (
                <div key={category} style={s.card}>
                  <div style={s.cardHeader}>
                    <h2 style={s.cardTitle}>{CATEGORY_META[category].label}</h2>
                    <p style={s.cardSub}>{CATEGORY_META[category].desc}</p>
                  </div>

                  {tiers.length === 0 && (
                    <div style={s.emptyTiers}>
                      No tiers configured — bookings in this category will be auto-approved with no review.
                    </div>
                  )}

                  <div style={s.tierList}>
                    {tiers.map(tier => (
                      <div key={tier.tier} style={s.tierCard}>
                        <div style={s.tierHeader}>
                          <span style={s.tierBadge}>Tier {tier.tier}</span>
                          <button type="button" onClick={() => removeTier(category, tier.tier)} style={s.removeBtn}>Remove</button>
                        </div>

                        <div style={s.tierFields}>
                          <div style={s.field}>
                            <label style={s.label}>Triggers at</label>
                            <select
                              value={tier.min_verdict}
                              onChange={e => updateTier(category, tier.tier, { min_verdict: e.target.value as ChainTier['min_verdict'] })}
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
                              onChange={e => updateTier(category, tier.tier, { approver_type: e.target.value as ChainTier['approver_type'] })}
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
                              <SearchableSelect
                                value={tier.approver_user_id ?? ''}
                                onChange={id => updateTier(category, tier.tier, { approver_user_id: id })}
                                options={approverOptions}
                                placeholder="Search for a person…"
                                emptyMessage="No employees found"
                              />
                            </div>
                          )}

                          {tier.approver_type === 'any_manager_at' && (
                            <div style={s.field}>
                              <label style={s.label}>Minimum band rank</label>
                              <select
                                value={tier.min_band_rank ?? ''}
                                onChange={e => updateTier(category, tier.tier, { min_band_rank: Number(e.target.value) })}
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

                  <button type="button" onClick={() => addTier(category)} style={s.addTierBtn}>+ Add tier</button>

                  <button
                    type="button"
                    onClick={() => handleSave(category)}
                    disabled={savingCategory === category}
                    style={{ ...s.saveBtn, opacity: savingCategory === category ? 0.7 : 1 }}
                  >
                    {savingCategory === category ? 'Saving…' : `Save ${CATEGORY_META[category].label.toLowerCase()} chain`}
                  </button>
                </div>
              )
            })}
          </div>
        </>
      )}

      {selectedCompanyId && loadingChains && (
        <div style={s.loadingRow}><div style={s.spinner} /></div>
      )}
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  page: { fontFamily: "'Inter', -apple-system, sans-serif", padding: '32px', maxWidth: '1100px', margin: '0 auto' },

  header: { marginBottom: '20px' },
  heading: { fontSize: '22px', fontWeight: 700, color: '#0A0A14', margin: '0 0 6px', letterSpacing: '-0.4px' },
  sub: { fontSize: '13px', color: '#6B7280', margin: 0, lineHeight: 1.5 },

  selectorGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px', marginBottom: '20px', maxWidth: '640px' },
  selectorField: { display: 'flex', flexDirection: 'column' as const, gap: '5px' },
  selectorLabel: { fontSize: '11px', fontWeight: 700, color: '#9CA3AF', textTransform: 'uppercase' as const, letterSpacing: '0.4px' },

  errorBanner: { display: 'flex', alignItems: 'center', gap: '8px', background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: '10px', padding: '11px 14px', fontSize: '13px', color: '#DC2626', marginBottom: '16px' },
  successBanner: { display: 'flex', alignItems: 'center', gap: '8px', background: '#F0FDF4', border: '1px solid #BBF7D0', borderRadius: '10px', padding: '11px 14px', fontSize: '13px', color: '#166534', marginBottom: '16px' },
  bannerIcon: { fontSize: '14px' },

  loadingRow: { display: 'flex', justifyContent: 'center', padding: '60px 0' },
  spinner: { width: '22px', height: '22px', border: '2.5px solid #E5E7EB', borderTopColor: '#000835', borderRadius: '50%' },

  employeeHeader: { display: 'flex', alignItems: 'baseline', gap: '10px', marginBottom: '16px', flexWrap: 'wrap' as const },
  employeeName: { fontSize: '16px', fontWeight: 700, color: '#111827' },
  employeeMeta: { fontSize: '12.5px', color: '#9CA3AF' },

  categoryGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '18px' },

  card: { background: '#fff', border: '1px solid #E5E7EB', borderRadius: '14px', padding: '20px', display: 'flex', flexDirection: 'column' as const },
  cardHeader: { marginBottom: '16px' },
  cardTitle: { fontSize: '15px', fontWeight: 700, color: '#111827', margin: '0 0 6px' },
  cardSub: { fontSize: '12px', color: '#9CA3AF', margin: 0, lineHeight: 1.5 },

  emptyTiers: { fontSize: '12.5px', color: '#92400E', background: '#FFFBEB', border: '1px solid #FDE68A', borderRadius: '8px', padding: '12px 14px', marginBottom: '16px', lineHeight: 1.5 },

  tierList: { display: 'flex', flexDirection: 'column' as const, gap: '12px', marginBottom: '14px' },
  tierCard: { border: '1px solid #E5E7EB', borderRadius: '10px', padding: '14px', background: '#F9FAFB' },
  tierHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' },
  tierBadge: { fontSize: '11px', fontWeight: 700, color: '#3730A3', background: '#EEF2FF', padding: '3px 9px', borderRadius: '6px' },
  removeBtn: { fontSize: '11.5px', color: '#DC2626', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600 },

  tierFields: { display: 'flex', flexDirection: 'column' as const, gap: '12px' },
  field: { display: 'flex', flexDirection: 'column' as const, gap: '5px', position: 'relative' as const },
  label: { fontSize: '11px', fontWeight: 500, color: '#374151' },
  input: { height: '36px', padding: '0 10px', fontSize: '12.5px', color: '#111827', background: '#fff', border: '1px solid #E5E7EB', borderRadius: '7px', outline: 'none' },
  fieldHint: { fontSize: '10.5px', color: '#9CA3AF', margin: '2px 0 0', lineHeight: 1.4 },

  addTierBtn: {
    fontSize: '12.5px', fontWeight: 600, color: '#000835', background: '#fff', border: '1px dashed #D1D5DB',
    borderRadius: '8px', padding: '9px 14px', cursor: 'pointer', width: '100%', marginBottom: '16px',
  },
  saveBtn: {
    height: '42px', width: '100%', background: '#000835', color: '#fff', fontSize: '13.5px', fontWeight: 700,
    border: 'none', borderRadius: '9px', cursor: 'pointer', marginTop: 'auto',
  },
}