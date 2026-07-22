'use client'

import { useEffect, useRef, useState } from 'react'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Company { id: string; name: string }

interface PolicyGroup {
  id: string; name: string; description: string | null; employeeCount: number
}

interface RuleRow {
  band_code: string; travel_type: string; limit_key: string
  limit_value: number | null; limit_bool: boolean | null
}

interface EmployeeAssignment {
  id: string; full_name: string; email: string
  band_code: string | null; status: string; policyGroupId: string | null
}

// ── Field definitions ─────────────────────────────────────────────────────────

type FieldKind = 'numeric' | 'boolean' | 'tier'

interface TierOption { label: string; value: number }

interface FieldDef {
  key: string; label: string; unit?: string; kind: FieldKind
  travelType: string; options?: TierOption[]
  // Whole-number fields (star ratings, day counts, bag counts) round on entry.
  // Currency/₹ fields are left decimal-friendly since paise amounts are valid.
  wholeNumber?: boolean
}

const CABIN_CLASS_OPTIONS: TierOption[] = [
  { label: 'Economy',         value: 0 },
  { label: 'Premium Economy', value: 1 },
  { label: 'Business',        value: 2 },
  { label: 'First',           value: 3 },
]

// NOTE: carrier_tier and red_eye_restricted are kept per product decision,
// but are NOT yet read by evaluateBooking.ts — toggling them today has no
// effect on booking evaluation. Same caveat applies to refundable_fare_required,
// connecting_flights_allowed, and personal_trips_allowed. Wire these into
// NUMERIC_LIMIT_KEYS / BOOLEAN_ENTITLEMENT_KEYS before relying on them.
const CARRIER_OPTIONS: TierOption[] = [
  { label: 'Budget only',    value: 0 },
  { label: 'Full-service',   value: 1 },
]

interface CategoryDef {
  id: string; label: string; description?: string
  color: string; textColor: string; fields: FieldDef[]
}

const CATEGORIES: CategoryDef[] = [
  {
    id: 'flight', label: 'Flights', color: '#EEF2FF', textColor: '#3730A3',
    fields: [
      { key: 'max_fare_domestic',           label: 'Max domestic fare',         unit: '₹',    kind: 'numeric', travelType: 'flight' },
      { key: 'max_fare_intl',               label: 'Max international fare',    unit: '₹',    kind: 'numeric', travelType: 'flight' },
      { key: 'cabin_class_short_haul',      label: 'Cabin class (short haul)',              kind: 'tier',    travelType: 'flight', options: CABIN_CLASS_OPTIONS },
      { key: 'cabin_class_long_haul',       label: 'Cabin class (long haul >8h)',            kind: 'tier',    travelType: 'flight', options: CABIN_CLASS_OPTIONS },
      { key: 'max_seat_selection_fee',      label: 'Max seat selection spend',   unit: '₹',    kind: 'numeric', travelType: 'flight' },
      { key: 'carrier_tier',                label: 'Carrier tier',                           kind: 'tier',    travelType: 'flight', options: CARRIER_OPTIONS },
      { key: 'advance_booking_days',        label: 'Min. advance booking',      unit: 'days', kind: 'numeric', travelType: 'flight', wholeNumber: true },
      { key: 'baggage_extra_bags',          label: 'Extra bags allowed',        unit: 'bags', kind: 'numeric', travelType: 'flight', wholeNumber: true },
      { key: 'refundable_fare_required',    label: 'Refundable fare required',               kind: 'boolean', travelType: 'flight' },
      { key: 'connecting_flights_allowed',  label: 'Connecting flights allowed',              kind: 'boolean', travelType: 'flight' },
      { key: 'red_eye_restricted',          label: 'Red-eye flights restricted',              kind: 'boolean', travelType: 'flight' },
      { key: 'personal_trips_allowed',      label: 'Personal trips allowed',                  kind: 'boolean', travelType: 'flight' },
    ],
  },
  {
    id: 'hotel', label: 'Hotels', color: '#F0FDF4', textColor: '#14532D',
    fields: [
      { key: 'max_rate_major_city', label: 'Max rate (major city)', unit: '₹/night', kind: 'numeric', travelType: 'hotel' },
      { key: 'max_rate_other_city', label: 'Max rate (other city)', unit: '₹/night', kind: 'numeric', travelType: 'hotel' },
      { key: 'max_hotel_stars',     label: 'Max hotel stars',       unit: '★',        kind: 'numeric', travelType: 'hotel', wholeNumber: true },
      { key: 'breakfast_included',  label: 'Breakfast included',                      kind: 'boolean', travelType: 'hotel' },
    ],
  },
  {
    id: 'car', label: 'Ground transport', color: '#FFF7ED', textColor: '#7C2D12',
    description: 'Set a cap for self-booked rentals, and whether company-arranged transport is a separate option.',
    fields: [
      { key: 'max_car_rate_per_day',        label: 'Max self-arranged car rental rate', unit: '₹/day', kind: 'numeric', travelType: 'car' },
      { key: 'sponsored_transport_allowed', label: 'Company-arranged transport allowed', kind: 'boolean', travelType: 'car' },
    ],
  },
  {
    id: 'general', label: 'General', color: '#F5F3FF', textColor: '#4C1D95',
    fields: [
      { key: 'per_diem_allowance',   label: 'Per-diem allowance', unit: '₹/day', kind: 'numeric', travelType: 'general' },
      { key: 'max_trip_duration',    label: 'Max trip duration',  unit: 'days',  kind: 'numeric', travelType: 'general', wholeNumber: true },
    ],
  },
  {
    id: 'approval', label: 'Approval thresholds', color: '#F9FAFB', textColor: '#374151',
    fields: [
      { key: 'auto_approve_under',      label: 'Auto-approve under',                unit: '₹', kind: 'numeric', travelType: 'approval' },
      { key: 'finance_approval_over',   label: 'Finance approval required over',    unit: '₹', kind: 'numeric', travelType: 'approval' },
    ],
  },
]

const ALL_FIELDS: FieldDef[] = CATEGORIES.flatMap(c => c.fields)
const BAND_CODES = ['L1', 'L2', 'L3', 'L4', 'L5']
const BAND_LABELS: Record<string, string> = { L1: 'Junior', L2: 'Associate', L3: 'Senior', L4: 'Manager', L5: 'Director' }

// ── Grid helpers ──────────────────────────────────────────────────────────────

type CellVal = number | boolean | null
type Grid = Record<string, Record<string, CellVal>>

function buildEmptyGrid(): Grid {
  const g: Grid = {}
  for (const b of BAND_CODES) {
    g[b] = {}
    for (const f of ALL_FIELDS) g[b][f.key] = f.kind === 'boolean' ? false : null
  }
  return g
}

function rowsToGrid(rows: RuleRow[]): Grid {
  const g = buildEmptyGrid()
  for (const r of rows) {
    if (!g[r.band_code]) g[r.band_code] = {}
    g[r.band_code][r.limit_key] = r.limit_value ?? r.limit_bool ?? null
  }
  return g
}

function gridToRules(grid: Grid): RuleRow[] {
  const rows: RuleRow[] = []
  for (const band of BAND_CODES) {
    for (const f of ALL_FIELDS) {
      const val = grid[band]?.[f.key]
      if (val === null || val === undefined) continue
      rows.push({
        band_code: band,
        travel_type: f.travelType,
        limit_key: f.key,
        limit_value: f.kind !== 'boolean' ? Number(val) : null,
        limit_bool: f.kind === 'boolean' ? Boolean(val) : null,
      })
    }
  }
  return rows
}

// Booleans are deliberately excluded from both the numerator and the
// denominator here — they're real config, just not counted as "completion"
// factors, since a correctly-configured "false" isn't meaningfully less done
// than a correctly-configured "true".
function countSetFields(grid: Grid, category: CategoryDef): { set: number; total: number } {
  const countableFields = category.fields.filter(f => f.kind !== 'boolean')
  let set = 0
  for (const band of BAND_CODES) {
    for (const f of countableFields) {
      const val = grid[band]?.[f.key]
      if (val !== null && val !== undefined) set++
    }
  }
  return { set, total: BAND_CODES.length * countableFields.length }
}

// Small style helper that depends on state — kept OUTSIDE the `s` styles
// record so its return type isn't collapsed to React.CSSProperties by the
// object's type annotation (that collapse is what caused the "not callable" error).
function groupIndicatorStyle(active: boolean): React.CSSProperties {
  return {
    width: 8,
    height: 8,
    borderRadius: '50%',
    background: active ? '#000835' : '#D1D5DB',
    flexShrink: 0,
  }
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function TmcPolicyPage() {
  const [tab, setTab] = useState<'rules' | 'employees'>('rules')
  const [companies, setCompanies] = useState<Company[]>([])
  const [selectedCompanyId, setSelectedCompanyId] = useState('')
  const [groups, setGroups] = useState<PolicyGroup[]>([])
  const [selectedGroupId, setSelectedGroupId] = useState('')
  const [employees, setEmployees] = useState<EmployeeAssignment[]>([])
  const [grid, setGrid] = useState<Grid>(buildEmptyGrid())
  const [version, setVersion] = useState(0)
  const [openCategories, setOpenCategories] = useState<Record<string, boolean>>({ flight: true })

  const [loadingCompanies, setLoadingCompanies] = useState(true)
  const [loadingGroups, setLoadingGroups] = useState(false)
  const [loadingRules, setLoadingRules] = useState(false)
  const [loadingEmployees, setLoadingEmployees] = useState(false)
  const [saving, setSaving] = useState(false)
  const [showGroupForm, setShowGroupForm] = useState(false)
  const [groupForm, setGroupForm] = useState({ name: '', description: '' })
  const [groupSubmitting, setGroupSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [dirty, setDirty] = useState(false)

  const successTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  function showSuccess(msg: string) {
    setSuccess(msg)
    if (successTimer.current) clearTimeout(successTimer.current)
    successTimer.current = setTimeout(() => setSuccess(''), 4000)
  }

  useEffect(() => {
    fetch('/api/tmc/companies')
      .then(r => r.json())
      .then(d => { if (d.ok) setCompanies(d.companies) })
      .finally(() => setLoadingCompanies(false))
  }, [])

  useEffect(() => {
    if (!selectedCompanyId) { setGroups([]); setSelectedGroupId(''); return }
    loadGroups(selectedCompanyId)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCompanyId])

  useEffect(() => {
    if (!selectedCompanyId || !selectedGroupId) { setGrid(buildEmptyGrid()); setVersion(0); setDirty(false); return }
    loadRules(selectedCompanyId, selectedGroupId)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCompanyId, selectedGroupId])

  useEffect(() => {
    if (tab !== 'employees' || !selectedCompanyId) return
    loadEmployees(selectedCompanyId)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, selectedCompanyId])

  async function loadGroups(companyId: string) {
    setLoadingGroups(true); setError('')
    try {
      const d = await fetch(`/api/tmc/policy-groups?companyId=${companyId}`).then(r => r.json())
      if (!d.ok) { setError(d.error || 'Could not load policy groups.'); return }
      setGroups(d.groups); setSelectedGroupId('')
    } finally { setLoadingGroups(false) }
  }

  async function loadRules(companyId: string, groupId: string) {
    setLoadingRules(true); setError('')
    try {
      const d = await fetch(`/api/tmc/policy-rules?companyId=${companyId}&groupId=${groupId}`).then(r => r.json())
      if (!d.ok) { setError(d.error || 'Could not load rules.'); return }
      setGrid(rowsToGrid(d.rows)); setVersion(d.version); setDirty(false)
    } finally { setLoadingRules(false) }
  }

  async function loadEmployees(companyId: string) {
    setLoadingEmployees(true); setError('')
    try {
      const d = await fetch(`/api/tmc/employee-assignments?companyId=${companyId}`).then(r => r.json())
      if (!d.ok) { setError(d.error || 'Could not load employees.'); return }
      setEmployees(d.employees)
    } finally { setLoadingEmployees(false) }
  }

  async function handleCreateGroup(e: React.FormEvent) {
    e.preventDefault(); setGroupSubmitting(true); setError('')
    try {
      const d = await fetch('/api/tmc/policy-groups', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId: selectedCompanyId, ...groupForm }),
      }).then(r => r.json())
      if (!d.ok) { setError(d.error || 'Could not create group.'); return }
      setGroupForm({ name: '', description: '' }); setShowGroupForm(false)
      await loadGroups(selectedCompanyId)
      setSelectedGroupId(d.group.id)
      showSuccess('Policy group created.')
    } finally { setGroupSubmitting(false) }
  }

  async function handleDeleteGroup(id: string, name: string) {
    if (!confirm(`Delete "${name}"? This only works if no employees are assigned.`)) return
    setError('')
    const d = await fetch(`/api/tmc/policy-groups/${id}`, { method: 'DELETE' }).then(r => r.json())
    if (!d.ok) { setError(d.error || 'Could not delete group.'); return }
    showSuccess('Policy group deleted.')
    if (selectedGroupId === id) setSelectedGroupId('')
    loadGroups(selectedCompanyId)
  }

  async function handleAssignGroup(employeeId: string, policyGroupId: string) {
    setError('')
    const d = await fetch('/api/tmc/employee-assignments', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employeeId, policyGroupId }),
    }).then(r => r.json())
    if (!d.ok) { setError(d.error || 'Could not assign group.'); return }
    setEmployees(prev => prev.map(e => e.id === employeeId ? { ...e, policyGroupId } : e))
    showSuccess('Policy group assigned.')
  }

  function handleCellChange(band: string, key: string, value: CellVal) {
    setGrid(prev => ({ ...prev, [band]: { ...prev[band], [key]: value } }))
    setDirty(true); setSuccess('')
  }

  // Whole-number fields round on entry so "why can I type 3.7 stars" can't
  // happen again — currency (₹) fields are left as-is since paise amounts
  // are legitimate.
  function handleNumericInputChange(band: string, field: FieldDef, raw: string) {
    if (raw === '') { handleCellChange(band, field.key, null); return }
    const n = Number(raw)
    if (Number.isNaN(n)) return
    handleCellChange(band, field.key, field.wholeNumber ? Math.round(n) : n)
  }

  async function handleSaveRules() {
    setSaving(true); setError(''); setSuccess('')
    try {
      const rules = gridToRules(grid)
      if (rules.length === 0) { setError('Set at least one value before saving.'); return }
      const d = await fetch('/api/tmc/policy-rules', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId: selectedCompanyId, policyGroupId: selectedGroupId, rules }),
      }).then(r => r.json())
      if (!d.ok) { setError(d.error || 'Could not save rules.'); return }
      setVersion(d.newVersion); setDirty(false)
      showSuccess(`Saved as version ${d.newVersion}.`)
    } finally { setSaving(false) }
  }

  function toggleCategory(id: string) {
    setOpenCategories(prev => ({ ...prev, [id]: !prev[id] }))
  }

  const selectedGroup = groups.find(g => g.id === selectedGroupId)

  return (
    <div style={s.root}>
      {/* ── Page header ──────────────────────────────────────────── */}
      <div style={s.pageHeader}>
        <div>
          <h1 style={s.heading}>Policy editor</h1>
          <p style={s.sub}>Configure travel policy per client, by policy group and band.</p>
        </div>
      </div>

      {/* ── Selector ─────────────────────────────────────────────── */}
      <div style={s.selectorRow}>
        <div style={s.field}>
          <label style={s.label}>Company</label>
          <select
            value={selectedCompanyId}
            onChange={e => {
              if (dirty && !confirm('You have unsaved policy changes. Switch companies and discard them?')) return
              setSelectedCompanyId(e.target.value); setTab('rules')
            }}
            style={s.select}
            disabled={loadingCompanies}
          >
            <option value="">{loadingCompanies ? 'Loading…' : 'Select a company…'}</option>
            {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
      </div>

      {/* ── Tabs ─────────────────────────────────────────────────── */}
      {selectedCompanyId && (
        <div style={s.tabRow}>
          <button onClick={() => setTab('rules')} style={{ ...s.tabBtn, ...(tab === 'rules' ? s.tabActive : {}) }}>
            Policy rules
          </button>
          <button onClick={() => setTab('employees')} style={{ ...s.tabBtn, ...(tab === 'employees' ? s.tabActive : {}) }}>
            Employee assignments
          </button>
        </div>
      )}

      {/* ── Banners ──────────────────────────────────────────────── */}
      {error && (
        <div style={s.errorBanner}>
          <span style={s.bannerIcon}>⚠</span> {error}
          <button onClick={() => setError('')} style={s.bannerClose}>✕</button>
        </div>
      )}
      {success && (
        <div style={s.successBanner}>
          <span style={s.bannerIcon}>✓</span> {success}
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════ */}
      {/* RULES TAB                                                  */}
      {/* ══════════════════════════════════════════════════════════ */}
      {selectedCompanyId && tab === 'rules' && (
        <>
          {/* ── Policy groups panel ──────────────────────────────── */}
          <div style={s.card}>
            <div style={s.cardHeader}>
              <div>
                <h2 style={s.cardTitle}>Policy groups</h2>
                <p style={s.cardSub}>
                  A policy group holds one set of band limits. Assign each employee to a group.
                </p>
              </div>
              <button onClick={() => setShowGroupForm(v => !v)} style={s.ghostBtn}>
                {showGroupForm ? 'Cancel' : '+ New group'}
              </button>
            </div>

            {showGroupForm && (
              <form onSubmit={handleCreateGroup} style={s.groupForm}>
                <input
                  type="text" required placeholder="Group name — e.g. Standard, Executive, Contractor"
                  value={groupForm.name}
                  onChange={e => setGroupForm(p => ({ ...p, name: e.target.value }))}
                  style={{ ...s.input, flex: 2 }}
                  autoFocus
                />
                <input
                  type="text" placeholder="Description (optional)"
                  value={groupForm.description}
                  onChange={e => setGroupForm(p => ({ ...p, description: e.target.value }))}
                  style={{ ...s.input, flex: 3 }}
                />
                <button type="submit" disabled={groupSubmitting} style={{ ...s.primaryBtn, opacity: groupSubmitting ? 0.7 : 1 }}>
                  {groupSubmitting ? 'Creating…' : 'Create group'}
                </button>
              </form>
            )}

            {loadingGroups ? (
              <p style={s.muted}>Loading groups…</p>
            ) : groups.length === 0 ? (
              <div style={s.emptyGroups}>
                <p style={s.emptyTitle}>No policy groups yet</p>
                <p style={s.emptyDesc}>Create a group to start configuring band limits for this company.</p>
              </div>
            ) : (
              <div style={s.groupGrid}>
                {groups.map(g => (
                  <div
                    key={g.id}
                    onClick={() => {
                      if (dirty && g.id !== selectedGroupId && !confirm('You have unsaved policy changes. Switch groups and discard them?')) return
                      setSelectedGroupId(g.id === selectedGroupId ? '' : g.id)
                    }}
                    style={{
                      ...s.groupCard,
                      borderColor: g.id === selectedGroupId ? '#000835' : '#E5E7EB',
                      background: g.id === selectedGroupId ? '#F5F7FF' : '#fff',
                      boxShadow: g.id === selectedGroupId ? '0 0 0 2px rgba(0,8,53,0.12)' : 'none',
                    }}
                  >
                    <div style={s.groupCardTop}>
                      <div style={groupIndicatorStyle(g.id === selectedGroupId)} />
                      <span style={s.groupCardName}>{g.name}</span>
                      <button
                        onClick={ev => { ev.stopPropagation(); handleDeleteGroup(g.id, g.name) }}
                        style={s.groupCardDelete}
                        title="Delete group"
                      >✕</button>
                    </div>
                    {g.description && <p style={s.groupCardDesc}>{g.description}</p>}
                    <p style={s.groupCardMeta}>
                      {g.employeeCount === 0
                        ? 'No employees assigned'
                        : `${g.employeeCount} employee${g.employeeCount === 1 ? '' : 's'}`}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* ── Rules editor ─────────────────────────────────────── */}
          {selectedGroupId && (
            <div style={s.card}>
              <div style={s.rulesTopBar}>
                <div>
                  <h2 style={s.cardTitle}>{selectedGroup?.name}</h2>
                  <p style={s.cardSub}>
                    {version === 0
                      ? 'No rules saved yet — configure below and save.'
                      : `Version ${version} · each save appends a new version, full history is preserved.`}
                  </p>
                </div>
                <div style={s.rulesActions}>
                  {dirty && <span style={s.unsavedBadge}>Unsaved changes</span>}
                  <button
                    onClick={handleSaveRules}
                    disabled={saving || loadingRules || !dirty}
                    style={{
                      ...s.primaryBtn,
                      opacity: saving || loadingRules || !dirty ? 0.5 : 1,
                      cursor: saving || loadingRules || !dirty ? 'not-allowed' : 'pointer',
                    }}
                  >
                    {saving ? 'Saving…' : 'Save rules →'}
                  </button>
                </div>
              </div>

              {loadingRules ? (
                <div style={s.loadingRules}>
                  <div style={s.spinner} />
                  <p style={s.muted}>Loading rules…</p>
                </div>
              ) : (
                <div style={s.categories}>
                  {CATEGORIES.map((cat, ci) => {
                    const open = !!openCategories[cat.id]
                    const { set, total } = countSetFields(grid, cat)
                    return (
                      <div key={cat.id} style={{ ...s.categoryBlock, marginTop: ci === 0 ? 0 : 12 }}>
                        {/* Category header */}
                        <button
                          onClick={() => toggleCategory(cat.id)}
                          style={{ ...s.categoryHeader, background: cat.color }}
                        >
                          <div style={s.categoryHeaderLeft}>
                            <span style={{ ...s.categoryDot, background: cat.textColor }} />
                            <span style={{ ...s.categoryLabel, color: cat.textColor }}>{cat.label}</span>
                            {total > 0 && (
                              <span style={{ ...s.categoryBadge, color: cat.textColor, borderColor: cat.textColor + '40', background: cat.textColor + '12' }}>
                                {set} / {total} set
                              </span>
                            )}
                          </div>
                          <span style={{ ...s.categoryChevron, color: cat.textColor, transform: open ? 'rotate(180deg)' : 'rotate(0deg)' }}>
                            ▾
                          </span>
                        </button>

                        {/* Collapsible table */}
                        {open && (
                          <div style={s.tableInner}>
                            {cat.description && <p style={s.categoryDesc}>{cat.description}</p>}
                            <div style={s.tableWrap}>
                              <table style={s.table}>
                                <thead>
                                  <tr>
                                    <th style={{ ...s.th, ...s.stickyCol, width: 160 }}>Band</th>
                                    {cat.fields.map(f => (
                                      <th key={f.key} style={{ ...s.th, minWidth: f.kind === 'tier' ? 160 : f.kind === 'boolean' ? 90 : 120 }}>
                                        <span style={s.colLabel}>{f.label}</span>
                                        {f.unit && <span style={s.colUnit}> · {f.unit}</span>}
                                      </th>
                                    ))}
                                  </tr>
                                </thead>
                                <tbody>
                                  {BAND_CODES.map((band, ri) => (
                                    <tr key={band} style={{ background: ri % 2 === 0 ? '#fff' : '#FAFAFA' }}>
                                      <td style={{ ...s.td, ...s.stickyCol }}>
                                        <div style={s.bandCell}>
                                          <span style={s.bandBadge}>{band}</span>
                                          <span style={s.bandLabel}>{BAND_LABELS[band]}</span>
                                        </div>
                                      </td>
                                      {cat.fields.map(f => {
                                        const val = grid[band]?.[f.key]
                                        if (f.kind === 'boolean') {
                                          return (
                                            <td key={f.key} style={{ ...s.td, textAlign: 'center' as const }}>
                                              <label style={s.toggleLabel}>
                                                <input
                                                  type="checkbox"
                                                  checked={Boolean(val)}
                                                  onChange={e => handleCellChange(band, f.key, e.target.checked)}
                                                  style={{ display: 'none' }}
                                                />
                                                <span style={{
                                                  ...s.toggle,
                                                  background: val ? '#000835' : '#E5E7EB',
                                                }}>
                                                  <span style={{
                                                    ...s.toggleKnob,
                                                    transform: val ? 'translateX(14px)' : 'translateX(0)',
                                                  }} />
                                                </span>
                                              </label>
                                            </td>
                                          )
                                        }
                                        if (f.kind === 'tier') {
                                          return (
                                            <td key={f.key} style={s.td}>
                                              <select
                                                value={val === null || val === undefined ? '' : String(val)}
                                                onChange={e => handleCellChange(band, f.key, e.target.value === '' ? null : Number(e.target.value))}
                                                style={s.tierSelect}
                                              >
                                                <option value="">— not set —</option>
                                                {f.options!.map(o => (
                                                  <option key={o.value} value={o.value}>{o.label}</option>
                                                ))}
                                              </select>
                                            </td>
                                          )
                                        }
                                        return (
                                          <td key={f.key} style={s.td}>
                                            <input
                                              type="number"
                                              value={val === null || val === undefined ? '' : Number(val)}
                                              onChange={e => handleNumericInputChange(band, f, e.target.value)}
                                              placeholder="—"
                                              min={0}
                                              step={f.wholeNumber ? 1 : 'any'}
                                              style={s.numInput}
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
                        )}
                      </div>
                    )
                  })}
                </div>
              )}

              {/* Sticky save bar when dirty */}
              {dirty && (
                <div style={s.stickyBar}>
                  <span style={s.stickyBarText}>You have unsaved changes.</span>
                  <button onClick={handleSaveRules} disabled={saving} style={s.stickyBarBtn}>
                    {saving ? 'Saving…' : 'Save rules →'}
                  </button>
                </div>
              )}
            </div>
          )}
        </>
      )}

      {/* ══════════════════════════════════════════════════════════ */}
      {/* EMPLOYEES TAB                                              */}
      {/* ══════════════════════════════════════════════════════════ */}
      {selectedCompanyId && tab === 'employees' && (
        <div style={s.card}>
          <div style={s.cardHeader}>
            <div>
              <h2 style={s.cardTitle}>Employee assignments</h2>
              <p style={s.cardSub}>Each employee belongs to exactly one policy group. Reassigning replaces their current group.</p>
            </div>
          </div>

          {loadingEmployees ? (
            <p style={s.muted}>Loading employees…</p>
          ) : employees.length === 0 ? (
            <div style={s.emptyGroups}>
              <p style={s.emptyTitle}>No employees found</p>
              <p style={s.emptyDesc}>Employees invited to this company will appear here.</p>
            </div>
          ) : groups.length === 0 ? (
            <div style={s.emptyGroups}>
              <p style={s.emptyTitle}>No policy groups yet</p>
              <p style={s.emptyDesc}>Switch to the Policy rules tab and create a group first.</p>
            </div>
          ) : (
            <div style={s.tableWrap}>
              <table style={s.table}>
                <thead>
                  <tr>
                    {['Employee', 'Email', 'Band', 'Status', 'Policy group'].map(h => (
                      <th key={h} style={s.th}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {employees.map((emp, i) => (
                    <tr key={emp.id} style={{ background: i % 2 === 0 ? '#fff' : '#FAFAFA' }}>
                      <td style={s.td}>
                        <div style={s.empCell}>
                          <div style={s.empAvatar}>{emp.full_name?.[0]?.toUpperCase() ?? '?'}</div>
                          <span style={s.empName}>{emp.full_name}</span>
                        </div>
                      </td>
                      <td style={{ ...s.td, color: '#6B7280', fontSize: '12px' }}>{emp.email}</td>
                      <td style={s.td}>
                        {emp.band_code
                          ? <span style={s.bandBadge}>{emp.band_code}</span>
                          : <span style={s.muted}>—</span>}
                      </td>
                      <td style={s.td}>
                        <span style={{
                          ...s.statusBadge,
                          background: emp.status === 'active' ? '#ECFDF5' : '#F3F4F6',
                          color: emp.status === 'active' ? '#065F46' : '#6B7280',
                        }}>
                          {emp.status}
                        </span>
                      </td>
                      <td style={s.td}>
                        <select
                          value={emp.policyGroupId ?? ''}
                          onChange={e => handleAssignGroup(emp.id, e.target.value)}
                          style={s.tierSelect}
                        >
                          <option value="" disabled>Unassigned</option>
                          {groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Styles ────────────────────────────────────────────────────────────────────
// NOTE: this record must stay Record<string, React.CSSProperties> only —
// no functions inside it. Anything state-dependent (like groupIndicatorStyle
// above) lives as its own helper function outside this object.

const s: Record<string, React.CSSProperties> = {
  root: { fontFamily: "'Inter', -apple-system, sans-serif", paddingBottom: 80 },

  pageHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 },
  heading: { fontSize: 22, fontWeight: 700, color: '#0A0A14', margin: '0 0 4px', letterSpacing: '-0.4px' },
  sub: { fontSize: 13, color: '#6B7280', margin: 0 },

  selectorRow: { marginBottom: 20, maxWidth: 320 },
  field: { display: 'flex', flexDirection: 'column', gap: 6 },
  label: { fontSize: 11, fontWeight: 600, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.6px' },
  select: { height: 40, padding: '0 12px', fontSize: 13, color: '#111827', background: '#fff', border: '1px solid #D1D5DB', borderRadius: 8, outline: 'none' },
  input: { height: 38, padding: '0 10px', fontSize: 13, color: '#111827', background: '#fff', border: '1px solid #D1D5DB', borderRadius: 7, outline: 'none' },

  tabRow: { display: 'flex', gap: 0, marginBottom: 20, borderBottom: '1px solid #E5E7EB' },
  tabBtn: { padding: '9px 16px', background: 'transparent', border: 'none', borderBottom: '2px solid transparent', fontSize: 13, color: '#6B7280', cursor: 'pointer', marginBottom: -1 },
  tabActive: { color: '#000835', fontWeight: 600, borderBottomColor: '#000835' },

  errorBanner: { display: 'flex', alignItems: 'center', gap: 8, background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8, padding: '10px 14px', fontSize: 12, color: '#DC2626', marginBottom: 16 },
  successBanner: { display: 'flex', alignItems: 'center', gap: 8, background: '#ECFDF5', border: '1px solid #A7F3D0', borderRadius: 8, padding: '10px 14px', fontSize: 12, color: '#065F46', marginBottom: 16 },
  bannerIcon: { fontSize: 14, flexShrink: 0 },
  bannerClose: { marginLeft: 'auto', background: 'transparent', border: 'none', color: '#DC2626', cursor: 'pointer', fontSize: 13 },

  card: { background: '#fff', border: '1px solid #E5E7EB', borderRadius: 12, padding: 20, marginBottom: 16, position: 'relative' },
  cardHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 },
  cardTitle: { fontSize: 14, fontWeight: 600, color: '#111827', margin: '0 0 3px' },
  cardSub: { fontSize: 12, color: '#9CA3AF', margin: 0 },

  groupForm: { display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' },
  ghostBtn: { height: 34, padding: '0 14px', background: '#fff', color: '#374151', fontSize: 12, fontWeight: 500, border: '1px solid #D1D5DB', borderRadius: 7, cursor: 'pointer', whiteSpace: 'nowrap' },
  primaryBtn: { height: 36, padding: '0 18px', background: '#000835', color: '#fff', fontSize: 13, fontWeight: 600, border: 'none', borderRadius: 7, cursor: 'pointer', whiteSpace: 'nowrap' },

  emptyGroups: { padding: '24px 0', textAlign: 'center' },
  emptyTitle: { fontSize: 13, fontWeight: 600, color: '#374151', margin: '0 0 4px' },
  emptyDesc: { fontSize: 12, color: '#9CA3AF', margin: 0 },

  groupGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12 },
  groupCard: { border: '1.5px solid', borderRadius: 10, padding: '14px 16px', cursor: 'pointer', transition: 'all 0.15s', position: 'relative' },
  groupCardTop: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 },
  groupCardName: { fontSize: 13, fontWeight: 600, color: '#111827', flex: 1 },
  groupCardDesc: { fontSize: 11, color: '#9CA3AF', margin: '0 0 6px', lineHeight: 1.4 },
  groupCardMeta: { fontSize: 11, color: '#9CA3AF', margin: 0 },
  groupCardDelete: { background: 'transparent', border: 'none', color: '#D1D5DB', cursor: 'pointer', fontSize: 12, padding: '0 2px', flexShrink: 0 },

  rulesTopBar: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 },
  rulesActions: { display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 },
  unsavedBadge: { fontSize: 11, fontWeight: 500, color: '#92400E', background: '#FEF3C7', border: '1px solid #FDE68A', borderRadius: 4, padding: '3px 8px' },

  categories: { display: 'flex', flexDirection: 'column' },
  categoryBlock: { border: '1px solid #E5E7EB', borderRadius: 9, overflow: 'hidden' },
  categoryHeader: { width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 16px', border: 'none', cursor: 'pointer', textAlign: 'left' },
  categoryHeaderLeft: { display: 'flex', alignItems: 'center', gap: 10 },
  categoryDot: { width: 6, height: 6, borderRadius: '50%', display: 'inline-block' },
  categoryLabel: { fontSize: 13, fontWeight: 600 },
  categoryBadge: { fontSize: 10, fontWeight: 600, border: '1px solid', borderRadius: 4, padding: '2px 7px' },
  categoryChevron: { fontSize: 13, transition: 'transform 0.2s', display: 'block' },
  categoryDesc: { fontSize: 12, color: '#6B7280', margin: '10px 16px 0', lineHeight: 1.5 },

  tableInner: { display: 'flex', flexDirection: 'column', gap: 4 },
  tableWrap: { overflowX: 'auto' },
  table: { borderCollapse: 'collapse', width: '100%' },
  th: { padding: '8px 12px', textAlign: 'left', background: '#F9FAFB', borderBottom: '1px solid #E5E7EB', whiteSpace: 'nowrap', verticalAlign: 'top' },
  colLabel: { display: 'block', fontSize: 11, fontWeight: 600, color: '#374151' },
  colUnit: { fontSize: 10, color: '#9CA3AF', fontWeight: 400 },
  stickyCol: { position: 'sticky', left: 0, zIndex: 1, background: '#F9FAFB', borderRight: '1px solid #E5E7EB' },
  td: { padding: '8px 12px', borderBottom: '1px solid #F3F4F6', verticalAlign: 'middle' },

  bandCell: { display: 'flex', alignItems: 'center', gap: 8 },
  bandBadge: { display: 'inline-block', padding: '2px 7px', background: '#EEF2FF', color: '#3730A3', fontSize: 10, fontWeight: 700, borderRadius: 4, flexShrink: 0 },
  bandLabel: { fontSize: 11, color: '#9CA3AF' },

  numInput: { width: 100, height: 30, padding: '0 8px', fontSize: 12, color: '#111827', background: '#F9FAFB', border: '1px solid transparent', borderRadius: 5, outline: 'none' },
  tierSelect: { height: 30, padding: '0 8px', fontSize: 12, color: '#111827', background: '#F9FAFB', border: '1px solid #E5E7EB', borderRadius: 5, outline: 'none', cursor: 'pointer', minWidth: 140 },

  toggleLabel: { display: 'inline-flex', alignItems: 'center', cursor: 'pointer' },
  toggle: { position: 'relative', display: 'inline-block', width: 32, height: 18, borderRadius: 9, transition: 'background 0.2s', flexShrink: 0 },
  toggleKnob: { position: 'absolute', top: 2, left: 2, width: 14, height: 14, background: '#fff', borderRadius: '50%', transition: 'transform 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.25)' },

  loadingRules: { display: 'flex', alignItems: 'center', gap: 10, padding: '24px 0' },
  spinner: { width: 16, height: 16, border: '2px solid #E5E7EB', borderTopColor: '#000835', borderRadius: '50%' },
  muted: { fontSize: 12, color: '#9CA3AF', margin: 0 },

  stickyBar: { position: 'sticky', bottom: 0, left: 0, right: 0, background: '#000835', borderRadius: '0 0 12px 12px', padding: '12px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 16 },
  stickyBarText: { fontSize: 13, color: 'rgba(255,255,255,0.7)' },
  stickyBarBtn: { height: 34, padding: '0 18px', background: '#fff', color: '#000835', fontSize: 13, fontWeight: 700, border: 'none', borderRadius: 6, cursor: 'pointer' },

  empCell: { display: 'flex', alignItems: 'center', gap: 9 },
  empAvatar: { width: 28, height: 28, borderRadius: '50%', background: '#EEF2FF', color: '#3730A3', fontSize: 11, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  empName: { fontSize: 13, fontWeight: 500, color: '#111827' },
  statusBadge: { display: 'inline-block', padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 500 },
}