'use client'

import { useEffect, useState } from 'react'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Company {
  id: string
  name: string
}

interface PolicyGroup {
  id: string
  name: string
  description: string | null
  employeeCount: number
}

interface RuleRow {
  id?: string
  band_code: string
  travel_type: string
  limit_key: string
  limit_value: number | null
  limit_bool: boolean | null
}

interface EmployeeAssignment {
  id: string
  full_name: string
  email: string
  band_code: string | null
  status: string
  policyGroupId: string | null
}

// ── Rule definitions ────────────────────────────────────────────────────────

type FieldKind = 'numeric' | 'boolean'

interface FieldDef {
  key: string
  label: string
  unit: string
  kind: FieldKind
  travelType: 'flight' | 'hotel' | 'car' | 'approval'
}

const FIELDS: FieldDef[] = [
  { key: 'max_fare_domestic',           label: 'Max domestic fare',    unit: '₹',       kind: 'numeric', travelType: 'flight'   },
  { key: 'max_fare_intl',               label: 'Max international fare', unit: '₹',    kind: 'numeric', travelType: 'flight'   },
  { key: 'business_class_allowed',      label: 'Business class allowed', unit: '',     kind: 'boolean', travelType: 'flight'   },
  { key: 'breakfast_included',          label: 'Breakfast included',   unit: '',        kind: 'boolean', travelType: 'flight'   },
  { key: 'sponsored_transport_allowed', label: 'Sponsored transport allowed', unit: '', kind: 'boolean', travelType: 'flight'   },
  { key: 'advance_booking_days',        label: 'Min. advance booking', unit: 'days',    kind: 'numeric', travelType: 'flight'   },
  { key: 'max_rate_major_city',         label: 'Max hotel rate (major city)', unit: '₹/night', kind: 'numeric', travelType: 'hotel' },
  { key: 'max_rate_other_city',         label: 'Max hotel rate (other city)', unit: '₹/night', kind: 'numeric', travelType: 'hotel' },
  { key: 'max_hotel_stars',             label: 'Max hotel stars',      unit: '★',       kind: 'numeric', travelType: 'hotel'    },
  { key: 'max_car_rate_per_day',        label: 'Max car rate',         unit: '₹/day',   kind: 'numeric', travelType: 'car'      },
  { key: 'auto_approve_under',          label: 'Auto-approve under',   unit: '₹',       kind: 'numeric', travelType: 'approval' },
  { key: 'finance_approval_over',       label: 'Finance approval required over', unit: '₹', kind: 'numeric', travelType: 'approval' },
]

const TRAVEL_TYPE_LABELS: Record<string, string> = {
  flight: 'Flights', hotel: 'Hotels', car: 'Car rental', approval: 'Approval thresholds',
}
const TRAVEL_TYPE_COLORS: Record<string, string> = {
  flight: '#EEF2FF', hotel: '#F0FDF4', car: '#FFF7ED', approval: '#F9FAFB',
}

const BAND_CODES = ['L1', 'L2', 'L3', 'L4', 'L5'] // TODO: TMC-configurable, follow-up item

// ── Helpers ───────────────────────────────────────────────────────────────────

type Grid = Record<string, Record<string, number | boolean | null>>

function buildEmptyGrid(): Grid {
  const grid: Grid = {}
  for (const band of BAND_CODES) {
    grid[band] = {}
    for (const f of FIELDS) grid[band][f.key] = f.kind === 'boolean' ? false : null
  }
  return grid
}

function rowsToGrid(rows: RuleRow[]): Grid {
  const grid = buildEmptyGrid()
  for (const row of rows) {
    if (!grid[row.band_code]) grid[row.band_code] = {}
    grid[row.band_code][row.limit_key] = row.limit_value ?? row.limit_bool ?? null
  }
  return grid
}

function gridToRules(grid: Grid): RuleRow[] {
  const rows: RuleRow[] = []
  for (const band of BAND_CODES) {
    for (const f of FIELDS) {
      const val = grid[band]?.[f.key]
      if (val === null || val === undefined) continue // unset fields aren't submitted
      rows.push({
        band_code: band,
        travel_type: f.travelType,
        limit_key: f.key,
        limit_value: f.kind === 'numeric' ? Number(val) : null,
        limit_bool: f.kind === 'boolean' ? Boolean(val) : null,
      })
    }
  }
  return rows
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function TmcPolicyPage() {
  const [tab, setTab] = useState<'rules' | 'employees'>('rules')

  const [companies, setCompanies] = useState<Company[]>([])
  const [selectedCompanyId, setSelectedCompanyId] = useState('')
  const [groups, setGroups] = useState<PolicyGroup[]>([])
  const [selectedGroupId, setSelectedGroupId] = useState('')

  const [employees, setEmployees] = useState<EmployeeAssignment[]>([])
  const [loadingEmployees, setLoadingEmployees] = useState(false)

  const [grid, setGrid] = useState<Grid>(buildEmptyGrid())
  const [version, setVersion] = useState(0)

  const [loadingCompanies, setLoadingCompanies] = useState(true)
  const [loadingGroups, setLoadingGroups] = useState(false)
  const [loadingRules, setLoadingRules] = useState(false)
  const [saving, setSaving] = useState(false)

  const [showGroupForm, setShowGroupForm] = useState(false)
  const [groupForm, setGroupForm] = useState({ name: '', description: '' })
  const [groupSubmitting, setGroupSubmitting] = useState(false)

  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  useEffect(() => {
    fetch('/api/tmc/companies')
      .then(r => r.json())
      .then(data => { if (data.ok) setCompanies(data.companies) })
      .finally(() => setLoadingCompanies(false))
  }, [])

  useEffect(() => {
    if (!selectedCompanyId) { setGroups([]); setSelectedGroupId(''); return }
    loadGroups(selectedCompanyId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCompanyId])

  useEffect(() => {
    if (!selectedCompanyId || !selectedGroupId) { setGrid(buildEmptyGrid()); setVersion(0); return }
    loadRules(selectedCompanyId, selectedGroupId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCompanyId, selectedGroupId])

  useEffect(() => {
    if (tab !== 'employees' || !selectedCompanyId) return
    loadEmployees(selectedCompanyId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, selectedCompanyId])

  async function loadEmployees(companyId: string) {
    setLoadingEmployees(true)
    setError('')
    try {
      const res = await fetch(`/api/tmc/employee-assignments?companyId=${companyId}`)
      const data = await res.json()
      if (!res.ok) { setError(data.error || 'Could not load employees.'); return }
      setEmployees(data.employees)
    } finally {
      setLoadingEmployees(false)
    }
  }

  async function handleAssignGroup(employeeId: string, policyGroupId: string) {
    setError(''); setSuccess('')
    const res = await fetch('/api/tmc/employee-assignments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employeeId, policyGroupId }),
    })
    const data = await res.json()
    if (!res.ok) { setError(data.error || 'Could not assign policy group.'); return }
    setEmployees(prev => prev.map(e => e.id === employeeId ? { ...e, policyGroupId } : e))
    setSuccess('Policy group assigned.')
  }

  async function loadGroups(companyId: string) {
    setLoadingGroups(true)
    setError('')
    try {
      const res = await fetch(`/api/tmc/policy-groups?companyId=${companyId}`)
      const data = await res.json()
      if (!res.ok) { setError(data.error || 'Could not load policy groups.'); return }
      setGroups(data.groups)
      setSelectedGroupId('')
    } finally {
      setLoadingGroups(false)
    }
  }

  async function loadRules(companyId: string, groupId: string) {
    setLoadingRules(true)
    setError('')
    try {
      const res = await fetch(`/api/tmc/policy-rules?companyId=${companyId}&groupId=${groupId}`)
      const data = await res.json()
      if (!res.ok) { setError(data.error || 'Could not load policy rules.'); return }
      setGrid(rowsToGrid(data.rows))
      setVersion(data.version)
    } finally {
      setLoadingRules(false)
    }
  }

  async function handleCreateGroup(e: React.FormEvent) {
    e.preventDefault()
    setGroupSubmitting(true)
    setError('')
    try {
      const res = await fetch('/api/tmc/policy-groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId: selectedCompanyId, ...groupForm }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error || 'Could not create policy group.'); return }
      setGroupForm({ name: '', description: '' })
      setShowGroupForm(false)
      await loadGroups(selectedCompanyId)
      setSelectedGroupId(data.group.id)
      setSuccess('Policy group created.')
    } finally {
      setGroupSubmitting(false)
    }
  }

  async function handleDeleteGroup(id: string) {
    if (!confirm('Delete this policy group? This only works if no employees are assigned to it.')) return
    setError(''); setSuccess('')
    const res = await fetch(`/api/tmc/policy-groups/${id}`, { method: 'DELETE' })
    const data = await res.json()
    if (!res.ok) { setError(data.error || 'Could not delete policy group.'); return }
    setSuccess('Policy group deleted.')
    if (selectedGroupId === id) setSelectedGroupId('')
    loadGroups(selectedCompanyId)
  }

  function handleCellChange(band: string, key: string, value: number | boolean | null) {
    setGrid(prev => ({ ...prev, [band]: { ...prev[band], [key]: value } }))
    setSuccess('')
  }

  async function handleSaveRules() {
    setSaving(true)
    setError('')
    setSuccess('')
    try {
      const rules = gridToRules(grid)
      if (rules.length === 0) {
        setError('Set at least one value before saving.')
        return
      }
      const res = await fetch('/api/tmc/policy-rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId: selectedCompanyId, policyGroupId: selectedGroupId, rules }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error || 'Could not save policy rules.'); return }
      setVersion(data.newVersion)
      setSuccess(`Policy saved as version ${data.newVersion}.`)
    } finally {
      setSaving(false)
    }
  }

  const travelTypes = ['flight', 'hotel', 'car', 'approval'] as const
  const selectedGroup = groups.find(g => g.id === selectedGroupId)

  return (
    <div style={s.root}>
        <div style={s.header}>
          <h1 style={s.heading}>Policy</h1>
          <p style={s.sub}>Set travel policy per client, by policy group and band.</p>
        </div>

        <div style={s.selectorRow}>
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
        </div>

        {selectedCompanyId && (
          <div style={s.tabRow}>
            <button
              onClick={() => setTab('rules')}
              style={{ ...s.tabBtn, ...(tab === 'rules' ? s.tabBtnActive : {}) }}
            >
              Policy rules
            </button>
            <button
              onClick={() => setTab('employees')}
              style={{ ...s.tabBtn, ...(tab === 'employees' ? s.tabBtnActive : {}) }}
            >
              Assign employees
            </button>
          </div>
        )}

        {error && <div style={s.errorBanner}>✕ {error}</div>}
        {success && <div style={s.successBanner}>✓ {success}</div>}

        {selectedCompanyId && tab === 'employees' && (
          <div style={s.rulesSection}>
            <h2 style={s.sectionTitle}>Employee → policy group assignments</h2>
            <p style={s.mutedText}>Each employee belongs to exactly one policy group. Reassigning replaces their current group.</p>

            {loadingEmployees ? (
              <p style={s.mutedText}>Loading employees…</p>
            ) : employees.length === 0 ? (
              <p style={s.mutedText}>No employees found for this company.</p>
            ) : groups.length === 0 ? (
              <p style={s.mutedText}>Create a policy group first, under the "Policy rules" tab.</p>
            ) : (
              <table style={s.table}>
                <thead>
                  <tr>
                    {['Name', 'Email', 'Band', 'Status', 'Policy group'].map(h => (
                      <th key={h} style={s.th}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {employees.map((emp, i) => (
                    <tr key={emp.id} style={{ background: i % 2 === 0 ? '#fff' : '#FAFAFA' }}>
                      <td style={s.td}>{emp.full_name}</td>
                      <td style={{ ...s.td, color: '#6B7280' }}>{emp.email}</td>
                      <td style={s.td}>{emp.band_code ?? '—'}</td>
                      <td style={s.td}>{emp.status}</td>
                      <td style={s.td}>
                        <select
                          value={emp.policyGroupId ?? ''}
                          onChange={e => handleAssignGroup(emp.id, e.target.value)}
                          style={s.cellSelect}
                        >
                          <option value="" disabled>Unassigned — select a group</option>
                          {groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        {selectedCompanyId && tab === 'rules' && (
          <>
            <div style={s.groupSection}>
              <div style={s.groupSectionHeader}>
                <h2 style={s.sectionTitle}>Policy groups</h2>
                <button onClick={() => setShowGroupForm(v => !v)} style={s.ghostBtn}>
                  {showGroupForm ? 'Cancel' : '+ New group'}
                </button>
              </div>

              {showGroupForm && (
                <form onSubmit={handleCreateGroup} style={s.groupForm}>
                  <input
                    type="text" required placeholder="Group name (e.g. L1-L3, L4 IT)"
                    value={groupForm.name}
                    onChange={e => setGroupForm(prev => ({ ...prev, name: e.target.value }))}
                    style={s.input}
                  />
                  <input
                    type="text" placeholder="Description (optional)"
                    value={groupForm.description}
                    onChange={e => setGroupForm(prev => ({ ...prev, description: e.target.value }))}
                    style={s.input}
                  />
                  <button type="submit" disabled={groupSubmitting} style={{ ...s.primaryBtn, opacity: groupSubmitting ? 0.7 : 1 }}>
                    {groupSubmitting ? 'Creating…' : 'Create'}
                  </button>
                </form>
              )}

              {loadingGroups ? (
                <p style={s.mutedText}>Loading groups…</p>
              ) : groups.length === 0 ? (
                <p style={s.mutedText}>No policy groups yet for this company. Create one to start setting rules.</p>
              ) : (
                <div style={s.groupChips}>
                  {groups.map(g => (
                    <div
                      key={g.id}
                      onClick={() => setSelectedGroupId(g.id)}
                      style={{
                        ...s.groupChip,
                        borderColor: g.id === selectedGroupId ? '#000835' : '#E5E7EB',
                        background: g.id === selectedGroupId ? '#EEF2FF' : '#fff',
                      }}
                    >
                      <span style={s.groupChipName}>{g.name}</span>
                      <span style={s.groupChipMeta}>{g.employeeCount} employee{g.employeeCount === 1 ? '' : 's'}</span>
                      <button
                        onClick={e => { e.stopPropagation(); handleDeleteGroup(g.id) }}
                        style={s.groupChipDelete}
                        title="Delete group"
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {selectedGroupId && (
              <div style={s.rulesSection}>
                <div style={s.rulesHeader}>
                  <div>
                    <h2 style={s.sectionTitle}>{selectedGroup?.name} — rules</h2>
                    <p style={s.mutedText}>
                      {version === 0
                        ? 'No rules saved yet. Set values below and save to create version 1.'
                        : `Version ${version} · saving creates a new version, full history is preserved.`}
                    </p>
                  </div>
                  <button onClick={handleSaveRules} disabled={saving || loadingRules} style={{ ...s.primaryBtn, opacity: saving || loadingRules ? 0.6 : 1 }}>
                    {saving ? 'Saving…' : 'Save changes →'}
                  </button>
                </div>

                {loadingRules ? (
                  <p style={s.mutedText}>Loading rules…</p>
                ) : (
                  <div style={s.tables}>
                    {travelTypes.map(tt => {
                      const fields = FIELDS.filter(f => f.travelType === tt)
                      return (
                        <div key={tt} style={s.tableSection}>
                          <div style={{ ...s.tableSectionHeader, background: TRAVEL_TYPE_COLORS[tt] }}>
                            <span style={s.tableSectionTitle}>{TRAVEL_TYPE_LABELS[tt]}</span>
                          </div>
                          <div style={s.tableWrap}>
                            <table style={s.table}>
                              <thead>
                                <tr>
                                  <th style={{ ...s.th, ...s.stickyCol, width: 90 }}>Band</th>
                                  {fields.map(f => (
                                    <th key={f.key} style={{ ...s.th, minWidth: 130 }}>
                                      <span style={s.colLabel}>{f.label}</span>
                                      {f.unit && <span style={s.colUnit}>{f.unit}</span>}
                                    </th>
                                  ))}
                                </tr>
                              </thead>
                              <tbody>
                                {BAND_CODES.map((band, ri) => (
                                  <tr key={band} style={{ background: ri % 2 === 0 ? '#fff' : '#FAFAFA' }}>
                                    <td style={{ ...s.td, ...s.stickyCol }}>
                                      <span style={s.bandBadge}>{band}</span>
                                    </td>
                                    {fields.map(f => {
                                      const val = grid[band]?.[f.key]
                                      if (f.kind === 'boolean') {
                                        return (
                                          <td key={f.key} style={s.td}>
                                            <input
                                              type="checkbox"
                                              checked={Boolean(val)}
                                              onChange={e => handleCellChange(band, f.key, e.target.checked)}
                                              style={s.checkbox}
                                            />
                                          </td>
                                        )
                                      }
                                      return (
                                        <td key={f.key} style={s.td}>
                                          <input
                                            type="number"
                                            value={val === null || val === undefined ? '' : Number(val)}
                                            onChange={e => handleCellChange(band, f.key, e.target.value === '' ? null : Number(e.target.value))}
                                            placeholder="—"
                                            min={0}
                                            style={s.cellInput}
                                          />
                                        </td>
                                      )
                                    })}
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )}
          </>
        )}
    </div>
  )
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  root: { fontFamily: "'Inter', -apple-system, sans-serif" },
  header: { marginBottom: '20px' },
  heading: { fontSize: '20px', fontWeight: 600, color: '#0A0A14', margin: '0 0 4px', letterSpacing: '-0.3px' },
  sub: { fontSize: '13px', color: '#6B7280', margin: 0 },
  selectorRow: { marginBottom: '20px', maxWidth: '360px' },
  tabRow: { display: 'flex', gap: '4px', marginBottom: '16px', borderBottom: '1px solid #E5E7EB' },
  tabBtn: { padding: '8px 14px', background: 'transparent', border: 'none', borderBottom: '2px solid transparent', fontSize: '13px', color: '#6B7280', cursor: 'pointer', marginBottom: '-1px' },
  tabBtnActive: { color: '#000835', fontWeight: 600, borderBottomColor: '#000835' },
  cellSelect: { fontSize: '12px', color: '#374151', padding: '5px 8px', border: '1px solid #E5E7EB', borderRadius: '5px', background: '#fff' },
  field: { display: 'flex', flexDirection: 'column', gap: '6px' },
  label: { fontSize: '12px', fontWeight: 500, color: '#374151' },
  input: { height: '38px', padding: '0 10px', fontSize: '13px', color: '#111827', background: '#fff', border: '1px solid #D1D5DB', borderRadius: '7px', outline: 'none' },
  errorBanner: { background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: '8px', padding: '10px 14px', fontSize: '12px', color: '#DC2626', marginBottom: '16px' },
  successBanner: { background: '#ECFDF5', border: '1px solid #A7F3D0', borderRadius: '8px', padding: '10px 14px', fontSize: '12px', color: '#065F46', marginBottom: '16px' },
  groupSection: { background: '#fff', border: '1px solid #E5E7EB', borderRadius: '10px', padding: '18px', marginBottom: '20px' },
  groupSectionHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' },
  sectionTitle: { fontSize: '14px', fontWeight: 600, color: '#111827', margin: 0 },
  ghostBtn: { height: '32px', padding: '0 12px', background: 'transparent', color: '#374151', fontSize: '12px', border: '1px solid #D1D5DB', borderRadius: '6px', cursor: 'pointer' },
  groupForm: { display: 'flex', gap: '10px', marginBottom: '14px' },
  primaryBtn: { height: '36px', padding: '0 16px', background: '#000835', color: '#fff', fontSize: '13px', fontWeight: 600, border: 'none', borderRadius: '7px', cursor: 'pointer', whiteSpace: 'nowrap' as const },
  mutedText: { fontSize: '12px', color: '#9CA3AF', margin: 0 },
  groupChips: { display: 'flex', flexWrap: 'wrap' as const, gap: '10px' },
  groupChip: { display: 'flex', flexDirection: 'column', gap: '2px', padding: '10px 14px', border: '1.5px solid', borderRadius: '8px', cursor: 'pointer', position: 'relative' as const, minWidth: '140px' },
  groupChipName: { fontSize: '13px', fontWeight: 600, color: '#111827' },
  groupChipMeta: { fontSize: '11px', color: '#9CA3AF' },
  groupChipDelete: { position: 'absolute' as const, top: '6px', right: '8px', background: 'transparent', border: 'none', color: '#D1D5DB', fontSize: '12px', cursor: 'pointer' },
  rulesSection: { background: '#fff', border: '1px solid #E5E7EB', borderRadius: '10px', padding: '18px' },
  rulesHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '16px' },
  tables: { display: 'flex', flexDirection: 'column', gap: '16px' },
  tableSection: { border: '1px solid #E5E7EB', borderRadius: '8px', overflow: 'hidden' },
  tableSectionHeader: { padding: '8px 14px', borderBottom: '1px solid #E5E7EB' },
  tableSectionTitle: { fontSize: '12px', fontWeight: 600, color: '#374151' },
  tableWrap: { overflowX: 'auto' as const },
  table: { borderCollapse: 'collapse' as const, width: '100%' },
  th: { padding: '8px 10px', textAlign: 'left' as const, background: '#F9FAFB', borderBottom: '1px solid #E5E7EB', whiteSpace: 'nowrap' as const },
  colLabel: { display: 'block', fontSize: '11px', fontWeight: 600, color: '#374151' },
  colUnit: { fontSize: '10px', color: '#9CA3AF' },
  stickyCol: { position: 'sticky' as const, left: 0, background: '#F9FAFB', borderRight: '1px solid #E5E7EB' },
  td: { padding: '7px 10px', borderBottom: '1px solid #F3F4F6' },
  bandBadge: { display: 'inline-block', padding: '2px 6px', background: '#EEF2FF', color: '#3730A3', fontSize: '10px', fontWeight: 700, borderRadius: '4px' },
  cellInput: { width: '90px', height: '28px', padding: '0 7px', fontSize: '12px', color: '#111827', background: '#F9FAFB', border: '1px solid transparent', borderRadius: '4px', outline: 'none' },
  checkbox: { width: '16px', height: '16px', cursor: 'pointer' },
}