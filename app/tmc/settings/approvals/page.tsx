'use client'

import { useEffect, useRef, useState } from 'react'
import TmcShell from '@/app/components/TmcShell'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Company { id: string; name: string }
interface Band { code: string; label: string; rank: number }

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
  bandRanks: number[]
  companyCount: number
  version: number
}

interface CompanyLink {
  templateId: string
  assignedAt: string
  template: {
    id: string
    name: string
    code: string | null
    category: string
    mode: ChainMode
    quorum: ChainQuorum
    bandRanks: number[]
  } | null
}

interface CompanyEmployee { id: string; full_name: string; email: string }

// ── Constants ─────────────────────────────────────────────────────────────────

const CATEGORIES: { value: string; label: string; hint: string }[] = [
  { value: 'flights_hotels', label: 'Flights & hotels', hint: 'Flight and hotel bookings' },
  { value: 'misc', label: 'Everything else', hint: 'Car rental, expenses, anything else' },
]

const APPROVER_TYPES: { value: ApproverType; label: string; needs?: 'user' | 'rank' }[] = [
  { value: 'manager',        label: "The traveller's manager" },
  { value: 'any_manager_at', label: 'Any manager at rank…', needs: 'rank' },
  { value: 'finance_role',   label: 'Finance' },
  { value: 'admin',          label: 'Company admin' },
  { value: 'specific_user',  label: 'A specific person…', needs: 'user' },
  { value: 'self',           label: 'No review needed (auto-approve)' },
]

const VERDICTS: { value: 'green' | 'amber' | 'red'; label: string }[] = [
  { value: 'green', label: 'Always' },
  { value: 'amber', label: 'Amber and worse' },
  { value: 'red',   label: 'Red only' },
]

// ── Helpers ───────────────────────────────────────────────────────────────────

// Accepts "1-3, 7" / "1 4 7" / "2". Unparseable chunks are dropped rather than
// rejected, so a half-typed value doesn't throw mid-edit.
function parseRankSpec(spec: string): number[] {
  const ranks = new Set<number>()
  for (const chunk of spec.split(/[,\s]+/)) {
    if (!chunk) continue
    const range = chunk.match(/^(\d+)\s*[-–]\s*(\d+)$/)
    if (range) {
      const from = Number(range[1]); const to = Number(range[2])
      if (from <= to && to - from <= 50) for (let r = from; r <= to; r++) ranks.add(r)
      continue
    }
    const single = Number(chunk)
    if (Number.isInteger(single) && single >= 0) ranks.add(single)
  }
  return Array.from(ranks).sort((a, b) => a - b)
}

function ranksLabel(bandRanks: number[]): string {
  if (bandRanks.length === 0) return 'No ranks yet'
  const parts: string[] = []
  let runStart = bandRanks[0]
  let previous = bandRanks[0]
  for (let i = 1; i <= bandRanks.length; i++) {
    const current = bandRanks[i]
    if (current === previous + 1) { previous = current; continue }
    if (runStart === previous) parts.push(String(runStart))
    else if (previous === runStart + 1) parts.push(`${runStart}, ${previous}`)
    else parts.push(`${runStart}–${previous}`)
    runStart = current; previous = current
  }
  return `${bandRanks.length === 1 ? 'Rank' : 'Ranks'} ${parts.join(', ')}`
}

function emptyTier(nextNumber: number): ChainTier {
  return { tier: nextNumber, approver_type: 'manager', min_verdict: 'amber' }
}

function categoryLabel(value: string): string {
  return CATEGORIES.find(c => c.value === value)?.label ?? value
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function TmcApprovalsPage() {
  const [tab, setTab] = useState<'templates' | 'companies'>('templates')

  const [templates, setTemplates] = useState<Template[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [loadingTemplates, setLoadingTemplates] = useState(true)

  // Draft state for the selected template's editor.
  const [draftTiers, setDraftTiers] = useState<ChainTier[]>([])
  const [draftMode, setDraftMode] = useState<ChainMode>('sequential')
  const [draftQuorum, setDraftQuorum] = useState<ChainQuorum>('all')
  const [draftRanks, setDraftRanks] = useState('')
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)

  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState({ name: '', code: '', category: 'flights_hotels', rankSpec: '' })
  const [creating, setCreating] = useState(false)

  const [companies, setCompanies] = useState<Company[]>([])
  const [selectedCompanyId, setSelectedCompanyId] = useState('')
  const [links, setLinks] = useState<CompanyLink[]>([])
  const [companyBands, setCompanyBands] = useState<Band[]>([])
  const [linkTemplateId, setLinkTemplateId] = useState('')
  const [loadingLinks, setLoadingLinks] = useState(false)
  const [linking, setLinking] = useState(false)

  // Only needed for 'specific_user' tiers, and only meaningful per company.
  const [employees, setEmployees] = useState<CompanyEmployee[]>([])

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
    if (tab !== 'companies' || companies.length > 0) return
    fetch('/api/tmc/companies').then(r => r.json())
      .then(d => { if (d.ok) setCompanies(d.companies) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab])

  useEffect(() => {
    if (!selectedCompanyId) { setLinks([]); setCompanyBands([]); setEmployees([]); return }
    loadLinks(selectedCompanyId)
    fetch(`/api/tmc/employees?companyId=${selectedCompanyId}`).then(r => r.json())
      .then(d => { if (d.ok) setEmployees(d.employees) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCompanyId])

  // Reset the editor whenever a different template is selected.
  useEffect(() => {
    if (!selected) { setDraftTiers([]); setDraftRanks(''); setDirty(false); return }
    setDraftTiers(selected.tiers)
    setDraftMode(selected.mode)
    setDraftQuorum(selected.quorum)
    setDraftRanks(selected.bandRanks.join(', '))
    setDirty(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId])

  async function loadTemplates() {
    setLoadingTemplates(true); setError('')
    try {
      const d = await fetch('/api/tmc/approval-templates').then(r => r.json())
      if (!d.ok) { setError(d.error || 'Could not load approval templates.'); return }
      setTemplates(d.templates)
    } finally { setLoadingTemplates(false) }
  }

  async function loadLinks(companyId: string) {
    setLoadingLinks(true); setError('')
    try {
      const d = await fetch(`/api/tmc/company-approval-templates?companyId=${companyId}`).then(r => r.json())
      if (!d.ok) { setError(d.error || 'Could not load linked templates.'); return }
      setLinks(d.links); setCompanyBands(d.bands)
    } finally { setLoadingLinks(false) }
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
          bandRanks: parseRankSpec(form.rankSpec),
        }),
      }).then(r => r.json())
      if (!d.ok) { setError(d.error || 'Could not create template.'); return }
      setForm({ name: '', code: '', category: 'flights_hotels', rankSpec: '' })
      setShowForm(false)
      await loadTemplates()
      setSelectedId(d.template.id)
      showSuccess('Approval template created.')
    } finally { setCreating(false) }
  }

  async function handleDelete(id: string, name: string) {
    if (!confirm(`Delete "${name}"? This only works if no companies are using it.`)) return
    setError('')
    const d = await fetch(`/api/tmc/approval-templates/${id}`, { method: 'DELETE' }).then(r => r.json())
    if (!d.ok) { setError(d.error || 'Could not delete template.'); return }
    if (selectedId === id) setSelectedId('')
    loadTemplates()
    showSuccess('Approval template deleted.')
  }

  // Switching mode rewrites the tier numbers, because the two modes read them
  // differently: sequential walks distinct numbers in order, parallel raises
  // everything at once and the engine collapses them onto one number anyway.
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
    setDraftTiers(prev => [
      ...prev,
      emptyTier(draftMode === 'parallel' ? 1 : prev.length + 1),
    ])
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
        body: JSON.stringify({
          mode: draftMode,
          quorum: draftQuorum,
          tiers: draftTiers,
          bandRanks: parseRankSpec(draftRanks),
        }),
      }).then(r => r.json())
      if (!d.ok) { setError(d.error || 'Could not save template.'); return }
      await loadTemplates()
      setDirty(false)
      showSuccess('Approval template saved.')
    } finally { setSaving(false) }
  }

  async function handleLink() {
    if (!selectedCompanyId || !linkTemplateId) return
    setLinking(true); setError('')
    try {
      const d = await fetch('/api/tmc/company-approval-templates', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId: selectedCompanyId, templateId: linkTemplateId }),
      }).then(r => r.json())
      if (!d.ok) { setError(d.error || 'Could not link template.'); return }
      setLinkTemplateId('')
      await loadLinks(selectedCompanyId)
      loadTemplates()
      showSuccess('Approval template linked.')
    } finally { setLinking(false) }
  }

  async function handleUnlink(templateId: string, name: string) {
    if (!confirm(`Unlink "${name}"? Employees at its ranks will have no approval route for that category.`)) return
    setError('')
    const d = await fetch(
      `/api/tmc/company-approval-templates?companyId=${selectedCompanyId}&templateId=${templateId}`,
      { method: 'DELETE' }
    ).then(r => r.json())
    if (!d.ok) { setError(d.error || 'Could not unlink template.'); return }
    await loadLinks(selectedCompanyId)
    loadTemplates()
    showSuccess('Approval template unlinked.')
  }

  const linkedIds = new Set(links.map(l => l.templateId))
  const linkable = templates.filter(t => !linkedIds.has(t.id))

  // Coverage gaps, per category — the whole point of showing bands here. An
  // uncovered band means those employees book with no approval at all, which
  // is worth stating plainly rather than leaving to be inferred.
  const gaps = CATEGORIES.map(cat => {
    const covered = new Set(
      links
        .filter(l => l.template?.category === cat.value)
        .flatMap(l => l.template?.bandRanks ?? [])
    )
    return { category: cat, uncovered: companyBands.filter(b => !covered.has(b.rank)) }
  }).filter(g => g.uncovered.length > 0)

  return (
    <TmcShell activeLabel="Settings">
      <div style={s.root}>
        <div style={s.pageHeader}>
          <div>
            <h1 style={s.heading}>Approval routing</h1>
            <p style={s.sub}>
              Build reusable approval templates by band rank, then link them to client companies.
            </p>
          </div>
        </div>

        <div style={s.tabRow}>
          <button onClick={() => setTab('templates')} style={{ ...s.tabBtn, ...(tab === 'templates' ? s.tabActive : {}) }}>
            Templates
          </button>
          <button onClick={() => setTab('companies')} style={{ ...s.tabBtn, ...(tab === 'companies' ? s.tabActive : {}) }}>
            Company assignments
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
                    One template routes one category for a set of band ranks, and can be reused
                    across any number of clients.
                  </p>
                </div>
                <button onClick={() => setShowForm(v => !v)} style={s.ghostBtn}>
                  {showForm ? 'Cancel' : '+ New template'}
                </button>
              </div>

              {showForm && (
                <form onSubmit={handleCreate} style={s.form}>
                  <input
                    type="text" required placeholder="Template name — e.g. Standard approval"
                    value={form.name}
                    onChange={e => setForm(p => ({ ...p, name: e.target.value }))}
                    style={{ ...s.input, flex: 2, minWidth: 180 }}
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
                  <input
                    type="text" placeholder="Ranks — e.g. 1-3 or 1, 4, 7"
                    value={form.rankSpec}
                    onChange={e => setForm(p => ({ ...p, rankSpec: e.target.value }))}
                    style={{ ...s.input, flex: 1, minWidth: 170 }}
                  />
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
                  <p style={s.emptyDesc}>Create one to start routing approvals by band rank.</p>
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
                        <span style={s.rankBadge}>{ranksLabel(t.bandRanks)}</span>
                        <span style={t.mode === 'parallel' ? s.parallelBadge : s.seqBadge}>
                          {t.mode === 'parallel'
                            ? `${t.tiers.length} approvers · ${t.quorum === 'any' ? 'any one' : 'all'}`
                            : `${t.tiers.length}-tier`}
                        </span>
                      </div>
                      <p style={s.cardMeta}>
                        {t.companyCount === 0
                          ? 'Not used by any company'
                          : `Used by ${t.companyCount} compan${t.companyCount === 1 ? 'y' : 'ies'}`}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* ── Editor ─────────────────────────────────────────── */}
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

                {selected.companyCount > 1 && (
                  <div style={s.warnBanner}>
                    This template is shared by <strong>{selected.companyCount} companies</strong>.
                    Saving changes approval routing for all of them.
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
                        style={{ ...s.input, width: 200 }}
                      >
                        <option value="all">Everyone has approved</option>
                        <option value="any">Any one person approves</option>
                      </select>
                      <span style={s.quorumHint}>
                        A rejection from anyone stops the booking, in either case.
                      </span>
                    </div>
                  )}
                </div>

                {/* ── Coverage ────────────────────────────────────── */}
                <div style={s.coverageRow}>
                  <label style={s.coverageLabel}>Covers ranks</label>
                  <input
                    type="text"
                    value={draftRanks}
                    onChange={e => { setDraftRanks(e.target.value); setDirty(true) }}
                    placeholder="e.g. 1-3 or 1, 4, 7"
                    style={{ ...s.input, flex: 1, minWidth: 160 }}
                  />
                  <span style={s.coverageHint}>
                    {draftRanks.trim() ? ranksLabel(parseRankSpec(draftRanks)) : 'Covers nobody until set'}
                  </span>
                </div>

                {/* ── Approvers ───────────────────────────────────── */}
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
                        style={{ ...s.input, flex: 1, minWidth: 190 }}
                      >
                        {APPROVER_TYPES.map(a => <option key={a.value} value={a.value}>{a.label}</option>)}
                      </select>

                      {tier.approver_type === 'specific_user' && (
                        <select
                          value={tier.approver_user_id ?? ''}
                          onChange={e => updateTier(i, { approver_user_id: e.target.value || null })}
                          style={{ ...s.input, flex: 1, minWidth: 170 }}
                        >
                          <option value="">
                            {selectedCompanyId ? 'Pick a person…' : 'Select a company first →'}
                          </option>
                          {employees.map(emp => (
                            <option key={emp.id} value={emp.id}>{emp.full_name}</option>
                          ))}
                        </select>
                      )}

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
                        title={draftTiers.length === 1 ? 'A template needs at least one approver' : 'Remove'}
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

                {tab === 'templates' && draftTiers.some(t => t.approver_type === 'specific_user') && !selectedCompanyId && (
                  <p style={s.inlineWarn}>
                    A specific person is company-scoped. Pick a company on the Company assignments
                    tab to choose one.
                  </p>
                )}
              </div>
            )}
          </>
        )}

        {/* ══ COMPANIES ══════════════════════════════════════════════ */}
        {tab === 'companies' && (
          <div style={s.card}>
            <div style={s.cardHeader}>
              <div>
                <h2 style={s.cardTitle}>Company assignments</h2>
                <p style={s.cardSub}>
                  Link templates so every band has an approval route in each category.
                  Within a category, two templates may not cover the same rank.
                </p>
              </div>
            </div>

            <div style={{ ...s.field, maxWidth: 320, marginBottom: 20 }}>
              <label style={s.label}>Company</label>
              <select
                value={selectedCompanyId}
                onChange={e => setSelectedCompanyId(e.target.value)}
                style={s.input}
              >
                <option value="">Select a company…</option>
                {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>

            {selectedCompanyId && (
              <>
                {gaps.length > 0 && (
                  <div style={s.warnBanner}>
                    <strong>Some bands have no approval route.</strong>
                    <ul style={s.gapList}>
                      {gaps.map(g => (
                        <li key={g.category.value}>
                          <strong>{g.category.label}</strong> — {g.uncovered.map(b => `${b.code} (${b.label})`).join(', ')}
                        </li>
                      ))}
                    </ul>
                    Bookings by these employees proceed without any approval.
                  </div>
                )}

                <div style={s.linkRow}>
                  <select
                    value={linkTemplateId}
                    onChange={e => setLinkTemplateId(e.target.value)}
                    style={{ ...s.input, flex: 1 }}
                  >
                    <option value="">Select a template to link…</option>
                    {linkable.map(t => (
                      <option key={t.id} value={t.id}>
                        {t.name} · {categoryLabel(t.category)} · {ranksLabel(t.bandRanks)}
                      </option>
                    ))}
                  </select>
                  <button
                    onClick={handleLink}
                    disabled={!linkTemplateId || linking}
                    style={{ ...s.primaryBtn, opacity: !linkTemplateId || linking ? 0.5 : 1 }}
                  >
                    {linking ? 'Linking…' : 'Link template'}
                  </button>
                </div>

                {loadingLinks ? (
                  <p style={s.muted}>Loading…</p>
                ) : links.length === 0 ? (
                  <div style={s.empty}>
                    <p style={s.emptyTitle}>No approval templates linked</p>
                    <p style={s.emptyDesc}>
                      Every booking from this company proceeds without approval until one is linked.
                    </p>
                  </div>
                ) : (
                  <div style={s.tableWrap}>
                    <table style={s.table}>
                      <thead>
                        <tr>
                          {['Template', 'Category', 'Ranks', 'Routing', ''].map(h => (
                            <th key={h} style={s.th}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {links.map((l, i) => (
                          <tr key={l.templateId} style={{ background: i % 2 === 0 ? '#fff' : '#FAFAFA' }}>
                            <td style={{ ...s.td, fontWeight: 500, color: '#111827' }}>
                              {l.template?.name ?? '—'}
                            </td>
                            <td style={s.td}>
                              {l.template && <span style={s.catBadge}>{categoryLabel(l.template.category)}</span>}
                            </td>
                            <td style={s.td}>
                              {l.template && <span style={s.rankBadge}>{ranksLabel(l.template.bandRanks)}</span>}
                            </td>
                            <td style={s.td}>
                              {l.template && (
                                <span style={l.template.mode === 'parallel' ? s.parallelBadge : s.seqBadge}>
                                  {l.template.mode === 'parallel'
                                    ? `Parallel · ${l.template.quorum === 'any' ? 'any one' : 'all'}`
                                    : 'Multi-tier'}
                                </span>
                              )}
                            </td>
                            <td style={{ ...s.td, textAlign: 'right' as const }}>
                              <button
                                onClick={() => handleUnlink(l.templateId, l.template?.name ?? 'this template')}
                                style={s.unlinkBtn}
                              >
                                Unlink
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </TmcShell>
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
  gapList: { margin: '6px 0', paddingLeft: 18 },
  bannerIcon: { fontSize: 14, flexShrink: 0 },
  bannerClose: { marginLeft: 'auto', background: 'transparent', border: 'none', color: '#DC2626', cursor: 'pointer', fontSize: 13 },
  inlineWarn: { fontSize: 11, color: '#92400E', margin: '10px 0 0' },

  card: { background: '#fff', border: '1px solid #E5E7EB', borderRadius: 12, padding: 20, marginBottom: 16 },
  cardHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16, gap: 16 },
  cardTitle: { fontSize: 14, fontWeight: 600, color: '#111827', margin: '0 0 3px' },
  cardSub: { fontSize: 12, color: '#9CA3AF', margin: 0, lineHeight: 1.5 },
  cardMeta: { fontSize: 11, color: '#9CA3AF', margin: 0 },
  inlineMeta: { fontSize: 12, fontWeight: 400, color: '#9CA3AF' },

  form: { display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' },
  field: { display: 'flex', flexDirection: 'column', gap: 6 },
  label: { fontSize: 11, fontWeight: 600, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.6px' },
  input: { height: 38, padding: '0 10px', fontSize: 13, color: '#111827', background: '#fff', border: '1px solid #D1D5DB', borderRadius: 7, outline: 'none' },
  ghostBtn: { height: 34, padding: '0 14px', background: '#fff', color: '#374151', fontSize: 12, fontWeight: 500, border: '1px solid #D1D5DB', borderRadius: 7, cursor: 'pointer', whiteSpace: 'nowrap' },
  primaryBtn: { height: 36, padding: '0 18px', background: '#000835', color: '#fff', fontSize: 13, fontWeight: 600, border: 'none', borderRadius: 7, cursor: 'pointer', whiteSpace: 'nowrap' },
  unlinkBtn: { height: 28, padding: '0 12px', background: '#fff', color: '#DC2626', fontSize: 12, fontWeight: 500, border: '1px solid #FECACA', borderRadius: 6, cursor: 'pointer' },
  deleteBtn: { background: 'transparent', border: 'none', color: '#9CA3AF', cursor: 'pointer', fontSize: 12, padding: '0 2px', flexShrink: 0 },

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
  rankBadge: { display: 'inline-block', padding: '2px 7px', background: '#EEF2FF', color: '#3730A3', fontSize: 10, fontWeight: 600, borderRadius: 4 },
  seqBadge: { display: 'inline-block', padding: '2px 7px', background: '#F3F4F6', color: '#4B5563', fontSize: 10, fontWeight: 600, borderRadius: 4 },
  parallelBadge: { display: 'inline-block', padding: '2px 7px', background: '#FFF7ED', color: '#7C2D12', fontSize: 10, fontWeight: 600, borderRadius: 4 },

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

  coverageRow: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 16 },
  coverageLabel: { fontSize: 11, fontWeight: 600, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.6px' },
  coverageHint: { fontSize: 11, color: '#9CA3AF' },

  tierList: { display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 12 },
  tierRow: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' },
  tierNumber: { fontSize: 11, fontWeight: 700, color: '#3730A3', background: '#EEF2FF', borderRadius: 4, padding: '4px 8px', minWidth: 54, textAlign: 'center' },

  linkRow: { display: 'flex', gap: 10, marginBottom: 20, alignItems: 'center', flexWrap: 'wrap' },
  tableWrap: { overflowX: 'auto' },
  table: { borderCollapse: 'collapse', width: '100%' },
  th: { padding: '8px 12px', textAlign: 'left', background: '#F9FAFB', borderBottom: '1px solid #E5E7EB', whiteSpace: 'nowrap', fontSize: 11, fontWeight: 600, color: '#374151' },
  td: { padding: '8px 12px', borderBottom: '1px solid #F3F4F6', fontSize: 12, verticalAlign: 'middle' },
}
