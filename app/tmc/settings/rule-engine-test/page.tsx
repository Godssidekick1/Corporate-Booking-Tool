'use client'

import { useEffect, useState } from 'react'

interface Company {
  id: string
  name: string
}

interface Employee {
  id: string
  full_name: string
  email: string
  band_code: string | null
}

interface VerdictBreach {
  limit_key: string
  kind: 'numeric' | 'boolean'
  policyValue: number | boolean
  actualValue: number | boolean
  severity: 'amber' | 'red'
}

interface TestResult {
  ok: boolean
  verdict?: 'green' | 'amber' | 'red'
  breaches?: VerdictBreach[]
  costTier?: string
  policyGroupName?: string
  bandCode?: string
  reason?: string
  message?: string
}

const TRAVEL_TYPES = [
  { value: 'flight_domestic', label: 'Domestic flight' },
  { value: 'flight_international', label: 'International flight' },
  { value: 'hotel', label: 'Hotel' },
  { value: 'car_rental', label: 'Car rental' },
]

const VERDICT_STYLE: Record<string, { bg: string; fg: string; label: string }> = {
  green: { bg: '#ECFDF5', fg: '#065F46', label: 'GREEN — likely auto-approved' },
  amber: { bg: '#FEF3C7', fg: '#92400E', label: 'AMBER — approval required' },
  red:   { bg: '#FEF2F2', fg: '#DC2626', label: 'RED — approval required, exceptional circumstances only' },
}

export default function RuleEngineTestPage() {
  const [companies, setCompanies] = useState<Company[]>([])
  const [selectedCompanyId, setSelectedCompanyId] = useState('')
  const [employees, setEmployees] = useState<Employee[]>([])
  const [selectedEmployeeId, setSelectedEmployeeId] = useState('')

  const [travelType, setTravelType] = useState('flight_domestic')
  const [totalCost, setTotalCost] = useState('')
  const [maxFare, setMaxFare] = useState('')
  const [advanceBookingDays, setAdvanceBookingDays] = useState('')
  const [businessClass, setBusinessClass] = useState(false)
  const [breakfastIncluded, setBreakfastIncluded] = useState(false)
  const [sponsoredTransport, setSponsoredTransport] = useState(false)

  const [loadingCompanies, setLoadingCompanies] = useState(true)
  const [loadingEmployees, setLoadingEmployees] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState<TestResult | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    fetch('/api/tmc/companies')
      .then(r => r.json())
      .then(data => { if (data.ok) setCompanies(data.companies) })
      .finally(() => setLoadingCompanies(false))
  }, [])

  useEffect(() => {
    if (!selectedCompanyId) { setEmployees([]); setSelectedEmployeeId(''); return }
    setLoadingEmployees(true)
    fetch(`/api/tmc/employee-assignments?companyId=${selectedCompanyId}`)
      .then(r => r.json())
      .then(data => { if (data.ok) setEmployees(data.employees) })
      .finally(() => setLoadingEmployees(false))
  }, [selectedCompanyId])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    setError('')
    setResult(null)
    try {
      const res = await fetch('/api/rule-engine/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          employeeId: selectedEmployeeId,
          travelType,
          totalCost: Number(totalCost) || 0,
          numericValues: {
            ...(travelType.startsWith('flight') && maxFare ? { [travelType === 'flight_domestic' ? 'max_fare_domestic' : 'max_fare_intl']: Number(maxFare) } : {}),
            ...(advanceBookingDays ? { advance_booking_days: Number(advanceBookingDays) } : {}),
          },
          booleanValues: {
            business_class_allowed: businessClass,
            breakfast_included: breakfastIncluded,
            sponsored_transport_allowed: sponsoredTransport,
          },
        }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error || 'Could not run Rule Engine test.'); return }
      setResult(data.result)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div style={s.root}>
      <div style={s.header}>
        <h1 style={s.heading}>Rule Engine test</h1>
        <p style={s.sub}>
          Enter mock booking details and see the verdict the Rule Engine would produce.
          No real booking or search involved — this exists to verify policy logic directly.
        </p>
      </div>

      <form onSubmit={handleSubmit} style={s.formCard}>
        <div style={s.fields}>
          <div style={s.field}>
            <label style={s.label}>Company</label>
            <select
              value={selectedCompanyId}
              onChange={e => setSelectedCompanyId(e.target.value)}
              style={s.input}
              disabled={loadingCompanies}
            >
              <option value="">{loadingCompanies ? 'Loading…' : 'Select a company…'}</option>
              {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>

          <div style={s.field}>
            <label style={s.label}>Employee</label>
            <select
              value={selectedEmployeeId}
              onChange={e => setSelectedEmployeeId(e.target.value)}
              style={s.input}
              disabled={!selectedCompanyId || loadingEmployees}
            >
              <option value="">
                {!selectedCompanyId ? 'Select a company first' : loadingEmployees ? 'Loading…' : 'Select an employee…'}
              </option>
              {employees.map(e => (
                <option key={e.id} value={e.id}>{e.full_name} ({e.band_code ?? 'no band'})</option>
              ))}
            </select>
          </div>

          <div style={s.field}>
            <label style={s.label}>Travel type</label>
            <select value={travelType} onChange={e => setTravelType(e.target.value)} style={s.input}>
              {TRAVEL_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </div>

          <div style={s.field}>
            <label style={s.label}>Total cost (₹)</label>
            <input type="number" required value={totalCost} onChange={e => setTotalCost(e.target.value)} style={s.input} placeholder="e.g. 15000" />
          </div>

          {travelType.startsWith('flight') && (
            <div style={s.field}>
              <label style={s.label}>Actual fare (₹)</label>
              <input type="number" value={maxFare} onChange={e => setMaxFare(e.target.value)} style={s.input} placeholder="e.g. 8000" />
            </div>
          )}

          {travelType.startsWith('flight') && (
            <div style={s.field}>
              <label style={s.label}>Days booked in advance</label>
              <input type="number" value={advanceBookingDays} onChange={e => setAdvanceBookingDays(e.target.value)} style={s.input} placeholder="e.g. 3" />
            </div>
          )}
        </div>

        {travelType.startsWith('flight') && (
          <div style={s.checkboxGroup}>
            <label style={s.checkboxRow}>
              <input type="checkbox" checked={businessClass} onChange={e => setBusinessClass(e.target.checked)} />
              Booked business class
            </label>
            <label style={s.checkboxRow}>
              <input type="checkbox" checked={breakfastIncluded} onChange={e => setBreakfastIncluded(e.target.checked)} />
              Breakfast included
            </label>
            <label style={s.checkboxRow}>
              <input type="checkbox" checked={sponsoredTransport} onChange={e => setSponsoredTransport(e.target.checked)} />
              Sponsored transport used
            </label>
          </div>
        )}

        {error && <div style={s.errorBanner}>✕ {error}</div>}

        <button
          type="submit"
          disabled={submitting || !selectedEmployeeId}
          style={{ ...s.primaryBtn, opacity: submitting || !selectedEmployeeId ? 0.6 : 1 }}
        >
          {submitting ? 'Checking…' : 'Run Rule Engine →'}
        </button>
      </form>

      {result && (
        <div style={s.resultCard}>
          {!result.ok ? (
            <div style={s.blockedBanner}>
              <p style={s.blockedTitle}>⚠ {result.reason === 'no_policy_group' ? 'No policy group assigned' : 'No policy rules configured'}</p>
              <p style={s.blockedMsg}>{result.message}</p>
            </div>
          ) : (
            <>
              <div style={{ ...s.verdictBanner, background: VERDICT_STYLE[result.verdict!].bg }}>
                <span style={{ ...s.verdictLabel, color: VERDICT_STYLE[result.verdict!].fg }}>
                  {VERDICT_STYLE[result.verdict!].label}
                </span>
              </div>
              <p style={s.metaText}>
                Policy group: <strong>{result.policyGroupName}</strong> · Band: <strong>{result.bandCode}</strong> · Cost tier: <strong>{result.costTier}</strong>
              </p>

              {result.breaches && result.breaches.length > 0 ? (
                <div style={s.breachList}>
                  <p style={s.breachTitle}>Policy breaches:</p>
                  {result.breaches.map((b, i) => (
                    <div key={i} style={{
                      ...s.breachRow,
                      borderColor: b.severity === 'red' ? '#FECACA' : '#FDE68A',
                      background: b.severity === 'red' ? '#FEF2F2' : '#FFFBEB',
                    }}>
                      <span style={s.breachKey}>{b.limit_key}</span>
                      <span style={s.breachDetail}>
                        policy: {String(b.policyValue)} · actual: {String(b.actualValue)} · {b.severity}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <p style={s.mutedText}>No policy breaches — this booking is fully within policy.</p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  root: { fontFamily: "'Inter', -apple-system, sans-serif", maxWidth: '640px' },
  header: { marginBottom: '20px' },
  heading: { fontSize: '20px', fontWeight: 600, color: '#0A0A14', margin: '0 0 4px', letterSpacing: '-0.3px' },
  sub: { fontSize: '13px', color: '#6B7280', margin: 0, lineHeight: '1.5' },
  formCard: { background: '#fff', border: '1px solid #E5E7EB', borderRadius: '10px', padding: '20px', marginBottom: '20px' },
  fields: { display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '14px', marginBottom: '14px' },
  field: { display: 'flex', flexDirection: 'column', gap: '5px' },
  label: { fontSize: '11px', fontWeight: 500, color: '#374151' },
  input: { height: '36px', padding: '0 10px', fontSize: '13px', color: '#111827', background: '#F9FAFB', border: '1px solid #E5E7EB', borderRadius: '6px', outline: 'none' },
  checkboxGroup: { display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '16px', padding: '12px', background: '#F9FAFB', borderRadius: '8px' },
  checkboxRow: { display: 'flex', alignItems: 'center', gap: '7px', fontSize: '12px', color: '#374151' },
  errorBanner: { background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: '8px', padding: '10px 14px', fontSize: '12px', color: '#DC2626', marginBottom: '14px' },
  primaryBtn: { height: '38px', padding: '0 18px', background: '#000835', color: '#fff', fontSize: '13px', fontWeight: 600, border: 'none', borderRadius: '7px', cursor: 'pointer' },
  resultCard: { background: '#fff', border: '1px solid #E5E7EB', borderRadius: '10px', padding: '20px' },
  blockedBanner: { background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: '8px', padding: '14px' },
  blockedTitle: { fontSize: '13px', fontWeight: 600, color: '#DC2626', margin: '0 0 4px' },
  blockedMsg: { fontSize: '12px', color: '#7F1D1D', margin: 0, lineHeight: '1.5' },
  verdictBanner: { borderRadius: '8px', padding: '14px', marginBottom: '10px', textAlign: 'center' as const },
  verdictLabel: { fontSize: '14px', fontWeight: 700, letterSpacing: '0.3px' },
  metaText: { fontSize: '12px', color: '#6B7280', margin: '0 0 14px' },
  breachList: { display: 'flex', flexDirection: 'column', gap: '6px' },
  breachTitle: { fontSize: '12px', fontWeight: 600, color: '#374151', margin: '0 0 4px' },
  breachRow: { border: '1px solid', borderRadius: '6px', padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: '2px' },
  breachKey: { fontSize: '12px', fontWeight: 600, color: '#111827' },
  breachDetail: { fontSize: '11px', color: '#6B7280' },
  mutedText: { fontSize: '12px', color: '#9CA3AF', margin: 0 },
}