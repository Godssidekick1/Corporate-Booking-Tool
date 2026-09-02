'use client'

import { useEffect, useRef, useState } from 'react'
import StepApprovers, { type TemplateStep } from './StepApprovers'
import DirectChain from './DirectChain'

// NOTE: no TmcShell here. app/tmc/configurations/layout.tsx supplies the
// Settings sidebar and page chrome for everything under /tmc/configurations —
// wrapping again nests a second sidebar inside the first.

// ── Types ─────────────────────────────────────────────────────────────────────

interface Client { id: string; name: string }

type ChainMode = 'sequential' | 'parallel'
type ChainQuorum = 'any' | 'all'

interface Chain {
  id: string
  name: string
  code: string | null
  category: string
  mode: ChainMode
  quorum: ChainQuorum
  tiers: TemplateStep[]
  client_id: string | null
  employeeCount: number
  defaultForClients: number
  version: number
}

interface RosterEmployee {
  id: string
  full_name: string
  email: string
  band_code: string | null
  assignments: Record<string, string | null>
}

// ── Constants ─────────────────────────────────────────────────────────────────

const CATEGORIES: { value: string; label: string }[] = [
  { value: 'flights_hotels', label: 'Flights & hotels' },
  { value: 'misc', label: 'Everything else' },
]

const VERDICTS: { value: string; label: string }[] = [
  { value: 'green', label: 'Always' },
  { value: 'amber', label: 'Amber and worse' },
  { value: 'red',   label: 'Red only' },
]

type Mode = 'direct' | 'template' | 'assign'

function emptyStep(n: number): TemplateStep {
  return { tier: n, min_verdict: 'amber', label: '' }
}

function categoryLabel(v: string): string {
  return CATEGORIES.find(c => c.value === v)?.label ?? v
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function TmcApprovalsPage() {
  const [mode, setMode] = useState<Mode>('direct')

  const [chains, setChains] = useState<Chain[]>([])
  const [clients, setClients] = useState<Client[]>([])
  const [loading, setLoading] = useState(true)

  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const successTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  function showSuccess(msg: string) {
    setSuccess(msg)
    if (successTimer.current) clearTimeout(successTimer.current)
    successTimer.current = setTimeout(() => setSuccess(''), 4000)
  }

  useEffect(() => { loadAll() }, [])

  async function loadAll() {
    setLoading(true); setError('')
    try {
      const [chainData, clientData] = await Promise.all([
        fetch('/api/tmc/approval-templates').then(r => r.json()),
        fetch('/api/tmc/clients').then(r => r.json()),
      ])
      if (!chainData.ok) { setError(chainData.error || 'Could not load approval chains.'); return }
      setChains(chainData.templates)
      if (clientData.ok) setClients(clientData.clients)
    } finally { setLoading(false) }
  }

  const sharedChains = chains.filter(c => !c.client_id)

  return (
    <div style={s.root}>
      <div style={s.pageHeader}>
        <h1 style={s.heading}>Approval routing</h1>
        <p style={s.sub}>
          Map approvers straight onto a client, or build a reusable chain and assign it.
        </p>
      </div>

      <div style={s.modeRow}>
        <button onClick={() => setMode('direct')} style={{ ...s.modeBtn, ...(mode === 'direct' ? s.modeActive : {}) }}>
          Direct mapping
        </button>
        <button onClick={() => setMode('template')} style={{ ...s.modeBtn, ...(mode === 'template' ? s.modeActive : {}) }}>
          Make a template
        </button>
        {/* Only meaningful once something exists to assign. */}
        {sharedChains.length > 0 && (
          <button onClick={() => setMode('assign')} style={{ ...s.modeBtn, ...(mode === 'assign' ? s.modeActive : {}) }}>
            Assign a template
          </button>
        )}
      </div>

      <p style={s.modeHint}>
        {mode === 'direct' && 'Build an approval chain for one client and name who does each step. Nothing is shared with other clients.'}
        {mode === 'template' && 'Define the shape of a chain — the steps and what triggers each. Who fills them is chosen per client when you assign it.'}
        {mode === 'assign' && 'Put a template to work at a client: name who does each step, then choose who it applies to.'}
      </p>

      {error && (
        <div style={s.errorBanner}>
          <span style={s.icon}>⚠</span> {error}
          <button onClick={() => setError('')} style={s.bannerClose}>✕</button>
        </div>
      )}
      {success && <div style={s.successBanner}><span style={s.icon}>✓</span> {success}</div>}

      {loading ? (
        <p style={s.muted}>Loading…</p>
      ) : mode === 'direct' ? (
        <DirectChain clients={clients} />
      ) : mode === 'template' ? (
        <TemplateBuilder
          chains={sharedChains}
          onChanged={loadAll}
          onError={setError}
          onSuccess={showSuccess}
        />
      ) : (
        <AssignTemplate
          clients={clients}
          chains={sharedChains}
          onChanged={loadAll}
          onError={setError}
          onSuccess={showSuccess}
        />
      )}
    </div>
  )
}


// ── Template builder ──────────────────────────────────────────────────────────

function TemplateBuilder({ chains, onChanged, onError, onSuccess }: {
  chains: Chain[]
  onChanged: () => void
  onError: (m: string) => void
  onSuccess: (m: string) => void
}) {
  const [selectedId, setSelectedId] = useState('')
  const [form, setForm] = useState({ name: '', code: '', category: 'flights_hotels' })
  const [creating, setCreating] = useState(false)

  const selected = chains.find(c => c.id === selectedId)

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault(); setCreating(true)
    try {
      const d = await fetch('/api/tmc/approval-templates', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: form.name,
          code: form.code || undefined,
          category: form.category,
          mode: 'sequential',
          tiers: [emptyStep(1)],
        }),
      }).then(r => r.json())
      if (!d.ok) { onError(d.error || 'Could not create the template.'); return }
      setForm({ name: '', code: '', category: 'flights_hotels' })
      onChanged()
      setSelectedId(d.template.id)
      onSuccess('Template created.')
    } finally { setCreating(false) }
  }

  async function handleDelete(id: string, name: string) {
    if (!confirm(`Delete "${name}"?`)) return
    const d = await fetch(`/api/tmc/approval-templates/${id}`, { method: 'DELETE' }).then(r => r.json())
    if (!d.ok) { onError(d.error || 'Could not delete.'); return }
    if (selectedId === id) setSelectedId('')
    onChanged()
    onSuccess('Template deleted.')
  }

  return (
    <>
      <div style={s.card}>
        <form onSubmit={handleCreate} style={s.form}>
          <input
            type="text" required placeholder="Template name — e.g. Manager then finance"
            value={form.name}
            onChange={e => setForm(p => ({ ...p, name: e.target.value }))}
            style={{ ...s.input, flex: 2, minWidth: 200 }}
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
          <button type="submit" disabled={creating} style={s.primaryBtn}>
            {creating ? 'Creating…' : 'Create'}
          </button>
        </form>

        {chains.length === 0 ? (
          <div style={s.empty}>
            <p style={s.emptyTitle}>No templates yet</p>
            <p style={s.emptyDesc}>Create one to reuse the same approval shape across clients.</p>
          </div>
        ) : (
          <div style={s.grid}>
            {chains.map(c => (
              <div
                key={c.id}
                onClick={() => setSelectedId(c.id === selectedId ? '' : c.id)}
                style={{
                  ...s.chainCard,
                  borderColor: c.id === selectedId ? '#000835' : '#E5E7EB',
                  background: c.id === selectedId ? '#F5F7FF' : '#fff',
                }}
              >
                <div style={s.cardTop}>
                  <span style={s.chainName}>{c.name}</span>
                  <button
                    onClick={ev => { ev.stopPropagation(); handleDelete(c.id, c.name) }}
                    style={s.deleteBtn}
                  >✕</button>
                </div>
                <div style={s.tagRow}>
                  <span style={s.catBadge}>{categoryLabel(c.category)}</span>
                  <span style={s.stepBadge}>{c.tiers.length} step{c.tiers.length === 1 ? '' : 's'}</span>
                </div>
                <p style={s.cardMeta}>
                  {c.employeeCount === 0 && c.defaultForClients === 0
                    ? 'Not in use yet'
                    : [
                        c.employeeCount > 0 ? `${c.employeeCount} employee${c.employeeCount === 1 ? '' : 's'}` : null,
                        c.defaultForClients > 0 ? `default at ${c.defaultForClients}` : null,
                      ].filter(Boolean).join(' · ')}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>

      {selected && (
        <div style={s.card}>
          <div style={s.noteBanner}>
            A template holds the <strong>shape</strong> of a chain only. Who fills each step is
            chosen per client — a person exists at one client, so naming one here could never
            travel.
          </div>
          <StepEditor chain={selected} onChanged={onChanged} onError={onError} onSuccess={onSuccess} />
        </div>
      )}
    </>
  )
}

// ── Step editor (structure) ───────────────────────────────────────────────────

function StepEditor({ chain, onChanged, onError, onSuccess }: {
  chain: Chain
  onChanged: () => void
  onError: (m: string) => void
  onSuccess: (m: string) => void
}) {
  const [steps, setSteps] = useState<TemplateStep[]>(chain.tiers)
  const [mode, setMode] = useState<ChainMode>(chain.mode)
  const [quorum, setQuorum] = useState<ChainQuorum>(chain.quorum)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setSteps(chain.tiers); setMode(chain.mode); setQuorum(chain.quorum); setDirty(false)
  }, [chain.id, chain.version])

  // The modes read step numbers differently: sequential walks distinct numbers
  // in order, parallel raises everything at once and the engine collapses them
  // onto one number anyway.
  function switchMode(next: ChainMode) {
    if (next === mode) return
    setMode(next)
    setSteps(prev => prev.map((t, i) => ({ ...t, tier: next === 'parallel' ? 1 : i + 1 })))
    setDirty(true)
  }

  function update(i: number, patch: Partial<TemplateStep>) {
    setSteps(prev => prev.map((t, idx) => (idx === i ? { ...t, ...patch } : t)))
    setDirty(true)
  }

  function add() {
    setSteps(prev => [...prev, emptyStep(mode === 'parallel' ? 1 : prev.length + 1)])
    setDirty(true)
  }

  function remove(i: number) {
    setSteps(prev => prev.filter((_, idx) => idx !== i).map((t, idx) => ({
      ...t, tier: mode === 'parallel' ? 1 : idx + 1,
    })))
    setDirty(true)
  }

  async function save() {
    setSaving(true)
    try {
      const d = await fetch(`/api/tmc/approval-templates/${chain.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode, quorum, tiers: steps }),
      }).then(r => r.json())
      if (!d.ok) { onError(d.error || 'Could not save.'); return }
      setDirty(false)
      onChanged()
      onSuccess('Steps saved.')
    } finally { setSaving(false) }
  }

  return (
    <div style={s.editor}>
      <div style={s.editorTop}>
        <h3 style={s.sectionTitle}>Steps</h3>
        <div style={s.editorActions}>
          {dirty && <span style={s.unsaved}>Unsaved</span>}
          <button onClick={save} disabled={saving || !dirty} style={{ ...s.primaryBtn, opacity: saving || !dirty ? 0.5 : 1 }}>
            {saving ? 'Saving…' : 'Save steps'}
          </button>
        </div>
      </div>

      <div style={s.toggleRow}>
        <div style={s.toggle}>
          <button onClick={() => switchMode('sequential')} style={{ ...s.toggleBtn, ...(mode === 'sequential' ? s.toggleActive : {}) }}>
            Multi-tier
          </button>
          <button onClick={() => switchMode('parallel')} style={{ ...s.toggleBtn, ...(mode === 'parallel' ? s.toggleActive : {}) }}>
            Multiple approvers
          </button>
        </div>
        {mode === 'parallel' && (
          <select
            value={quorum}
            onChange={e => { setQuorum(e.target.value as ChainQuorum); setDirty(true) }}
            style={{ ...s.input, width: 210 }}
          >
            <option value="all">Everyone must approve</option>
            <option value="any">Any one person approves</option>
          </select>
        )}
        <span style={s.hint}>
          {mode === 'sequential'
            ? 'Each step starts once the previous one approves.'
            : 'Every approver is asked at the same time. A rejection from anyone stops the booking.'}
        </span>
      </div>

      {steps.map((step, i) => (
        <div key={i} style={s.stepRow}>
          <span style={s.stepNum}>{mode === 'sequential' ? `Step ${i + 1}` : `#${i + 1}`}</span>
          <input
            type="text"
            placeholder="What is this step? e.g. Line manager"
            value={step.label ?? ''}
            onChange={e => update(i, { label: e.target.value })}
            style={{ ...s.input, flex: 1, minWidth: 200 }}
          />
          <select
            value={step.min_verdict}
            onChange={e => update(i, { min_verdict: e.target.value })}
            style={{ ...s.input, width: 170 }}
          >
            {VERDICTS.map(v => <option key={v.value} value={v.value}>{v.label}</option>)}
          </select>
          <button onClick={() => remove(i)} disabled={steps.length === 1} style={{ ...s.deleteBtn, opacity: steps.length === 1 ? 0.3 : 1 }}>
            ✕
          </button>
        </div>
      ))}

      <button onClick={add} style={s.ghostBtn}>+ Add step</button>

      {mode === 'parallel' && steps.length < 2 && (
        <p style={s.inlineWarn}>Multiple approvers needs at least two steps.</p>
      )}
    </div>
  )
}

// ── Assign a template ─────────────────────────────────────────────────────────

function AssignTemplate({ clients, chains, onChanged, onError, onSuccess }: {
  clients: Client[]
  chains: Chain[]
  onChanged: () => void
  onError: (m: string) => void
  onSuccess: (m: string) => void
}) {
  const [templateId, setTemplateId] = useState('')
  const [clientId, setClientId] = useState('')

  const template = chains.find(c => c.id === templateId)

  return (
    <div style={s.card}>
      <div style={s.filterRow}>
        <div style={s.field}>
          <label style={s.label}>Template</label>
          <select value={templateId} onChange={e => setTemplateId(e.target.value)} style={{ ...s.input, width: 260 }}>
            <option value="">Select a template…</option>
            {chains.map(c => (
              <option key={c.id} value={c.id}>{c.name} · {categoryLabel(c.category)}</option>
            ))}
          </select>
        </div>
        <div style={s.field}>
          <label style={s.label}>Client</label>
          <select value={clientId} onChange={e => setClientId(e.target.value)} style={{ ...s.input, width: 240 }}>
            <option value="">Select a client…</option>
            {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
      </div>

      {!template || !clientId ? (
        <p style={s.muted}>Pick a template and a client to continue.</p>
      ) : (
        <>
          <h3 style={s.sectionTitle}>Who does each step at {clients.find(c => c.id === clientId)?.name}</h3>
          <StepApprovers
            clientId={clientId}
            templateId={template.id}
            steps={template.tiers}
          />
          <AppliesTo
            clientId={clientId}
            category={template.category}
            templateId={template.id}
            onError={onError}
            onSuccess={onSuccess}
          />
        </>
      )}
    </div>
  )
}

// ── Applies to ────────────────────────────────────────────────────────────────
// Whether this chain covers the whole client or named employees. Shared by
// both flows so "assign" means the same thing in each.

function AppliesTo({ clientId, category, templateId, onError, onSuccess }: {
  clientId: string
  category: string
  templateId: string
  onError: (m: string) => void
  onSuccess: (m: string) => void
}) {
  const [roster, setRoster] = useState<RosterEmployee[]>([])
  const [defaults, setDefaults] = useState<Record<string, string | null>>({})
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

  useEffect(() => { load() }, [clientId, category])

  async function load() {
    setLoading(true)
    try {
      const d = await fetch(`/api/tmc/approval-assignments?clientId=${clientId}`).then(r => r.json())
      if (!d.ok) { onError(d.error || 'Could not load the roster.'); return }
      setRoster(d.employees); setDefaults(d.defaults); setSelected(new Set())
    } finally { setLoading(false) }
  }

  async function assign(employeeIds?: string[]) {
    setBusy(true)
    try {
      const d = await fetch('/api/tmc/approval-assignments', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId, category, templateId, employeeIds }),
      }).then(r => r.json())
      if (!d.ok) { onError(d.error || 'Could not assign.'); return }
      await load()
      onSuccess(employeeIds ? `Applied to ${employeeIds.length} employee${employeeIds.length === 1 ? '' : 's'}.` : 'Set as the client default.')
    } finally { setBusy(false) }
  }

  const isDefault = defaults[category] === templateId

  return (
    <div style={s.appliesTo}>
      <h3 style={s.sectionTitle}>Who this applies to</h3>

      <div style={s.applyRow}>
        <button onClick={() => assign()} disabled={busy || isDefault} style={{ ...s.primaryBtn, opacity: busy || isDefault ? 0.5 : 1 }}>
          {isDefault ? 'Already the client default' : 'Apply to everyone at this client'}
        </button>
        {selected.size > 0 && (
          <button onClick={() => assign(Array.from(selected))} disabled={busy} style={s.ghostBtn}>
            Apply to {selected.size} selected
          </button>
        )}
      </div>

      {loading ? (
        <p style={s.muted}>Loading roster…</p>
      ) : (
        <div style={s.tableWrap}>
          <table style={s.table}>
            <thead>
              <tr>
                <th style={{ ...s.th, width: 34 }}>
                  <input
                    type="checkbox"
                    checked={roster.length > 0 && selected.size === roster.length}
                    onChange={() => setSelected(selected.size === roster.length ? new Set() : new Set(roster.map(e => e.id)))}
                  />
                </th>
                {['Employee', 'Band', 'Routes through'].map(h => <th key={h} style={s.th}>{h}</th>)}
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
                        checked={selected.has(emp.id)}
                        onChange={() => setSelected(prev => {
                          const next = new Set(prev)
                          if (next.has(emp.id)) next.delete(emp.id); else next.add(emp.id)
                          return next
                        })}
                      />
                    </td>
                    <td style={s.td}>
                      <div style={s.empName}>{emp.full_name}</div>
                      <div style={s.empEmail}>{emp.email}</div>
                    </td>
                    <td style={s.td}>
                      {emp.band_code ? <span style={s.bandBadge}>{emp.band_code}</span> : <span style={s.muted}>—</span>}
                    </td>
                    <td style={s.td}>
                      {assigned === templateId
                        ? <span style={s.onThis}>This chain</span>
                        : assigned
                          ? <span style={s.muted}>Another chain</span>
                          : defaults[category]
                            ? <span style={s.muted}>Client default</span>
                            : <span style={s.noRoute}>No approval</span>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  root: { fontFamily: "'Inter', -apple-system, sans-serif", paddingBottom: 60 },
  pageHeader: { marginBottom: 20 },
  heading: { fontSize: 22, fontWeight: 700, color: '#0A0A14', margin: '0 0 4px', letterSpacing: '-0.4px' },
  sub: { fontSize: 13, color: '#6B7280', margin: 0 },

  modeRow: { display: 'inline-flex', border: '1px solid #D1D5DB', borderRadius: 9, overflow: 'hidden', background: '#fff', marginBottom: 10 },
  modeBtn: { padding: '9px 18px', background: 'transparent', border: 'none', fontSize: 13, color: '#6B7280', cursor: 'pointer' },
  modeActive: { background: '#000835', color: '#fff', fontWeight: 600 },
  modeHint: { fontSize: 12, color: '#9CA3AF', margin: '0 0 20px', lineHeight: 1.6 },

  errorBanner: { display: 'flex', alignItems: 'center', gap: 8, background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8, padding: '10px 14px', fontSize: 12, color: '#DC2626', marginBottom: 16 },
  successBanner: { display: 'flex', alignItems: 'center', gap: 8, background: '#ECFDF5', border: '1px solid #A7F3D0', borderRadius: 8, padding: '10px 14px', fontSize: 12, color: '#065F46', marginBottom: 16 },
  noteBanner: { background: '#F5F7FF', border: '1px solid #C7D2FE', borderRadius: 8, padding: '12px 14px', fontSize: 12, color: '#000835', marginBottom: 16, lineHeight: 1.6 },
  inlineWarn: { fontSize: 11, color: '#92400E', margin: '10px 0 0' },
  icon: { fontSize: 14, flexShrink: 0 },
  bannerClose: { marginLeft: 'auto', background: 'transparent', border: 'none', color: '#DC2626', cursor: 'pointer', fontSize: 13 },

  card: { background: '#fff', border: '1px solid #E5E7EB', borderRadius: 12, padding: 20, marginBottom: 16 },
  sectionTitle: { fontSize: 13, fontWeight: 600, color: '#111827', margin: '0 0 12px' },
  cardMeta: { fontSize: 11, color: '#9CA3AF', margin: 0 },

  form: { display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' },
  filterRow: { display: 'flex', gap: 16, marginBottom: 18, flexWrap: 'wrap' },
  field: { display: 'flex', flexDirection: 'column', gap: 6 },
  label: { fontSize: 11, fontWeight: 600, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.6px' },
  input: { height: 38, padding: '0 10px', fontSize: 13, color: '#111827', background: '#fff', border: '1px solid #D1D5DB', borderRadius: 7, outline: 'none' },
  ghostBtn: { height: 34, padding: '0 14px', background: '#fff', color: '#374151', fontSize: 12, fontWeight: 500, border: '1px solid #D1D5DB', borderRadius: 7, cursor: 'pointer', whiteSpace: 'nowrap' },
  primaryBtn: { height: 36, padding: '0 18px', background: '#000835', color: '#fff', fontSize: 13, fontWeight: 600, border: 'none', borderRadius: 7, cursor: 'pointer', whiteSpace: 'nowrap' },
  deleteBtn: { background: 'transparent', border: 'none', color: '#9CA3AF', cursor: 'pointer', fontSize: 12, padding: '0 2px', flexShrink: 0 },

  empty: { padding: '24px 0', textAlign: 'center' },
  emptyTitle: { fontSize: 13, fontWeight: 600, color: '#374151', margin: '0 0 4px' },
  emptyDesc: { fontSize: 12, color: '#9CA3AF', margin: 0 },
  muted: { fontSize: 12, color: '#9CA3AF', margin: 0 },
  hint: { fontSize: 11, color: '#9CA3AF' },

  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: 12 },
  chainCard: { border: '1.5px solid', borderRadius: 10, padding: '14px 16px', cursor: 'pointer' },
  cardTop: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 },
  chainName: { fontSize: 13, fontWeight: 600, color: '#111827', flex: 1 },
  tagRow: { display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 },
  catBadge: { display: 'inline-block', padding: '2px 7px', background: '#F0FDF4', color: '#14532D', fontSize: 10, fontWeight: 600, borderRadius: 4 },
  stepBadge: { display: 'inline-block', padding: '2px 7px', background: '#F3F4F6', color: '#4B5563', fontSize: 10, fontWeight: 600, borderRadius: 4 },
  bandBadge: { display: 'inline-block', padding: '2px 7px', background: '#EEF2FF', color: '#3730A3', fontSize: 10, fontWeight: 700, borderRadius: 4 },

  editor: { marginBottom: 20 },
  editorTop: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, gap: 16 },
  editorActions: { display: 'flex', alignItems: 'center', gap: 10 },
  unsaved: { fontSize: 11, fontWeight: 500, color: '#92400E', background: '#FEF3C7', border: '1px solid #FDE68A', borderRadius: 4, padding: '3px 8px' },

  toggleRow: { display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 14 },
  toggle: { display: 'inline-flex', border: '1px solid #D1D5DB', borderRadius: 8, overflow: 'hidden', background: '#fff' },
  toggleBtn: { padding: '7px 14px', background: 'transparent', border: 'none', fontSize: 12, color: '#6B7280', cursor: 'pointer' },
  toggleActive: { background: '#000835', color: '#fff', fontWeight: 600 },

  stepRow: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 },
  stepNum: { fontSize: 11, fontWeight: 700, color: '#3730A3', background: '#EEF2FF', borderRadius: 4, padding: '4px 8px', minWidth: 54, textAlign: 'center' },

  appliesTo: { borderTop: '1px solid #E5E7EB', paddingTop: 18, marginTop: 6 },
  applyRow: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 14 },

  tableWrap: { overflowX: 'auto' },
  table: { borderCollapse: 'collapse', width: '100%' },
  th: { padding: '8px 12px', textAlign: 'left', background: '#F9FAFB', borderBottom: '1px solid #E5E7EB', whiteSpace: 'nowrap', fontSize: 11, fontWeight: 600, color: '#374151' },
  td: { padding: '8px 12px', borderBottom: '1px solid #F3F4F6', fontSize: 12, verticalAlign: 'middle' },
  empName: { fontSize: 13, fontWeight: 500, color: '#111827' },
  empEmail: { fontSize: 11, color: '#9CA3AF' },
  onThis: { fontSize: 11, fontWeight: 600, color: '#065F46', background: '#ECFDF5', borderRadius: 4, padding: '2px 8px' },
  noRoute: { fontSize: 11, fontWeight: 600, color: '#92400E', background: '#FEF3C7', borderRadius: 4, padding: '2px 8px' },
}
