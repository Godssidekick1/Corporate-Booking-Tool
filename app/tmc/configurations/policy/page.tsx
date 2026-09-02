'use client'

import { useEffect, useRef, useState } from 'react'
import {
  CATEGORIES,
  ALL_FIELDS,
  type CategoryDef,
  type FieldDef,
} from '@/app/lib/policy/fields'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Company { id: string; name: string }

interface PolicyGroup {
  id: string
  name: string
  code: string | null
  description: string | null
  bandRanks: number[]
  companyCount: number
}

interface RuleRow {
  band_rank: number
  travel_type: string
  limit_key: string
  limit_value: number | null
  limit_bool: boolean | null
}

interface CompanyLink {
  policyGroupId: string
  assignedAt: string
  group: {
    id: string
    name: string
    code: string | null
    bandRanks: number[]
  } | null
}

// ── Rank helpers ──────────────────────────────────────────────────────────────
// Rules are keyed by integer band_rank, not a company's band codes — a shared
// template has no single company's labels to key against, and mapping a rank
// back to whatever a company calls it ("L1", "A1", "C") is
// resolveEffectivePolicy's job at read time.
//
// Coverage is an explicit set, so a group can span non-contiguous ranks
// (1, 4, 7). Contiguous spans are still the common case, hence the "1-3"
// shorthand below — but a range is only an input convenience here, never a
// stored concept.

// Parses "1-3, 7" / "1 4 7" / "2" into a sorted, deduped rank set. Anything
// unparseable is dropped rather than rejected, so a half-typed value doesn't
// throw while the admin is still editing.
export function parseRankSpec(spec: string): number[] {
  const ranks = new Set<number>()

  for (const chunk of spec.split(/[,\s]+/)) {
    if (!chunk) continue

    const range = chunk.match(/^(\d+)\s*[-–]\s*(\d+)$/)
    if (range) {
      const from = Number(range[1])
      const to = Number(range[2])
      if (from <= to && to - from <= 50) {
        for (let r = from; r <= to; r++) ranks.add(r)
      }
      continue
    }

    const single = Number(chunk)
    if (Number.isInteger(single) && single >= 0) ranks.add(single)
  }

  return Array.from(ranks).sort((a, b) => a - b)
}

// Renders a set compactly, collapsing runs back into ranges: [1,2,3,7] reads
// "Ranks 1–3, 7" rather than "Ranks 1, 2, 3, 7".
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

    runStart = current
    previous = current
  }

  return `${bandRanks.length === 1 ? 'Rank' : 'Ranks'} ${parts.join(', ')}`
}

// ── Grid helpers ──────────────────────────────────────────────────────────────

type CellVal = number | boolean | null
// Keyed by String(rank) — object keys are strings in JS, so keeping the
// conversion explicit avoids silent number/string key mismatches.
type Grid = Record<string, Record<string, CellVal>>

function buildEmptyGrid(ranks: number[]): Grid {
  const g: Grid = {}
  for (const rank of ranks) {
    g[String(rank)] = {}
    for (const f of ALL_FIELDS) g[String(rank)][f.key] = f.kind === 'boolean' ? false : null
  }
  return g
}

function rowsToGrid(rows: RuleRow[], ranks: number[]): Grid {
  const g = buildEmptyGrid(ranks)
  for (const r of rows) {
    const key = String(r.band_rank)
    if (!g[key]) g[key] = {}
    g[key][r.limit_key] = r.limit_value ?? r.limit_bool ?? null
  }
  return g
}

function gridToRules(grid: Grid, ranks: number[]): RuleRow[] {
  const rows: RuleRow[] = []
  for (const rank of ranks) {
    for (const f of ALL_FIELDS) {
      const val = grid[String(rank)]?.[f.key]
      if (val === null || val === undefined) continue
      rows.push({
        band_rank: rank,
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
function countSetFields(grid: Grid, category: CategoryDef, ranks: number[]): { set: number; total: number } {
  const countableFields = category.fields.filter(f => f.kind !== 'boolean')
  let set = 0
  for (const rank of ranks) {
    for (const f of countableFields) {
      const val = grid[String(rank)]?.[f.key]
      if (val !== null && val !== undefined) set++
    }
  }
  return { set, total: ranks.length * countableFields.length }
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
  const [tab, setTab] = useState<'groups' | 'companies'>('groups')

  const [groups, setGroups] = useState<PolicyGroup[]>([])
  const [search, setSearch] = useState('')
  const [selectedGroupId, setSelectedGroupId] = useState('')

  const [grid, setGrid] = useState<Grid>({})
  const [version, setVersion] = useState(0)
  const [openCategories, setOpenCategories] = useState<Record<string, boolean>>({ flight: true })

  const [companies, setCompanies] = useState<Company[]>([])
  const [selectedCompanyId, setSelectedCompanyId] = useState('')
  const [links, setLinks] = useState<CompanyLink[]>([])
  const [linkGroupId, setLinkGroupId] = useState('')

  const [loadingGroups, setLoadingGroups] = useState(true)
  const [loadingRules, setLoadingRules] = useState(false)
  const [loadingCompanies, setLoadingCompanies] = useState(false)
  const [loadingLinks, setLoadingLinks] = useState(false)
  const [saving, setSaving] = useState(false)
  const [linking, setLinking] = useState(false)

  const [showGroupForm, setShowGroupForm] = useState(false)
  const [groupForm, setGroupForm] = useState({ name: '', code: '', description: '', rankSpec: '' })
  const [editingRanks, setEditingRanks] = useState('')
  const [savingRanks, setSavingRanks] = useState(false)
  const [copySourceRank, setCopySourceRank] = useState('')
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

  const selectedGroup = groups.find(g => g.id === selectedGroupId)
  const ranks = selectedGroup?.bandRanks ?? []

  // ── Loaders ─────────────────────────────────────────────────────────────────

  // Debounced so typing in the search box doesn't fire a request per keystroke.
  // Also covers the initial load — it runs once on mount with an empty term.
  useEffect(() => {
    const t = setTimeout(() => loadGroups(search), 250)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search])

  useEffect(() => {
    if (!selectedGroupId || !selectedGroup) { setGrid({}); setVersion(0); setDirty(false); return }
    loadRules(selectedGroupId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedGroupId])

  useEffect(() => {
    if (tab !== 'companies' || companies.length > 0) return
    setLoadingCompanies(true)
    fetch('/api/tmc/companies')
      .then(r => r.json())
      .then(d => { if (d.ok) setCompanies(d.companies) })
      .finally(() => setLoadingCompanies(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab])

  useEffect(() => {
    if (!selectedCompanyId) { setLinks([]); return }
    loadLinks(selectedCompanyId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCompanyId])

  async function loadGroups(searchTerm: string) {
    setLoadingGroups(true); setError('')
    try {
      const qs = searchTerm.trim() ? `?search=${encodeURIComponent(searchTerm.trim())}` : ''
      const d = await fetch(`/api/tmc/policy-groups${qs}`).then(r => r.json())
      if (!d.ok) { setError(d.error || 'Could not load policy groups.'); return }
      setGroups(d.groups)
    } finally { setLoadingGroups(false) }
  }

  async function loadRules(groupId: string) {
    setLoadingRules(true); setError('')
    try {
      const d = await fetch(`/api/tmc/policy-rules?groupId=${groupId}`).then(r => r.json())
      if (!d.ok) { setError(d.error || 'Could not load rules.'); return }
      const group = groups.find(g => g.id === groupId)
      setGrid(rowsToGrid(d.rows, group?.bandRanks ?? []))
      setVersion(d.version)
      setDirty(false)
    } finally { setLoadingRules(false) }
  }

  async function loadLinks(companyId: string) {
    setLoadingLinks(true); setError('')
    try {
      const d = await fetch(`/api/tmc/company-policy-groups?companyId=${companyId}`).then(r => r.json())
      if (!d.ok) { setError(d.error || 'Could not load linked groups.'); return }
      setLinks(d.links)
    } finally { setLoadingLinks(false) }
  }

  // ── Group actions ───────────────────────────────────────────────────────────

  async function handleCreateGroup(e: React.FormEvent) {
    e.preventDefault(); setGroupSubmitting(true); setError('')
    try {
      const d = await fetch('/api/tmc/policy-groups', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: groupForm.name,
          code: groupForm.code || undefined,
          description: groupForm.description || undefined,
          bandRanks: parseRankSpec(groupForm.rankSpec),
        }),
      }).then(r => r.json())
      if (!d.ok) { setError(d.error || 'Could not create group.'); return }
      setGroupForm({ name: '', code: '', description: '', rankSpec: '' })
      setShowGroupForm(false)
      await loadGroups(search)
      setSelectedGroupId(d.group.id)
      showSuccess('Policy group created.')
    } finally { setGroupSubmitting(false) }
  }

  async function handleDeleteGroup(id: string, name: string) {
    if (!confirm(`Delete "${name}"? This only works if no companies are using it.`)) return
    setError('')
    const d = await fetch(`/api/tmc/policy-groups/${id}`, { method: 'DELETE' }).then(r => r.json())
    if (!d.ok) { setError(d.error || 'Could not delete group.'); return }
    showSuccess('Policy group deleted.')
    if (selectedGroupId === id) setSelectedGroupId('')
    loadGroups(search)
  }

  // Coverage is editable after creation — a TMC finding out a client uses
  // rank 7 shouldn't have to rebuild the group and re-author every rule.
  async function handleSaveRanks() {
    if (!selectedGroup) return
    const desired = parseRankSpec(editingRanks)

    if (desired.length === 0) {
      setError('A group needs at least one rank. Delete the group instead if it is no longer used.')
      return
    }

    const dropped = selectedGroup.bandRanks.filter(r => !desired.includes(r))
    if (dropped.length > 0 && !confirm(
      `Removing rank${dropped.length > 1 ? 's' : ''} ${dropped.join(', ')} will retire any rules saved at ` +
      `${dropped.length > 1 ? 'those ranks' : 'that rank'}. Continue?`
    )) return

    setSavingRanks(true); setError('')
    try {
      const d = await fetch(`/api/tmc/policy-groups/${selectedGroupId}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bandRanks: desired }),
      }).then(r => r.json())
      if (!d.ok) { setError(d.error || 'Could not update coverage.'); return }
      await loadGroups(search)
      await loadRules(selectedGroupId)
      setEditingRanks('')
      showSuccess('Coverage updated.')
    } finally { setSavingRanks(false) }
  }

  // ── Copying one rank across the rest ────────────────────────────────────────
  // Most groups covering several ranks give them identical limits — that is
  // usually why the ranks were grouped together in the first place. Filling
  // rank 1 and copying it beats retyping the same grid three times.
  //
  // `fields` scopes the copy: one category's fields for the per-row action, or
  // every field for the whole-policy action.
  function copyRankAcross(sourceRank: number, fields: FieldDef[], label: string) {
    const targets = ranks.filter(r => r !== sourceRank)
    if (targets.length === 0) return

    const source = grid[String(sourceRank)] ?? {}

    // Only warn when a target actually holds something different that would be
    // lost. Copying over blanks, or over values that already match, is not
    // worth a confirm dialog.
    const wouldOverwrite = targets.some(target =>
      fields.some(f => {
        const existing = grid[String(target)]?.[f.key]
        if (existing === null || existing === undefined || existing === false) return false
        return existing !== source[f.key]
      })
    )

    if (wouldOverwrite && !confirm(
      `Overwrite ${label} for rank${targets.length > 1 ? 's' : ''} ${targets.join(', ')} with rank ${sourceRank}'s values?`
    )) return

    setGrid(prev => {
      const next = { ...prev }
      for (const target of targets) {
        const row = { ...(next[String(target)] ?? {}) }
        for (const f of fields) row[f.key] = source[f.key] ?? (f.kind === 'boolean' ? false : null)
        next[String(target)] = row
      }
      return next
    })

    setDirty(true)
    setSuccess('')
    showSuccess(`Copied rank ${sourceRank}'s ${label} to rank${targets.length > 1 ? 's' : ''} ${targets.join(', ')}.`)
  }

  function handleCellChange(rank: number, key: string, value: CellVal) {
    setGrid(prev => ({ ...prev, [String(rank)]: { ...prev[String(rank)], [key]: value } }))
    setDirty(true); setSuccess('')
  }

  // Whole-number fields round on entry so "why can I type 3.7 stars" can't
  // happen again — currency (₹) fields are left as-is since paise amounts
  // are legitimate.
  function handleNumericInputChange(rank: number, field: FieldDef, raw: string) {
    if (raw === '') { handleCellChange(rank, field.key, null); return }
    const n = Number(raw)
    if (Number.isNaN(n)) return
    handleCellChange(rank, field.key, field.wholeNumber ? Math.round(n) : n)
  }

  async function handleSaveRules() {
    if (!selectedGroup) return
    setSaving(true); setError(''); setSuccess('')
    try {
      const rules = gridToRules(grid, ranks)
      if (rules.length === 0) { setError('Set at least one value before saving.'); return }
      const d = await fetch('/api/tmc/policy-rules', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ policyGroupId: selectedGroupId, rules }),
      }).then(r => r.json())
      if (!d.ok) { setError(d.error || 'Could not save rules.'); return }
      setVersion(d.newVersion); setDirty(false)
      showSuccess(`Saved as version ${d.newVersion}.`)
    } finally { setSaving(false) }
  }

  // ── Link actions ────────────────────────────────────────────────────────────

  async function handleLinkGroup() {
    if (!selectedCompanyId || !linkGroupId) return
    setLinking(true); setError('')
    try {
      const d = await fetch('/api/tmc/company-policy-groups', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId: selectedCompanyId, policyGroupId: linkGroupId }),
      }).then(r => r.json())
      if (!d.ok) { setError(d.error || 'Could not link group.'); return }
      setLinkGroupId('')
      await loadLinks(selectedCompanyId)
      loadGroups(search)
      showSuccess('Policy group linked.')
    } finally { setLinking(false) }
  }

  async function handleUnlinkGroup(policyGroupId: string, name: string) {
    if (!confirm(`Unlink "${name}" from this company? Employees in its rank range will have no policy until another group covers them.`)) return
    setError('')
    const d = await fetch(
      `/api/tmc/company-policy-groups?companyId=${selectedCompanyId}&policyGroupId=${policyGroupId}`,
      { method: 'DELETE' }
    ).then(r => r.json())
    if (!d.ok) { setError(d.error || 'Could not unlink group.'); return }
    await loadLinks(selectedCompanyId)
    loadGroups(search)
    showSuccess('Policy group unlinked.')
  }

  function toggleCategory(id: string) {
    setOpenCategories(prev => ({ ...prev, [id]: !prev[id] }))
  }

  const linkedIds = new Set(links.map(l => l.policyGroupId))
  const linkableGroups = groups.filter(g => !linkedIds.has(g.id))

  return (
    <div style={s.root}>
      {/* ── Page header ──────────────────────────────────────────── */}
      <div style={s.pageHeader}>
        <div>
          <h1 style={s.heading}>Policy editor</h1>
          <p style={s.sub}>
            Build reusable policy groups by band rank, then link them to client companies.
          </p>
        </div>
      </div>

      {/* ── Tabs ─────────────────────────────────────────────────── */}
      <div style={s.tabRow}>
        <button onClick={() => setTab('groups')} style={{ ...s.tabBtn, ...(tab === 'groups' ? s.tabActive : {}) }}>
          Policy groups
        </button>
        <button onClick={() => setTab('companies')} style={{ ...s.tabBtn, ...(tab === 'companies' ? s.tabActive : {}) }}>
          Company assignments
        </button>
      </div>

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
      {/* GROUPS TAB                                                 */}
      {/* ══════════════════════════════════════════════════════════ */}
      {tab === 'groups' && (
        <>
          <div style={s.card}>
            <div style={s.cardHeader}>
              <div>
                <h2 style={s.cardTitle}>Policy groups</h2>
                <p style={s.cardSub}>
                  A group holds one set of limits for a range of band ranks, and can be
                  reused across any number of client companies.
                </p>
              </div>
              <button onClick={() => setShowGroupForm(v => !v)} style={s.ghostBtn}>
                {showGroupForm ? 'Cancel' : '+ New group'}
              </button>
            </div>

            {showGroupForm && (
              <form onSubmit={handleCreateGroup} style={s.groupForm}>
                <input
                  type="text" required placeholder="Group name — e.g. Standard, Executive"
                  value={groupForm.name}
                  onChange={e => setGroupForm(p => ({ ...p, name: e.target.value }))}
                  style={{ ...s.input, flex: 2, minWidth: 180 }}
                  autoFocus
                />
                <input
                  type="text" placeholder="Code (optional)"
                  value={groupForm.code}
                  onChange={e => setGroupForm(p => ({ ...p, code: e.target.value }))}
                  style={{ ...s.input, flex: 1, minWidth: 120 }}
                />
                <input
                  type="text" placeholder="Ranks — e.g. 1-3 or 1, 4, 7"
                  value={groupForm.rankSpec}
                  onChange={e => setGroupForm(p => ({ ...p, rankSpec: e.target.value }))}
                  style={{ ...s.input, flex: 1, minWidth: 180 }}
                />
                <input
                  type="text" placeholder="Description (optional)"
                  value={groupForm.description}
                  onChange={e => setGroupForm(p => ({ ...p, description: e.target.value }))}
                  style={{ ...s.input, flex: 2, minWidth: 180 }}
                />
                <button type="submit" disabled={groupSubmitting} style={{ ...s.primaryBtn, opacity: groupSubmitting ? 0.7 : 1 }}>
                  {groupSubmitting ? 'Creating…' : 'Create group'}
                </button>
                <p style={s.formHint}>
                  Ranks may be non-contiguous — <code style={s.codeInline}>1, 4, 7</code> is
                  as valid as <code style={s.codeInline}>1-3</code>. A group covers exactly
                  the ranks you list, so leaving this empty means it covers nothing until
                  you add some.
                  {groupForm.rankSpec.trim() && (
                    <> Will cover: <strong>{ranksLabel(parseRankSpec(groupForm.rankSpec))}</strong>.</>
                  )}
                </p>
              </form>
            )}

            <input
              type="search"
              placeholder="Search groups by name or code…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              style={{ ...s.input, width: '100%', marginBottom: 16 }}
            />

            {loadingGroups ? (
              <p style={s.muted}>Loading groups…</p>
            ) : groups.length === 0 ? (
              <div style={s.emptyGroups}>
                <p style={s.emptyTitle}>{search ? 'No groups match that search' : 'No policy groups yet'}</p>
                <p style={s.emptyDesc}>
                  {search ? 'Try a different name or code.' : 'Create a group to start configuring limits by band rank.'}
                </p>
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
                    <div style={s.groupCardTags}>
                      <span style={s.rangeBadge}>{ranksLabel(g.bandRanks)}</span>
                      {g.code && <span style={s.codeBadge}>{g.code}</span>}
                    </div>
                    {g.description && <p style={s.groupCardDesc}>{g.description}</p>}
                    <p style={s.groupCardMeta}>
                      {g.companyCount === 0
                        ? 'Not used by any company'
                        : `Used by ${g.companyCount} compan${g.companyCount === 1 ? 'y' : 'ies'}`}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* ── Rules editor ─────────────────────────────────────── */}
          {selectedGroupId && selectedGroup && (
            <div style={s.card}>
              <div style={s.rulesTopBar}>
                <div>
                  <h2 style={s.cardTitle}>
                    {selectedGroup.name} <span style={s.rangeInline}>· {ranksLabel(selectedGroup.bandRanks)}</span>
                  </h2>
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

              {/* Coverage editor */}
              <div style={s.coverageRow}>
                <label style={s.coverageLabel}>Covers</label>
                <input
                  type="text"
                  value={editingRanks}
                  onChange={e => setEditingRanks(e.target.value)}
                  placeholder={selectedGroup.bandRanks.join(', ') || 'e.g. 1-3 or 1, 4, 7'}
                  style={{ ...s.input, flex: 1, minWidth: 160 }}
                />
                <button
                  onClick={handleSaveRanks}
                  disabled={savingRanks || !editingRanks.trim()}
                  style={{ ...s.ghostBtn, opacity: savingRanks || !editingRanks.trim() ? 0.5 : 1 }}
                >
                  {savingRanks ? 'Updating…' : 'Update coverage'}
                </button>
                <span style={s.coverageHint}>
                  Currently {ranksLabel(selectedGroup.bandRanks).toLowerCase()}.
                </span>
              </div>

              {/* Copy one rank's whole policy across the rest. Ranks are usually
                  grouped together precisely because they share limits, so this is
                  the common path rather than an edge case. */}
              {ranks.length > 1 && (
                <div style={s.copyAllRow}>
                  <label style={s.coverageLabel}>Same limits for every rank?</label>
                  {/* Falls back to the lowest rank rather than tracking a default
                      in state, so switching groups can't leave a stale source
                      rank selected that the new group doesn't even cover. */}
                  <select
                    value={ranks.includes(Number(copySourceRank)) ? copySourceRank : String(ranks[0])}
                    onChange={e => setCopySourceRank(e.target.value)}
                    style={{ ...s.input, width: 130 }}
                  >
                    {ranks.map(r => <option key={r} value={String(r)}>Rank {r}</option>)}
                  </select>
                  <button
                    onClick={() => copyRankAcross(
                      ranks.includes(Number(copySourceRank)) ? Number(copySourceRank) : ranks[0],
                      ALL_FIELDS,
                      'limits'
                    )}
                    style={s.ghostBtn}
                  >
                    Copy to all other ranks
                  </button>
                  <span style={s.coverageHint}>
                    Copies every category. Use ⧉ on a row to copy just that section.
                  </span>
                </div>
              )}

              {ranks.length === 0 && (
                <div style={s.blastBanner}>
                  This group covers no band ranks, so it applies to nobody and cannot be
                  linked to a company. Add ranks above to start configuring limits.
                </div>
              )}

              {/* Blast radius: a shared template's limits apply everywhere it's linked. */}
              {selectedGroup.companyCount > 1 && (
                <div style={s.blastBanner}>
                  This group is shared by <strong>{selectedGroup.companyCount} companies</strong>.
                  Saving changes the policy in force for all of them.
                </div>
              )}

              {loadingRules ? (
                <div style={s.loadingRules}>
                  <div style={s.spinner} />
                  <p style={s.muted}>Loading rules…</p>
                </div>
              ) : (
                <div style={s.categories}>
                  {CATEGORIES.map((cat, ci) => {
                    const open = !!openCategories[cat.id]
                    const { set, total } = countSetFields(grid, cat, ranks)
                    return (
                      <div key={cat.id} style={{ ...s.categoryBlock, marginTop: ci === 0 ? 0 : 12 }}>
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

                        {open && (
                          <div style={s.tableInner}>
                            {cat.description && <p style={s.categoryDesc}>{cat.description}</p>}
                            <div style={s.tableWrap}>
                              <table style={s.table}>
                                <thead>
                                  <tr>
                                    <th style={{ ...s.th, ...s.stickyCol, width: 120 }}>Band rank</th>
                                    {cat.fields.map(f => (
                                      <th key={f.key} style={{ ...s.th, minWidth: f.kind === 'tier' ? 160 : f.kind === 'boolean' ? 90 : 120 }}>
                                        <span style={s.colLabel}>{f.label}</span>
                                        {f.unit && <span style={s.colUnit}> · {f.unit}</span>}
                                      </th>
                                    ))}
                                  </tr>
                                </thead>
                                <tbody>
                                  {ranks.map((rank, ri) => (
                                    <tr key={rank} style={{ background: ri % 2 === 0 ? '#fff' : '#FAFAFA' }}>
                                      <td style={{ ...s.td, ...s.stickyCol }}>
                                        <div style={s.bandCell}>
                                          <span style={s.bandBadge}>Rank {rank}</span>
                                          {ranks.length > 1 && (
                                            <button
                                              onClick={() => copyRankAcross(rank, cat.fields, cat.label.toLowerCase())}
                                              style={s.copyRowBtn}
                                              title={`Copy this rank's ${cat.label.toLowerCase()} to every other rank`}
                                            >
                                              ⧉
                                            </button>
                                          )}
                                        </div>
                                      </td>
                                      {cat.fields.map(f => {
                                        const val = grid[String(rank)]?.[f.key]
                                        if (f.kind === 'boolean') {
                                          return (
                                            <td key={f.key} style={{ ...s.td, textAlign: 'center' as const }}>
                                              <label style={s.toggleLabel}>
                                                <input
                                                  type="checkbox"
                                                  checked={Boolean(val)}
                                                  onChange={e => handleCellChange(rank, f.key, e.target.checked)}
                                                  style={{ display: 'none' }}
                                                />
                                                <span style={{ ...s.toggle, background: val ? '#000835' : '#E5E7EB' }}>
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
                                                onChange={e => handleCellChange(rank, f.key, e.target.value === '' ? null : Number(e.target.value))}
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
                                              onChange={e => handleNumericInputChange(rank, f, e.target.value)}
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
      {/* COMPANIES TAB                                              */}
      {/* ══════════════════════════════════════════════════════════ */}
      {tab === 'companies' && (
        <div style={s.card}>
          <div style={s.cardHeader}>
            <div>
              <h2 style={s.cardTitle}>Company assignments</h2>
              <p style={s.cardSub}>
                Link policy groups to a company so their rank ranges cover every band.
                Ranges may not overlap — an employee must match exactly one group.
              </p>
            </div>
          </div>

          <div style={{ ...s.field, maxWidth: 320, marginBottom: 20 }}>
            <label style={s.label}>Company</label>
            <select
              value={selectedCompanyId}
              onChange={e => setSelectedCompanyId(e.target.value)}
              style={s.select}
              disabled={loadingCompanies}
            >
              <option value="">{loadingCompanies ? 'Loading…' : 'Select a company…'}</option>
              {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>

          {selectedCompanyId && (
            <>
              <div style={s.linkRow}>
                <select
                  value={linkGroupId}
                  onChange={e => setLinkGroupId(e.target.value)}
                  style={{ ...s.select, flex: 1 }}
                >
                  <option value="">Select a policy group to link…</option>
                  {linkableGroups.map(g => (
                    <option key={g.id} value={g.id}>
                      {g.name} · {ranksLabel(g.bandRanks)}
                    </option>
                  ))}
                </select>
                <button
                  onClick={handleLinkGroup}
                  disabled={!linkGroupId || linking}
                  style={{ ...s.primaryBtn, opacity: !linkGroupId || linking ? 0.5 : 1 }}
                >
                  {linking ? 'Linking…' : 'Link group'}
                </button>
              </div>

              {loadingLinks ? (
                <p style={s.muted}>Loading linked groups…</p>
              ) : links.length === 0 ? (
                <div style={s.emptyGroups}>
                  <p style={s.emptyTitle}>No policy groups linked</p>
                  <p style={s.emptyDesc}>
                    Until a group is linked, this company&apos;s bookings are not checked
                    against any policy.
                  </p>
                </div>
              ) : (
                <div style={s.tableWrap}>
                  <table style={s.table}>
                    <thead>
                      <tr>
                        {['Policy group', 'Code', 'Rank coverage', 'Linked', ''].map(h => (
                          <th key={h} style={s.th}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {links.map((l, i) => (
                        <tr key={l.policyGroupId} style={{ background: i % 2 === 0 ? '#fff' : '#FAFAFA' }}>
                          <td style={{ ...s.td, fontSize: 13, fontWeight: 500, color: '#111827' }}>
                            {l.group?.name ?? '—'}
                          </td>
                          <td style={s.td}>
                            {l.group?.code ? <span style={s.codeBadge}>{l.group.code}</span> : <span style={s.muted}>—</span>}
                          </td>
                          <td style={s.td}>
                            {l.group ? <span style={s.rangeBadge}>{ranksLabel(l.group.bandRanks)}</span> : <span style={s.muted}>—</span>}
                          </td>
                          <td style={{ ...s.td, fontSize: 12, color: '#6B7280' }}>
                            {new Date(l.assignedAt).toLocaleDateString()}
                          </td>
                          <td style={{ ...s.td, textAlign: 'right' as const }}>
                            <button
                              onClick={() => handleUnlinkGroup(l.policyGroupId, l.group?.name ?? 'this group')}
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

  field: { display: 'flex', flexDirection: 'column', gap: 6 },
  label: { fontSize: 11, fontWeight: 600, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.6px' },
  select: { height: 40, padding: '0 12px', fontSize: 13, color: '#111827', background: '#fff', border: '1px solid #D1D5DB', borderRadius: 8, outline: 'none' },
  input: { height: 38, padding: '0 10px', fontSize: 13, color: '#111827', background: '#fff', border: '1px solid #D1D5DB', borderRadius: 7, outline: 'none' },

  tabRow: { display: 'flex', gap: 0, marginBottom: 20, borderBottom: '1px solid #E5E7EB' },
  tabBtn: { padding: '9px 16px', background: 'transparent', border: 'none', borderBottom: '2px solid transparent', fontSize: 13, color: '#6B7280', cursor: 'pointer', marginBottom: -1 },
  tabActive: { color: '#000835', fontWeight: 600, borderBottomColor: '#000835' },

  errorBanner: { display: 'flex', alignItems: 'center', gap: 8, background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8, padding: '10px 14px', fontSize: 12, color: '#DC2626', marginBottom: 16 },
  successBanner: { display: 'flex', alignItems: 'center', gap: 8, background: '#ECFDF5', border: '1px solid #A7F3D0', borderRadius: 8, padding: '10px 14px', fontSize: 12, color: '#065F46', marginBottom: 16 },
  blastBanner: { background: '#FEF3C7', border: '1px solid #FDE68A', borderRadius: 8, padding: '10px 14px', fontSize: 12, color: '#92400E', marginBottom: 16, lineHeight: 1.5 },
  bannerIcon: { fontSize: 14, flexShrink: 0 },
  bannerClose: { marginLeft: 'auto', background: 'transparent', border: 'none', color: '#DC2626', cursor: 'pointer', fontSize: 13 },

  card: { background: '#fff', border: '1px solid #E5E7EB', borderRadius: 12, padding: 20, marginBottom: 16, position: 'relative' },
  cardHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16, gap: 16 },
  cardTitle: { fontSize: 14, fontWeight: 600, color: '#111827', margin: '0 0 3px' },
  cardSub: { fontSize: 12, color: '#9CA3AF', margin: 0, lineHeight: 1.5 },

  groupForm: { display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' },
  formHint: { fontSize: 11, color: '#9CA3AF', margin: 0, width: '100%' },
  ghostBtn: { height: 34, padding: '0 14px', background: '#fff', color: '#374151', fontSize: 12, fontWeight: 500, border: '1px solid #D1D5DB', borderRadius: 7, cursor: 'pointer', whiteSpace: 'nowrap' },
  primaryBtn: { height: 36, padding: '0 18px', background: '#000835', color: '#fff', fontSize: 13, fontWeight: 600, border: 'none', borderRadius: 7, cursor: 'pointer', whiteSpace: 'nowrap' },
  unlinkBtn: { height: 28, padding: '0 12px', background: '#fff', color: '#DC2626', fontSize: 12, fontWeight: 500, border: '1px solid #FECACA', borderRadius: 6, cursor: 'pointer' },

  linkRow: { display: 'flex', gap: 10, marginBottom: 20, alignItems: 'center', flexWrap: 'wrap' },

  emptyGroups: { padding: '24px 0', textAlign: 'center' },
  emptyTitle: { fontSize: 13, fontWeight: 600, color: '#374151', margin: '0 0 4px' },
  emptyDesc: { fontSize: 12, color: '#9CA3AF', margin: 0 },

  groupGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12 },
  groupCard: { border: '1.5px solid', borderRadius: 10, padding: '14px 16px', cursor: 'pointer', transition: 'all 0.15s', position: 'relative' },
  groupCardTop: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 },
  groupCardName: { fontSize: 13, fontWeight: 600, color: '#111827', flex: 1 },
  groupCardTags: { display: 'flex', gap: 6, marginBottom: 6, flexWrap: 'wrap' },
  groupCardDesc: { fontSize: 11, color: '#9CA3AF', margin: '0 0 6px', lineHeight: 1.4 },
  groupCardMeta: { fontSize: 11, color: '#9CA3AF', margin: 0 },
  groupCardDelete: { background: 'transparent', border: 'none', color: '#D1D5DB', cursor: 'pointer', fontSize: 12, padding: '0 2px', flexShrink: 0 },

  rangeBadge: { display: 'inline-block', padding: '2px 7px', background: '#EEF2FF', color: '#3730A3', fontSize: 10, fontWeight: 600, borderRadius: 4 },
  coverageRow: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 16, padding: '12px 14px', background: '#F9FAFB', border: '1px solid #E5E7EB', borderRadius: 8 },
  copyAllRow: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 16, padding: '12px 14px', background: '#F5F7FF', border: '1px solid #C7D2FE', borderRadius: 8 },
  copyRowBtn: { background: 'transparent', border: 'none', color: '#6366F1', cursor: 'pointer', fontSize: 13, padding: '0 2px', lineHeight: 1, flexShrink: 0 },
  coverageLabel: { fontSize: 11, fontWeight: 600, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.6px' },
  coverageHint: { fontSize: 11, color: '#9CA3AF' },
  codeInline: { background: '#F3F4F6', padding: '1px 5px', borderRadius: 3, fontSize: 10 },
  codeBadge: { display: 'inline-block', padding: '2px 7px', background: '#F3F4F6', color: '#4B5563', fontSize: 10, fontWeight: 600, borderRadius: 4, fontFamily: 'ui-monospace, monospace' },
  rangeInline: { fontSize: 12, fontWeight: 400, color: '#9CA3AF' },

  rulesTopBar: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20, gap: 16 },
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

  numInput: { width: 100, height: 30, padding: '0 8px', fontSize: 12, color: '#111827', background: '#F9FAFB', border: '1px solid transparent', borderRadius: 5, outline: 'none' },
  tierSelect: { height: 30, padding: '0 8px', fontSize: 12, color: '#111827', background: '#F9FAFB', border: '1px solid #E5E7EB', borderRadius: 5, outline: 'none', cursor: 'pointer', minWidth: 140 },

  toggleLabel: { display: 'inline-flex', alignItems: 'center', cursor: 'pointer' },
  toggle: { position: 'relative', display: 'inline-block', width: 32, height: 18, borderRadius: 9, transition: 'background 0.2s', flexShrink: 0 },
  toggleKnob: { position: 'absolute', top: 2, left: 2, width: 14, height: 14, background: '#fff', borderRadius: '50%', transition: 'transform 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.25)' },

  loadingRules: { display: 'flex', alignItems: 'center', gap: 10, padding: '24px 0' },
  spinner: { width: 16, height: 16, border: '2px solid #E5E7EB', borderTopColor: '#000835', borderRadius: '50%', animation: 'spin 0.7s linear infinite' },
  muted: { fontSize: 12, color: '#9CA3AF', margin: 0 },

  stickyBar: { position: 'sticky', bottom: 0, left: 0, right: 0, background: '#000835', borderRadius: '0 0 12px 12px', padding: '12px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 16 },
  stickyBarText: { fontSize: 13, color: 'rgba(255,255,255,0.7)' },
  stickyBarBtn: { height: 34, padding: '0 18px', background: '#fff', color: '#000835', fontSize: 13, fontWeight: 700, border: 'none', borderRadius: 6, cursor: 'pointer' },
}
