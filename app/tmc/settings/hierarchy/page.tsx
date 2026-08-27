'use client'

import { useEffect, useMemo, useState } from 'react'

// ── /tmc/settings/hierarchy ──────────────────────────────────────────────────
// Sets who each of a client's employees reports to (employees.manager_id).
//
// This lives on the TMC side because the TMC configures approval routing, and a
// step of type 'manager' resolves through manager_id. If only the corporate
// admin could set it, a TMC could build a chain whose first step resolves to
// nobody and have no way to fix it. The client keeps a read-only view at
// /settings/hierarchy.
// ─────────────────────────────────────────────────────────────────────────────

interface Company { id: string; name: string }

interface Employee {
  id: string
  full_name: string
  email: string
  band_code: string | null
  band_rank: number | null
  status: string
  manager_id: string | null
  top_of_hierarchy: boolean
}

interface Band {
  id: string
  code: string
  label: string
  rank: number
}

// Sentinel for the manager dropdown. A blank value means `not set up yet`,
// which is a real gap worth warning about; this means `nobody is above them`,
// which is a finished state.
const TOP_OF_HIERARCHY = '__top__'

export default function TmcHierarchyPage() {
  const [companies, setCompanies] = useState<Company[]>([])
  const [companyId, setCompanyId] = useState('')
  const [employees, setEmployees] = useState<Employee[]>([])
  const [bands, setBands] = useState<Band[]>([])
  const [loading, setLoading] = useState(false)
  const [savingId, setSavingId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  useEffect(() => {
    fetch('/api/tmc/companies').then(r => r.json())
      .then(d => { if (d.ok) setCompanies(d.companies) })
  }, [])

  useEffect(() => {
    if (!companyId) { setEmployees([]); return }
    loadEmployees(companyId)
  }, [companyId])

  async function loadEmployees(id: string) {
    setLoading(true); setError('')
    try {
      const [employeeData, bandData] = await Promise.all([
        fetch(`/api/tmc/employees?companyId=${id}`).then(r => r.json()),
        fetch(`/api/tmc/bands?companyId=${id}`).then(r => r.json()),
      ])
      if (!employeeData.ok) { setError(employeeData.error || 'Could not load employees.'); return }
      setEmployees(employeeData.employees)
      if (bandData.ok) setBands(bandData.bands)
    } finally { setLoading(false) }
  }

  // Optimistic, then reverted on failure. The server rejects self-reference and
  // reporting loops, and only it can see the whole chain — so a rejection here
  // is expected behaviour, not an edge case.
  async function patch(employeeId: string, body: Record<string, unknown>, optimistic: Partial<Employee>) {
    const previous = employees
    setEmployees(prev => prev.map(e => e.id === employeeId ? { ...e, ...optimistic } : e))
    setSavingId(employeeId); setError(''); setSuccess('')

    try {
      const d = await fetch(`/api/tmc/employees/${employeeId}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }).then(r => r.json())

      if (!d.ok) {
        setEmployees(previous)
        setError(d.error || 'Could not save that change.')
        return
      }
      setSuccess('Saved.')
    } catch {
      setEmployees(previous)
      setError('Could not reach the server. Please try again.')
    } finally { setSavingId(null) }
  }

  function setManager(employeeId: string, value: string) {
    if (value === TOP_OF_HIERARCHY) {
      return patch(employeeId, { topOfHierarchy: true }, { manager_id: null, top_of_hierarchy: true })
    }
    return patch(
      employeeId,
      { managerId: value || null, topOfHierarchy: false },
      { manager_id: value || null, top_of_hierarchy: false }
    )
  }

  function setBand(employeeId: string, code: string) {
    const band = bands.find(b => b.code === code)
    return patch(employeeId, { band: code }, { band_code: code, band_rank: band?.rank ?? null })
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return employees
    return employees.filter(e =>
      e.full_name.toLowerCase().includes(q) || e.email.toLowerCase().includes(q)
    )
  }, [employees, query])

  // Someone marked top of hierarchy is finished, not unconfigured — counting
  // them here is what made the owner of a company a permanent warning.
  const unassignedCount = employees.filter(
    e => e.status === 'active' && !e.manager_id && !e.top_of_hierarchy
  ).length

  return (
    <div style={s.root}>
      <div style={s.header}>
        <h1 style={s.title}>Hierarchy &amp; bands</h1>
        <p style={s.sub}>
          Who each employee reports to, and which band they sit in. Approval steps set to
          &quot;the traveller&apos;s own manager&quot; resolve through the reporting line; policy
          limits match on band rank. Mark the person at the top as{' '}
          <strong>Nobody — top of hierarchy</strong> so they stop counting as unconfigured.
        </p>
      </div>

      <div style={s.field}>
        <label style={s.label}>Client</label>
        <select value={companyId} onChange={e => setCompanyId(e.target.value)} style={{ ...s.input, width: 260 }}>
          <option value="">Select a client…</option>
          {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </div>

      {error && <div style={s.errorBanner}>✕ {error}</div>}
      {success && <div style={s.successBanner}>✓ {success}</div>}

      {!companyId ? (
        <p style={s.muted}>Pick a client to set their reporting lines.</p>
      ) : loading ? (
        <div style={s.loadingWrap}><div style={s.spinner} /></div>
      ) : (
        <>
          {unassignedCount > 0 && (
            <div style={s.warnBanner}>
              <strong>{unassignedCount} active employee{unassignedCount === 1 ? '' : 's'}</strong> have
              no manager set.
            </div>
          )}

          <input
            type="search"
            placeholder="Search name or email…"
            value={query}
            onChange={e => setQuery(e.target.value)}
            style={s.search}
          />

          <div style={s.tableWrap}>
            <table style={s.table}>
              <thead>
                <tr>
                  {['Employee', 'Band', 'Status', 'Reports to'].map(h => (
                    <th key={h} style={s.th}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map(emp => {
                  const missing = emp.status === 'active' && !emp.manager_id && !emp.top_of_hierarchy
                  return (
                    <tr key={emp.id} style={s.tr}>
                      <td style={s.td}>
                        <div style={s.name}>{emp.full_name}</div>
                        <div style={s.email}>{emp.email}</div>
                      </td>
                      <td style={s.td}>
                        <select
                          value={emp.band_code ?? ''}
                          onChange={e => setBand(emp.id, e.target.value)}
                          disabled={savingId === emp.id || bands.length === 0}
                          style={{ ...s.input, minWidth: 150 }}
                        >
                          <option value="" disabled>
                            {bands.length === 0 ? 'No bands configured' : 'Pick a band…'}
                          </option>
                          {bands.map(b => (
                            <option key={b.id} value={b.code}>
                              {b.code} · {b.label} (rank {b.rank})
                            </option>
                          ))}
                        </select>
                      </td>
                      <td style={s.td}>{emp.status}</td>
                      <td style={s.td}>
                        <div style={s.managerCell}>
                          <select
                            value={emp.top_of_hierarchy ? TOP_OF_HIERARCHY : (emp.manager_id ?? '')}
                            onChange={e => setManager(emp.id, e.target.value)}
                            disabled={savingId === emp.id}
                            style={{ ...s.input, minWidth: 210, ...(missing ? s.inputMissing : {}) }}
                          >
                            <option value="">Not set yet</option>
                            <option value={TOP_OF_HIERARCHY}>Nobody — top of hierarchy</option>
                            {/* Everyone except this person — the server also
                                blocks self-reference and longer loops. */}
                            {employees.filter(o => o.id !== emp.id).map(o => (
                              <option key={o.id} value={o.id}>{o.full_name}</option>
                            ))}
                          </select>
                          {savingId === emp.id && <div style={s.spinnerTiny} />}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  root: { fontFamily: "'Inter', -apple-system, sans-serif", paddingBottom: 60 },
  header: { marginBottom: '18px' },
  title: { fontSize: '22px', fontWeight: 700, color: '#0A0A14', margin: '0 0 4px', letterSpacing: '-0.4px' },
  sub: { fontSize: '13px', color: '#6B7280', margin: 0, lineHeight: 1.6, maxWidth: 640 },

  field: { display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 18 },
  label: { fontSize: 11, fontWeight: 600, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.6px' },
  input: { height: '38px', padding: '0 10px', fontSize: '13px', color: '#111827', background: '#fff', border: '1px solid #D1D5DB', borderRadius: '7px', outline: 'none' },
  inputMissing: { borderColor: '#FDE68A', background: '#FFFBEB' },

  errorBanner: { marginBottom: '16px', background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: '8px', padding: '10px 14px', fontSize: '12px', color: '#DC2626' },
  successBanner: { marginBottom: '16px', background: '#ECFDF5', border: '1px solid #A7F3D0', borderRadius: '8px', padding: '10px 14px', fontSize: '12px', color: '#065F46' },
  warnBanner: { marginBottom: '16px', background: '#FEF3C7', border: '1px solid #FDE68A', borderRadius: '8px', padding: '12px 14px', fontSize: '12px', color: '#92400E', lineHeight: 1.6 },

  search: { height: '38px', width: '100%', maxWidth: '340px', padding: '0 12px', fontSize: '13px', color: '#111827', background: '#fff', border: '1px solid #D1D5DB', borderRadius: '8px', outline: 'none', marginBottom: '16px' },

  loadingWrap: { display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '60px' },
  spinner: { width: '24px', height: '24px', border: '2.5px solid #E5E7EB', borderTopColor: '#000835', borderRadius: '50%', animation: 'spin 0.7s linear infinite' },
  spinnerTiny: { width: '14px', height: '14px', border: '2px solid #E5E7EB', borderTopColor: '#000835', borderRadius: '50%', flexShrink: 0, animation: 'spin 0.7s linear infinite' },

  tableWrap: { background: '#fff', border: '1px solid #E5E7EB', borderRadius: '10px', overflowX: 'auto' },
  table: { borderCollapse: 'collapse', width: '100%' },
  th: { padding: '10px 14px', textAlign: 'left', background: '#F9FAFB', borderBottom: '1px solid #E5E7EB', fontSize: '11px', fontWeight: 600, color: '#374151', whiteSpace: 'nowrap' },
  tr: { borderBottom: '1px solid #F3F4F6' },
  td: { padding: '10px 14px', fontSize: '13px', color: '#374151', verticalAlign: 'middle' },
  managerCell: { display: 'flex', alignItems: 'center', gap: '8px' },

  name: { fontSize: '13px', fontWeight: 500, color: '#111827' },
  email: { fontSize: '11px', color: '#9CA3AF' },
  bandBadge: { display: 'inline-block', padding: '2px 7px', background: '#EEF2FF', color: '#3730A3', fontSize: '10px', fontWeight: 700, borderRadius: '4px' },
  muted: { fontSize: 12, color: '#9CA3AF' },
}
