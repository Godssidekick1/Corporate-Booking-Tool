'use client'

import { useEffect, useRef, useState } from 'react'

// NOTE: no TmcShell here. app/tmc/settings/layout.tsx already supplies the
// Settings sidebar and page chrome for everything under /tmc/settings —
// wrapping again nests a second sidebar inside the first.

// ── Types ─────────────────────────────────────────────────────────────────────

interface Company { id: string; name: string }

type ApproverType = 'manager' | 'finance_role' | 'specific_user' | 'admin' | 'self' | 'any_manager_at'
type ChainMode = 'sequential' | 'parallel'
type ChainQuorum = 'any' | 'all'

interface ChainTier {
  tier: number
  approver_type: ApproverType
  min_verdict: 'green' | 'amber' | 'red'
  approver_user_id?: string | null
  min_band_rank?: number | null
}

interface Template {
  id: string
  name: string
  code: string | null
  description: string | null
  category: string
  mode: ChainMode
  quorum: ChainQuorum
  tiers: ChainTier[]
  employeeCount: number
  defaultForCompanies: number
  version: number
}

interface RosterEmployee {
  id: string
  full_name: string
  email: string
  band_code: string | null
  status: string
  assignments: Record<string, string | null>
}

// ── Constants ─────────────────────────────────────────────────────────────────

const CATEGORIES: { value: string; label: string }[] = [
  { value: 'flights_hotels', label: 'Flights & hotels' },
  { value: 'misc', label: 'Everything else' },
]

const APPROVER_TYPES: { value: ApproverType; label: string }[] = [
  { value: 'manager',        label: "The traveller's own manager" },
  { value: 'any_manager_at', label: 'Any manager at rank…' },
  { value: 'finance_role',   label: 'Finance' },
  { value: 'admin',          label: 'Company admin' },
  { value: 'specific_user',  label: 'A specific person…' },
  { value: 'self',           label: 'No review needed (auto-approve)' },
]

const VERDICTS: { value: 'green' | 'amber' | 'red'; label: string }[] = [
  { value: 'green', label: 'Always' },
  { value: 'amber', label: 'Amber and worse' },
  { value: 'red',   label: 'Red only' },
]

function emptyTier(n: number): ChainTier {
  return { tier: n, approver_type: 'manager', min_verdict: 'amber' }
}

function categoryLabel(v: string): string {
  return CATEGORIES.find(c => c.value === v)?.label ?? v
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function TmcApprovalsPage() {
  const [tab, setTab] = useState<'templates' | 'assignments'>('templates')

  const [templates, setTemplates] = useState<Template[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [loadingTemplates, setLoadingTemplates] = useState(true)

  const [draftTiers, setDraftTiers] = useState<ChainTier[]>([])
  const [draftMode, setDraftMode] = useState<ChainMode>('sequential')
  const [draftQuorum, setDraftQuorum] = useState<ChainQuorum>('all')
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)

  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState({ name: '', code: '', category: 'flights_hotels' })
  const [creating, setCreating] = useState(false)

  const [companies, setCompanies] = useState<Company[]>([])
  const [companyId, setCompanyId] = useState('')
  const [category, setCategory] = useState('flights_hotels')
  const [roster, setRoster] = useState<RosterEmployee[]>([])
  const [defaults, setDefaults] = useState<Record<string, string | null>>({})
  const [selectedEmployees, setSelectedEmployees] = useState<Set<string>>(new Set())
  const [bulkTemplateId, setBulkTemplateId] = useState('')
  const [loadingRoster, setLoadingRoster] = useState(false)
  const [busy, setBusy] = useState(false)

  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const successTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  function showSuccess(msg: string) {
    setSuccess(msg)
    if (successTimer.current) clearTimeout(successTimer.current)
    successTimer.current = setTimeout(() => setSuccess(''), 4000)
  }

  const selected = templates.find(t => t.id === selectedId)

  useEffect(() => { loadTemplates() }, [])

  useEffect(() => {
    if (tab !== 'assignments' || companies.length > 0) return
    fetch('/api/tmc/companies').then(r => r.json())
      .then(d => { if (d.ok) setCompanies(d.companies) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab])

  useEffect(() => {
    if (!companyId) { setRoster([]); setDefaults({}); return }
    loadRoster(companyId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId])

  useEffect(() => {
    if (!selected) { setDraftTiers([]); setDirty(false); return }
    setDraftTiers(selected.tiers)
    setDraftMode(selected.mode)
    setDraftQuorum(selected.quorum)
    setDirty(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId])

  // Clearing the selection when the category changes avoids carrying a
  // multi-select from one category's routing into another's.
  useEffect(() => { setSelectedEmployees(new Set()); setBulkTemplateId('') }, [category, companyId])

  async function loadTemplates() {
    setLoadingTemplates(true); setError('')
    try {
      const d = await fetch('/api/tmc/approval-templates').then(r => r.json())
      if (!d.ok) { setError(d.error || 'Could not load approval templates.'); return }
      setTemplates(d.templates)
    } finally { setLoadingTemplates(false) }
  }

  async function loadRoster(id: string) {
    setLoadingRoster(true); setError('')
    try {
      const d = await fetch(`/api/tmc/approval-assignments?companyId=${id}`).then(r => r.json())
      if (!d.ok) { setError(d.error || 'Could not load the roster.'); return }
      setRoster(d.employees); setDefaults(d.defaults)
    } finally { setLoadingRoster(false) }
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault(); setCreating(true); setError('')
    try {
      const d = await fetch('/api/tmc/approval-templates', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: form.name,
          code: form.code || undefined,
          category: form.category,
          mode: 'sequential',
          tiers: [emptyTier(1)],
        }),
      }).then(r => r.json())
      if (!d.ok) { setError(d.error || 'Could not create template.'); return }
      setForm({ name: '', code: '', category: 'flights_hotels' })
      setShowForm(false)
      await loadTemplates()
      setSelectedId(d.template.id)
      showSuccess('Approval template created.')
    } finally { setCreating(false) }
  }

  async function handleDelete(id: string, name: string) {
    if (!confirm(`Delete "${name}"?`)) return
    setError('')
    const d = await fetch(`/api/tmc/approval-templates/${id}`, { method: 'DELETE' }).then(r => r.json())
    if (!d.ok) { setError(d.error || 'Could not delete template.'); return }
    if (selectedId === id) setSelectedId('')
    loadTemplates()
    showSuccess('Approval template deleted.')
  }

  // Switching mode renumbers the tiers, because the modes read them
  // differently: sequential walks distinct numbers in order, parallel raises
  // everything together and the engine collapses them onto one number anyway.
  function switchMode(next: ChainMode) {
    if (next === draftMode) return
    setDraftMode(next)
    setDraftTiers(prev => prev.map((t, i) => ({ ...t, tier: next === 'parallel' ? 1 : i + 1 })))
    setDirty(true)
  }

  function updateTier(index: number, patch: Partial<ChainTier>) {
    setDraftTiers(prev => prev.map((t, i) => (i === index ? { ...t, ...patch } : t)))
    setDirty(true)
  }

  function addTier() {
    setDraftTiers(prev => [...prev, emptyTier(draftMode === 'parallel' ? 1 : prev.length + 1)])
    setDirty(true)
  }

  function removeTier(index: number) {
    setDraftTiers(prev => prev
      .filter((_, i) => i !== index)
      .map((t, i) => ({ ...t, tier: draftMode === 'parallel' ? 1 : i + 1 })))
    setDirty(true)
  }

  async function handleSave() {
    if (!selected) return
    setSaving(true); setError('')
    try {
      const d = await fetch(`/api/tmc/approval-templates/${selected.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: draftMode, quorum: draftQuorum, tiers: draftTiers }),
      }).then(r => r.json())
      if (!d.ok) { setError(d.error || 'Could not save template.'); return }
      await loadTemplates()
      setDirty(false)
      showSuccess('Approval template saved.')
    } finally { setSaving(false) }
  }

  async function assign(templateId: string | null, employeeIds?: string[]) {
    setBusy(true); setError('')
    try {
      const d = await fetch('/api/tmc/approval-assignments', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId, category, templateId, employeeIds }),
      }).then(r => r.json())
      if (!d.ok) { setError(d.error || 'Could not save assignment.'); return false }
      await loadRoster(companyId)
      loadTemplates()
      return true
    } finally { setBusy(false) }
  }

  async function handleBulkAssign() {
    if (selectedEmployees.size === 0) return
    const ids = Array.from(selectedEmployees)
    const ok = await assign(bulkTemplateId || null, ids)
    if (ok) {
      setSelectedEmployees(new Set())
      setBulkTemplateId('')
      showSuccess(
        bulkTemplateId
          ? `Assigned ${ids.length} employee${ids.length === 1 ? '' : 's'}.`
          : `Reset ${ids.length} employee${ids.length === 1 ? '' : 's'} to the company default.`
      )
    }
  }

  function toggleEmployee(id: string) {
    setSelectedEmployees(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  const categoryTemplates = templates.filter(t => t.category === category)
  const defaultTemplateId = defaults[category] ?? ''
  const allSelected = roster.length > 0 && selectedEmployees.size === roster.length
  const unroutedCount = defaultTemplateId
    ? 0
    : roster.filter(e => !e.assignments[category]).length

  return (
    <div style={s.root}>
      <div style={s.pageHeader}>
        <h1 style={s.heading}>Approval routing</h1>
        <p style={s.sub}>
          Build reusable approval templates, then assign them per employee.
        </p>
      </div>

      <div style={s.tabRow}>
        <button onClick={() => setTab('templates')} style={{ ...s.tabBtn, ...(tab === 'templates' ? s.tabActive : {}) }}>
          Templates
        </button>
        <button onClick={() => setTab('assignments')} style={{ ...s.tabBtn, ...(tab === 'assignments' ? s.tabActive : {}) }}>
          Assignments
        </button>
      </div>

      {error && (
        <div style={s.errorBanner}>
          <span style={s.bannerIcon}>⚠</span> {error}
          <button onClick={() => setError('')} style={s.bannerClose}>✕</button>
        </div>
      )}
      {success && <div style={s.successBanner}><span style={s.bannerIcon}>✓</span> {success}</div>}

      {/* ══ TEMPLATES ══════════════════════════════════════════════ */}
      {tab === 'templates' && (
        <>
          <div style={s.card}>
            <div style={s.cardHeader}>
              <div>
                <h2 style={s.cardTitle}>Approval templates</h2>
                <p style={s.cardSub}>
                  A template is the shape of a chain — who approves, in what order, from
                  which verdict. Who it applies to is set on the Assignments tab.
                </p>
              </div>
              <button onClick={() => setShowForm(v => !v)} style={s.ghostBtn}>
                {showForm ? 'Cancel' : '+ New template'}
              </button>
            </div>

            {showForm && (
              <form onSubmit={handleCreate} style={s.form}>
                <input
                  type="text" required placeholder="Template name — e.g. Manager then finance"
                  value={form.name}
                  onChange={e => setForm(p => ({ ...p, name: e.target.value }))}
                  style={{ ...s.input, flex: 2, minWidth: 200 }}
                  autoFocus
                />
                <input
                  type="text" placeholder="Code (optional)"
                  value={form.code}
                  onChange={e => setForm(p => ({ ...p, code: e.target.value }))}
                  style={{ ...s.input, width: 140 }}
                />
                <select
                  value={form.category}
                  onChange={e => setForm(p => ({ ...p, category: e.target.value }))}
                  style={{ ...s.input, width: 180 }}
                >
                  {CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                </select>
                <button type="submit" disabled={creating} style={{ ...s.primaryBtn, opacity: creating ? 0.7 : 1 }}>
                  {creating ? 'Creating…' : 'Create'}
                </button>
              </form>
            )}

            {loadingTemplates ? (
              <p style={s.muted}>Loading templates…</p>
            ) : templates.length === 0 ? (
              <div style={s.empty}>
                <p style={s.emptyTitle}>No approval templates yet</p>
                <p style={s.emptyDesc}>Create one, then assign it to employees.</p>
              </div>
            ) : (
              <div style={s.grid}>
                {templates.map(t => (
                  <div
                    key={t.id}
                    onClick={() => {
                      if (dirty && t.id !== selectedId && !confirm('You have unsaved changes. Switch templates and discard them?')) return
                      setSelectedId(t.id === selectedId ? '' : t.id)
                    }}
                    style={{
                      ...s.templateCard,
                      borderColor: t.id === selectedId ? '#000835' : '#E5E7EB',
                      background: t.id === selectedId ? '#F5F7FF' : '#fff',
                    }}
                  >
                    <div style={s.cardTop}>
                      <span style={s.templateName}>{t.name}</span>
                      <button
                        onClick={ev => { ev.stopPropagation(); handleDelete(t.id, t.name) }}
                        style={s.deleteBtn}
                        title="Delete template"
                      >✕</button>
                    </div>
                    <div style={s.tagRow}>
                      <span style={s.catBadge}>{categoryLabel(t.category)}</span>
                      <span style={t.mode === 'parallel' ? s.parallelBadge : s.seqBadge}>
                        {t.mode === 'parallel'
                          ? `${t.tiers.length} approvers · ${t.quorum === 'any' ? 'any one' : 'all'}`
                          : `${t.tiers.length}-tier`}
                      </span>
                    </div>
                    <p style={s.cardMeta}>
                      {t.employeeCount === 0 && t.defaultForCompanies === 0
                        ? 'Not assigned to anyone'
                        : [
                            t.employeeCount > 0 ? `${t.employeeCount} employee${t.employeeCount === 1 ? '' : 's'}` : null,
                            t.defaultForCompanies > 0 ? `default at ${t.defaultForCompanies}` : null,
                          ].filter(Boolean).join(' · ')}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>

          {selected && (
            <div style={s.card}>
              <div style={s.editorTop}>
                <div>
                  <h2 style={s.cardTitle}>
                    {selected.name} <span style={s.inlineMeta}>· {categoryLabel(selected.category)}</span>
                  </h2>
                  <p style={s.cardSub}>Version {selected.version}</p>
                </div>
                <div style={s.editorActions}>
                  {dirty && <span style={s.unsavedBadge}>Unsaved changes</span>}
                  <button
                    onClick={handleSave}
                    disabled={saving || !dirty}
                    style={{ ...s.primaryBtn, opacity: saving || !dirty ? 0.5 : 1, cursor: saving || !dirty ? 'not-allowed' : 'pointer' }}
                  >
                    {saving ? 'Saving…' : 'Save →'}
                  </button>
                </div>
              </div>

              {selected.employeeCount > 1 && (
                <div style={s.warnBanner}>
                  <strong>{selected.employeeCount} employees</strong> route through this template.
                  Saving changes approval for all of them.
                </div>
              )}

              {/* ── Mode toggle ─────────────────────────────────── */}
              <div style={s.modeRow}>
                <div style={s.modeToggle}>
                  <button
                    onClick={() => switchMode('sequential')}
                    style={{ ...s.modeBtn, ...(draftMode === 'sequential' ? s.modeBtnActive : {}) }}
                  >
                    Multi-tier
                  </button>
                  <button
                    onClick={() => switchMode('parallel')}
                    style={{ ...s.modeBtn, ...(draftMode === 'parallel' ? s.modeBtnActive : {}) }}
                  >
                    Multiple approvers
                  </button>
                </div>

                <p style={s.modeHint}>
                  {draftMode === 'sequential'
                    ? 'Approvers are asked one after another. Each tier only starts once the previous one approves.'
                    : 'Every approver is asked at the same time.'}
                </p>

                {draftMode === 'parallel' && (
                  <div style={s.quorumRow}>
                    <label style={s.quorumLabel}>Clears when</label>
                    <select
                      value={draftQuorum}
                      onChange={e => { setDraftQuorum(e.target.value as ChainQuorum); setDirty(true) }}
                      style={{ ...s.input, width: 210 }}
                    >
                      <option value="all">Everyone has approved</option>
                      <option value="any">Any one person approves</option>
                    </select>
                    <span style={s.quorumHint}>A rejection from anyone stops the booking, either way.</span>
                  </div>
                )}
              </div>

              <div style={s.tierList}>
                {draftTiers.map((tier, i) => (
                  <div key={i} style={s.tierRow}>
                    <span style={s.tierNumber}>
                      {draftMode === 'sequential' ? `Tier ${i + 1}` : `#${i + 1}`}
                    </span>

                    <select
                      value={tier.approver_type}
                      onChange={e => updateTier(i, {
                        approver_type: e.target.value as ApproverType,
                        approver_user_id: null,
                        min_band_rank: null,
                      })}
                      style={{ ...s.input, flex: 1, minWidth: 200 }}
                    >
                      {APPROVER_TYPES.map(a => <option key={a.value} value={a.value}>{a.label}</option>)}
                    </select>

                    {tier.approver_type === 'any_manager_at' && (
                      <input
                        type="number" min={0} placeholder="Min rank"
                        value={tier.min_band_rank ?? ''}
                        onChange={e => updateTier(i, { min_band_rank: e.target.value === '' ? null : Number(e.target.value) })}
                        style={{ ...s.input, width: 110 }}
                      />
                    )}

                    <select
                      value={tier.min_verdict}
                      onChange={e => updateTier(i, { min_verdict: e.target.value as ChainTier['min_verdict'] })}
                      style={{ ...s.input, width: 160 }}
                    >
                      {VERDICTS.map(v => <option key={v.value} value={v.value}>{v.label}</option>)}
                    </select>

                    <button
                      onClick={() => removeTier(i)}
                      disabled={draftTiers.length === 1}
                      style={{ ...s.deleteBtn, opacity: draftTiers.length === 1 ? 0.3 : 1 }}
                    >✕</button>
                  </div>
                ))}
              </div>

              <button onClick={addTier} style={s.ghostBtn}>
                {draftMode === 'sequential' ? '+ Add tier' : '+ Add approver'}
              </button>

              {draftMode === 'parallel' && draftTiers.length < 2 && (
                <p style={s.inlineWarn}>
                  Multiple approvers needs at least two — add another, or switch back to multi-tier.
                </p>
              )}

              {draftTiers.some(t => t.approver_type === 'specific_user') && (
                <p style={s.inlineWarn}>
                  &quot;A specific person&quot; names one individual, so a template using it only makes
                  sense for one company. Prefer &quot;the traveller&apos;s own manager&quot; on shared templates.
                </p>
              )}
            </div>
          )}
        </>
      )}

      {/* ══ ASSIGNMENTS ════════════════════════════════════════════ */}
      {tab === 'assignments' && (
        <div style={s.card}>
          <div style={s.cardHeader}>
            <div>
              <h2 style={s.cardTitle}>Who routes where</h2>
              <p style={s.cardSub}>
                Assign per employee — people on the same band often report to different
                managers. Anyone left unassigned follows the company default.
              </p>
            </div>
          </div>

          <div style={s.filterRow}>
            <div style={s.field}>
              <label style={s.label}>Company</label>
              <select value={companyId} onChange={e => setCompanyId(e.target.value)} style={{ ...s.input, width: 240 }}>
                <option value="">Select a company…</option>
                {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div style={s.field}>
              <label style={s.label}>Category</label>
              <select value={category} onChange={e => setCategory(e.target.value)} style={{ ...s.input, width: 200 }}>
                {CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
              </select>
            </div>
          </div>

          {companyId && (
            <>
              <div style={s.defaultRow}>
                <label style={s.label}>Company default</label>
                <select
                  value={defaultTemplateId}
                  onChange={e => assign(e.target.value || null).then(ok => {
                    if (ok) showSuccess(e.target.value ? 'Company default set.' : 'Company default cleared.')
                  })}
                  disabled={busy}
                  style={{ ...s.input, flex: 1, minWidth: 220 }}
                >
                  <option value="">No default — unassigned employees skip approval</option>
                  {categoryTemplates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </div>

              {unroutedCount > 0 && (
                <div style={s.warnBanner}>
                  <strong>{unroutedCount} employee{unroutedCount === 1 ? '' : 's'}</strong> have no
                  approval route for {categoryLabel(category).toLowerCase()}, and there is no company
                  default. Their bookings proceed without any approval.
                </div>
              )}

              {selectedEmployees.size > 0 && (
                <div style={s.bulkBar}>
                  <span style={s.bulkCount}>{selectedEmployees.size} selected</span>
                  <select
                    value={bulkTemplateId}
                    onChange={e => setBulkTemplateId(e.target.value)}
                    style={{ ...s.input, flex: 1, minWidth: 200 }}
                  >
                    <option value="">Use the company default</option>
                    {categoryTemplates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                  <button onClick={handleBulkAssign} disabled={busy} style={s.primaryBtn}>
                    {busy ? 'Applying…' : 'Apply to selected'}
                  </button>
                  <button onClick={() => setSelectedEmployees(new Set())} style={s.ghostBtn}>Clear</button>
                </div>
              )}

              {loadingRoster ? (
                <p style={s.muted}>Loading roster…</p>
              ) : roster.length === 0 ? (
                <div style={s.empty}>
                  <p style={s.emptyTitle}>No employees</p>
                  <p style={s.emptyDesc}>Employees added to this company will appear here.</p>
                </div>
              ) : (
                <div style={s.tableWrap}>
                  <table style={s.table}>
                    <thead>
                      <tr>
                        <th style={{ ...s.th, width: 34 }}>
                          <input
                            type="checkbox"
                            checked={allSelected}
                            onChange={() => setSelectedEmployees(allSelected ? new Set() : new Set(roster.map(e => e.id)))}
                          />
                        </th>
                        {['Employee', 'Band', 'Approval route'].map(h => <th key={h} style={s.th}>{h}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {roster.map((emp, i) => {
                        const assigned = emp.assignments[category]
                        return (
                          <tr key={emp.id} style={{ background: i % 2 === 0 ? '#fff' : '#FAFAFA' }}>
                            <td style={s.td}>
                              <input
                                type="checkbox"
                                checked={selectedEmployees.has(emp.id)}
                                onChange={() => toggleEmployee(emp.id)}
                              />
                            </td>
                            <td style={s.td}>
                              <div style={s.empName}>{emp.full_name}</div>
                              <div style={s.empEmail}>{emp.email}</div>
                            </td>
                            <td style={s.td}>
                              {emp.band_code
                                ? <span style={s.bandBadge}>{emp.band_code}</span>
                                : <span style={s.muted}>—</span>}
                            </td>
                            <td style={s.td}>
                              <select
                                value={assigned ?? ''}
                                onChange={e => assign(e.target.value || null, [emp.id]).then(ok => {
                                  if (ok) showSuccess(`${emp.full_name} updated.`)
                                })}
                                disabled={busy}
                                style={{ ...s.input, height: 32, minWidth: 210 }}
                              >
                                <option value="">
                                  {defaultTemplateId
                                    ? `Company default (${categoryTemplates.find(t => t.id === defaultTemplateId)?.name ?? '—'})`
                                    : 'No approval required'}
                                </option>
                                {categoryTemplates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                              </select>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  root: { fontFamily: "'Inter', -apple-system, sans-serif", paddingBottom: 60 },
  pageHeader: { marginBottom: 24 },
  heading: { fontSize: 22, fontWeight: 700, color: '#0A0A14', margin: '0 0 4px', letterSpacing: '-0.4px' },
  sub: { fontSize: 13, color: '#6B7280', margin: 0 },

  tabRow: { display: 'flex', marginBottom: 20, borderBottom: '1px solid #E5E7EB' },
  tabBtn: { padding: '9px 16px', background: 'transparent', border: 'none', borderBottom: '2px solid transparent', fontSize: 13, color: '#6B7280', cursor: 'pointer', marginBottom: -1 },
  tabActive: { color: '#000835', fontWeight: 600, borderBottomColor: '#000835' },

  errorBanner: { display: 'flex', alignItems: 'center', gap: 8, background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8, padding: '10px 14px', fontSize: 12, color: '#DC2626', marginBottom: 16 },
  successBanner: { display: 'flex', alignItems: 'center', gap: 8, background: '#ECFDF5', border: '1px solid #A7F3D0', borderRadius: 8, padding: '10px 14px', fontSize: 12, color: '#065F46', marginBottom: 16 },
  warnBanner: { background: '#FEF3C7', border: '1px solid #FDE68A', borderRadius: 8, padding: '12px 14px', fontSize: 12, color: '#92400E', marginBottom: 16, lineHeight: 1.6 },
  bannerIcon: { fontSize: 14, flexShrink: 0 },
  bannerClose: { marginLeft: 'auto', background: 'transparent', border: 'none', color: '#DC2626', cursor: 'pointer', fontSize: 13 },
  inlineWarn: { fontSize: 11, color: '#92400E', margin: '10px 0 0', lineHeight: 1.5 },

  card: { background: '#fff', border: '1px solid #E5E7EB', borderRadius: 12, padding: 20, marginBottom: 16 },
  cardHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16, gap: 16 },
  cardTitle: { fontSize: 14, fontWeight: 600, color: '#111827', margin: '0 0 3px' },
  cardSub: { fontSize: 12, color: '#9CA3AF', margin: 0, lineHeight: 1.5 },
  cardMeta: { fontSize: 11, color: '#9CA3AF', margin: 0 },
  inlineMeta: { fontSize: 12, fontWeight: 400, color: '#9CA3AF' },

  form: { display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' },
  filterRow: { display: 'flex', gap: 16, marginBottom: 18, flexWrap: 'wrap' },
  field: { display: 'flex', flexDirection: 'column', gap: 6 },
  label: { fontSize: 11, fontWeight: 600, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.6px' },
  input: { height: 38, padding: '0 10px', fontSize: 13, color: '#111827', background: '#fff', border: '1px solid #D1D5DB', borderRadius: 7, outline: 'none' },
  ghostBtn: { height: 34, padding: '0 14px', background: '#fff', color: '#374151', fontSize: 12, fontWeight: 500, border: '1px solid #D1D5DB', borderRadius: 7, cursor: 'pointer', whiteSpace: 'nowrap' },
  primaryBtn: { height: 36, padding: '0 18px', background: '#000835', color: '#fff', fontSize: 13, fontWeight: 600, border: 'none', borderRadius: 7, cursor: 'pointer', whiteSpace: 'nowrap' },
  deleteBtn: { background: 'transparent', border: 'none', color: '#9CA3AF', cursor: 'pointer', fontSize: 12, padding: '0 2px', flexShrink: 0 },

  defaultRow: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 16, padding: '12px 14px', background: '#F9FAFB', border: '1px solid #E5E7EB', borderRadius: 8 },
  bulkBar: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 16, padding: '12px 14px', background: '#F5F7FF', border: '1px solid #C7D2FE', borderRadius: 8 },
  bulkCount: { fontSize: 12, fontWeight: 600, color: '#000835', whiteSpace: 'nowrap' },

  empty: { padding: '24px 0', textAlign: 'center' },
  emptyTitle: { fontSize: 13, fontWeight: 600, color: '#374151', margin: '0 0 4px' },
  emptyDesc: { fontSize: 12, color: '#9CA3AF', margin: 0 },
  muted: { fontSize: 12, color: '#9CA3AF', margin: 0 },

  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 12 },
  templateCard: { border: '1.5px solid', borderRadius: 10, padding: '14px 16px', cursor: 'pointer', transition: 'all 0.15s' },
  cardTop: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 },
  templateName: { fontSize: 13, fontWeight: 600, color: '#111827', flex: 1 },
  tagRow: { display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 },
  catBadge: { display: 'inline-block', padding: '2px 7px', background: '#F0FDF4', color: '#14532D', fontSize: 10, fontWeight: 600, borderRadius: 4 },
  seqBadge: { display: 'inline-block', padding: '2px 7px', background: '#F3F4F6', color: '#4B5563', fontSize: 10, fontWeight: 600, borderRadius: 4 },
  parallelBadge: { display: 'inline-block', padding: '2px 7px', background: '#FFF7ED', color: '#7C2D12', fontSize: 10, fontWeight: 600, borderRadius: 4 },
  bandBadge: { display: 'inline-block', padding: '2px 7px', background: '#EEF2FF', color: '#3730A3', fontSize: 10, fontWeight: 700, borderRadius: 4 },

  editorTop: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16, gap: 16 },
  editorActions: { display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 },
  unsavedBadge: { fontSize: 11, fontWeight: 500, color: '#92400E', background: '#FEF3C7', border: '1px solid #FDE68A', borderRadius: 4, padding: '3px 8px' },

  modeRow: { padding: '14px 16px', background: '#F9FAFB', border: '1px solid #E5E7EB', borderRadius: 8, marginBottom: 16 },
  modeToggle: { display: 'inline-flex', border: '1px solid #D1D5DB', borderRadius: 8, overflow: 'hidden', background: '#fff' },
  modeBtn: { padding: '8px 18px', background: 'transparent', border: 'none', fontSize: 13, color: '#6B7280', cursor: 'pointer' },
  modeBtnActive: { background: '#000835', color: '#fff', fontWeight: 600 },
  modeHint: { fontSize: 11, color: '#6B7280', margin: '10px 0 0', lineHeight: 1.5 },
  quorumRow: { display: 'flex', gap: 10, alignItems: 'center', marginTop: 12, flexWrap: 'wrap' },
  quorumLabel: { fontSize: 11, fontWeight: 600, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.6px' },
  quorumHint: { fontSize: 11, color: '#9CA3AF' },

  tierList: { display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 12 },
  tierRow: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' },
  tierNumber: { fontSize: 11, fontWeight: 700, color: '#3730A3', background: '#EEF2FF', borderRadius: 4, padding: '4px 8px', minWidth: 54, textAlign: 'center' },

  tableWrap: { overflowX: 'auto' },
  table: { borderCollapse: 'collapse', width: '100%' },
  th: { padding: '8px 12px', textAlign: 'left', background: '#F9FAFB', borderBottom: '1px solid #E5E7EB', whiteSpace: 'nowrap', fontSize: 11, fontWeight: 600, color: '#374151' },
  td: { padding: '8px 12px', borderBottom: '1px solid #F3F4F6', fontSize: 12, verticalAlign: 'middle' },
  empName: { fontSize: 13, fontWeight: 500, color: '#111827' },
  empEmail: { fontSize: 11, color: '#9CA3AF' },
}
