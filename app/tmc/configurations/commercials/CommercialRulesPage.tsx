'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import SearchableSelect from '@/app/components/SearchableSelect'
import AirlineDropdown from '@/app/components/AirlineDropdown'
import Pagination from '@/app/components/Pagination'
import Tabs, { useUrlTab } from '@/app/components/Tabs'
import { SkeletonTable } from '@/app/components/Skeleton'
import { usePagedList } from '@/app/hooks/usePagedList'
import {
  CALC_ON_BY_KIND, CALC_ON_LABELS, CALC_TYPES, CABINS, CABIN_LABELS,
  FARE_TYPES, FARE_TYPE_LABELS, CALC_BASES, CALC_BASIS_LABELS,
  KIND_LABELS, KIND_EFFECTS, CALC_ON_NEEDS_TAX_LINES,
  type CommercialKind, type CalcOn,
} from '@/app/lib/commercials/calcOnByKind'
import { COMMERCIAL_STATUS_LABELS, type CommercialStatus } from '@/app/lib/commercials/commercialStatus'

// ── Markup · Discounts · Processing fees ─────────────────────────────────────
// ONE SCREEN, three routes. The nav lists them separately because they are three
// different jobs to a desk — what do we add, what do we give back, what do we
// charge for handling — but they share a table, a resolver and this component,
// because they compose in a fixed order into a single sell price.
//
// `kind` drives the title, which calculation bases are offered, and whether the
// fee-only fields render. Nothing else differs.
//
// WHAT A TC HAS TO UNDERSTAND FROM THIS SCREEN, and what the copy is for:
// a markup is invisible to the traveller, a discount is not, and a discount
// comes out of the TMC's own margin because the airline does not fund it. None
// of that is guessable from a form, so it is written on the form.
// ─────────────────────────────────────────────────────────────────────────────

interface Rule {
  id: string
  kind: CommercialKind
  category_id: string
  categoryCode: string | null
  categoryLabel: string | null
  airline_code: string | null
  cabin: string | null
  rbd_spec: string | null
  fare_type: string
  calc_type: string
  calc_on: string
  rate: number
  calc_basis: string | null
  exclude_tax_codes: string[] | null
  include_ssr: boolean | null
  active: boolean
  valid_from: string | null
  valid_to: string | null
  notes: string | null
  status: CommercialStatus
  targetCount: number
}

interface Coverage {
  clientId: string
  clientName: string
  markup: string | null
  markupVia: string | null
  discount: string | null
  discountVia: string | null
  fee: string | null
  feeVia: string | null
  netPercent: number | null
  lossMaking: boolean
  ambiguous: boolean
  switchedOff: CommercialKind[]
  // Optional so a cached response from before this existed still renders.
  variesByCategory?: CommercialKind[]
}

// A cell says one of three things, and they are genuinely different:
//   a rate        — a rule reaches them and is in force
//   switched off  — a rule may well reach them, but the client has this kind
//                   turned off on their Controls tab, so nothing is applied
//   no rule       — nothing of this kind reaches this client at all
//
// It used to say "—" for both of the last two, which is how "why isn't my
// discount applying?" becomes a search through the rules master for a rule that
// was never the problem.
function coverageCell(rate: string | null, off: boolean): { text: string; muted: boolean } {
  if (off) return { text: 'switched off', muted: true }
  if (!rate) return { text: 'no rule', muted: true }
  return { text: rate, muted: false }
}

interface Category { id: string; code: string; label: string }
interface Named { id: string; name: string }
interface Assignment { id: string; kind: string; targetId: string; targetName: string; via: string }

const STATUS_STYLE: Record<CommercialStatus, React.CSSProperties> = {
  active:    { background: '#ECFDF5', color: '#065F46', borderColor: '#A7F3D0' },
  scheduled: { background: '#FEF3C7', color: '#92400E', borderColor: '#FDE68A' },
  expired:   { background: '#F3F4F6', color: '#6B7280', borderColor: '#E5E7EB' },
  inactive:  { background: '#F3F4F6', color: '#6B7280', borderColor: '#E5E7EB' },
}

const TABS = ['rules', 'coverage'] as const
type Tab = typeof TABS[number]

function emptyForm(kind: CommercialKind) {
  return {
    category_id: '',
    airline_code: '',
    cabin: '',
    rbd_spec: '',
    fare_type: 'all',
    calc_type: 'percent',
    calc_on: CALC_ON_BY_KIND[kind][0] as string,
    rate: '',
    calc_basis: 'per_transaction',
    exclude_tax_codes: '',
    include_ssr: false,
    valid_from: '',
    valid_to: '',
    active: true,
    notes: '',
  }
}

export default function CommercialRulesPage({ kind }: { kind: CommercialKind }) {
  const [tab, setTab] = useUrlTab<Tab>('tab', 'rules', TABS)

  const [filterCategory, setFilterCategory] = useState('')
  const [filterStatus, setFilterStatus] = useState('')

  const rules = usePagedList<Rule>('/api/tmc/commercial-rules', {
    params: { kind, categoryId: filterCategory, status: filterStatus },
    enabled: tab === 'rules',
  })

  const coverage = usePagedList<Coverage>('/api/tmc/commercial-rules/effective', {
    params: { kind },
    enabled: tab === 'coverage',
  })

  const [categories, setCategories] = useState<Category[]>([])
  const [clients, setClients] = useState<Named[]>([])
  const [groups, setGroups] = useState<Named[]>([])
  const [buckets, setBuckets] = useState<Named[]>([])

  const [selected, setSelected] = useState<Rule | null>(null)
  const [creating, setCreating] = useState(false)
  const [form, setForm] = useState(emptyForm(kind))
  const [assignments, setAssignments] = useState<Assignment[]>([])

  const [assignKind, setAssignKind] = useState<'client' | 'client_group' | 'bucket'>('client')
  const [assignTarget, setAssignTarget] = useState('')

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  useEffect(() => {
    Promise.all([
      fetch('/api/tmc/deal-code-categories').then(r => r.json()),
      fetch('/api/tmc/clients').then(r => r.json()),
      fetch('/api/tmc/client-groups').then(r => r.json()),
      fetch('/api/tmc/buckets').then(r => r.json()),
    ]).then(([cats, cl, gr, bk]) => {
      if (cats.ok) setCategories(cats.categories)
      if (cl.ok) setClients(cl.items ?? [])
      if (gr.ok) setGroups(gr.items ?? [])
      if (bk.ok) setBuckets(bk.items ?? [])
    })
  }, [])

  const isFee = kind === 'processing_fee'
  const calcOnOptions = CALC_ON_BY_KIND[kind]

  function openNew() {
    setSelected(null)
    setCreating(true)
    setAssignments([])
    setForm({ ...emptyForm(kind), category_id: categories[0]?.id ?? '' })
    setError(''); setSuccess('')
  }

  async function openRule(rule: Rule) {
    setCreating(false)
    setSelected(rule)
    setError(''); setSuccess('')
    setForm({
      category_id: rule.category_id,
      airline_code: rule.airline_code ?? '',
      cabin: rule.cabin ?? '',
      rbd_spec: rule.rbd_spec ?? '',
      fare_type: rule.fare_type,
      calc_type: rule.calc_type,
      calc_on: rule.calc_on,
      rate: String(rule.rate),
      calc_basis: rule.calc_basis ?? 'per_transaction',
      exclude_tax_codes: (rule.exclude_tax_codes ?? []).join(', '),
      include_ssr: rule.include_ssr ?? false,
      valid_from: rule.valid_from ?? '',
      valid_to: rule.valid_to ?? '',
      active: rule.active,
      notes: rule.notes ?? '',
    })
    const d = await fetch(`/api/tmc/commercial-rules/${rule.id}`).then(r => r.json())
    if (d.ok) setAssignments(d.assignments)
  }

  function closePanel() { setSelected(null); setCreating(false) }

  useEffect(() => {
    if (!selected && !creating) return
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') closePanel() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selected, creating])

  async function save() {
    setBusy(true); setError('')
    try {
      const payload = {
        kind,
        category_id: form.category_id,
        airline_code: form.airline_code || null,
        cabin: form.cabin || null,
        rbd_spec: form.rbd_spec || null,
        fare_type: form.fare_type,
        calc_type: form.calc_type,
        calc_on: form.calc_on,
        rate: Number(form.rate),
        valid_from: form.valid_from || null,
        valid_to: form.valid_to || null,
        active: form.active,
        notes: form.notes || null,
        // Only sent for a fee. The database refuses these on the other two kinds,
        // so sending them would be a constraint violation rather than a
        // silently-ignored field.
        ...(isFee ? {
          calc_basis: form.calc_basis,
          exclude_tax_codes: form.exclude_tax_codes
            .split(',').map(s => s.trim().toUpperCase()).filter(Boolean),
          include_ssr: form.include_ssr,
        } : {}),
      }

      const res = selected
        ? await fetch(`/api/tmc/commercial-rules/${selected.id}`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          })
        : await fetch('/api/tmc/commercial-rules', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          })

      const d = await res.json()
      if (!res.ok) { setError(d.error || 'Could not save.'); return }

      setSuccess('Saved.')
      rules.refetch()
      if (!selected) { setCreating(false); openRule(d.rule) }
    } finally { setBusy(false) }
  }

  async function remove() {
    if (!selected) return
    if (!confirm(`Delete this ${KIND_LABELS[kind].toLowerCase()}? Everything it reaches stops being charged it.`)) return
    await fetch(`/api/tmc/commercial-rules/${selected.id}`, { method: 'DELETE' })
    closePanel()
    rules.refetch()
  }

  async function addAssignment() {
    if (!selected || !assignTarget) return
    setBusy(true); setError('')
    try {
      const res = await fetch('/api/tmc/commercial-rule-assignments', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ruleId: selected.id, targets: [{ kind: assignKind, id: assignTarget }] }),
      })
      const d = await res.json()
      if (!res.ok) { setError(d.error || 'Could not assign.'); return }
      setAssignTarget('')
      const fresh = await fetch(`/api/tmc/commercial-rules/${selected.id}`).then(r => r.json())
      if (fresh.ok) setAssignments(fresh.assignments)
      rules.refetch()
    } finally { setBusy(false) }
  }

  async function removeAssignment(id: string) {
    setAssignments(prev => prev.filter(a => a.id !== id))
    await fetch(`/api/tmc/commercial-rule-assignments?id=${id}`, { method: 'DELETE' })
    rules.refetch()
  }

  const targetOptions = (assignKind === 'client' ? clients : assignKind === 'bucket' ? buckets : groups)
    .map(t => ({ id: t.id, label: t.name }))

  const needsTaxLines = CALC_ON_NEEDS_TAX_LINES.includes(form.calc_on as CalcOn)

  return (
    <div style={s.root}>
      <div style={s.header}>
        <div>
          <h1 style={s.title}>{KIND_LABELS[kind]}</h1>
          <p style={s.sub}>{KIND_EFFECTS[kind]}</p>
        </div>
        <button onClick={openNew} style={s.primaryBtn}>New {KIND_LABELS[kind].toLowerCase()}</button>
      </div>

      <Tabs<Tab>
        active={tab}
        onChange={setTab}
        tabs={[
          { id: 'rules', label: KIND_LABELS[kind], count: rules.total || undefined },
          {
            id: 'coverage', label: 'Coverage', count: coverage.total || undefined,
            hint: 'What each client actually ends up with — the outcome of resolution, not the rules that fed it.',
          },
        ]}
      />

      {error && <div style={s.errorBanner}>{error}</div>}
      {success && <div style={s.successBanner}>{success}</div>}

      {tab === 'rules' && (
        <>
          <div style={s.filters}>
            <select value={filterCategory} onChange={e => setFilterCategory(e.target.value)} style={s.input}>
              <option value="">All categories</option>
              {categories.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
            <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} style={s.input}>
              <option value="">Any status</option>
              {Object.entries(COMMERCIAL_STATUS_LABELS).map(([k, label]) =>
                <option key={k} value={k}>{label}</option>)}
            </select>
            <input
              value={rules.search}
              onChange={e => rules.setSearch(e.target.value)}
              placeholder="Search airline or notes…"
              style={{ ...s.input, flex: 1, minWidth: 180 }}
            />
          </div>

          {rules.loading ? (
            <SkeletonTable rows={5} />
          ) : rules.error ? (
            <p style={s.errorBanner}><strong>Could not load.</strong> {rules.error}</p>
          ) : rules.items.length === 0 ? (
            <div style={s.empty}>
              <p style={s.emptyTitle}>No {KIND_LABELS[kind].toLowerCase()} rules yet</p>
              <p style={s.emptyDesc}>{KIND_EFFECTS[kind]}</p>
            </div>
          ) : (
            <div style={{ ...s.tableWrap, opacity: rules.refreshing ? 0.55 : 1 }}>
              <table style={s.table}>
                <thead>
                  <tr>
                    {['Rate', 'On', 'Category', 'Airline', 'Cabin', 'Class', 'Fare type',
                      ...(isFee ? ['Basis'] : []), 'Valid', 'Status', 'Reaches'].map(h =>
                      <th key={h} style={s.th}>{h}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {rules.items.map(r => (
                    <tr key={r.id} onClick={() => openRule(r)} style={s.row}>
                      <td style={{ ...s.td, ...s.mono }}>
                        {r.calc_type === 'percent' ? `${r.rate}%` : `₹${r.rate}`}
                      </td>
                      <td style={s.td}>{CALC_ON_LABELS[r.calc_on as CalcOn] ?? r.calc_on}</td>
                      <td style={s.td}>{r.categoryCode ?? '—'}</td>
                      <td style={{ ...s.td, ...s.mono }}>{r.airline_code ?? 'All'}</td>
                      <td style={s.td}>{r.cabin ? CABIN_LABELS[r.cabin as 'Y'] : 'All'}</td>
                      <td style={{ ...s.td, ...s.mono }}>{r.rbd_spec || 'Any'}</td>
                      <td style={s.td}>{FARE_TYPE_LABELS[r.fare_type as 'all']}</td>
                      {isFee && (
                        <td style={s.td}>{r.calc_basis === 'per_sector' ? 'Per sector' : 'Per transaction'}</td>
                      )}
                      <td style={s.td}>
                        {r.valid_from || r.valid_to
                          ? `${r.valid_from ?? '—'} → ${r.valid_to ?? 'open'}`
                          : 'Always'}
                      </td>
                      <td style={s.td}>
                        <span style={{ ...s.pill, ...STATUS_STYLE[r.status] }}>
                          {COMMERCIAL_STATUS_LABELS[r.status]}
                        </span>
                      </td>
                      {/* Zero reaches is a STATE TO FIX, not an absence. It
                          rendered as a dash, which reads like every other dash
                          in this table — "nothing to say here" — when it
                          actually means this rule is configured, active, valid,
                          and charging nobody anything. That is the single most
                          confusing thing a rules list can be silent about. */}
                      <td style={s.td}>
                        {r.targetCount
                          ? r.targetCount
                          : <span style={s.reachesNobody} title="This rule is not assigned to any client, bucket or client group, so it applies to nothing.">Nobody</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <Pagination
            page={rules.page} pageSize={10} total={rules.total}
            onPageChange={rules.setPage} busy={rules.refreshing}
            noun={KIND_LABELS[kind].toLowerCase() + ' rules'}
          />
        </>
      )}

      {tab === 'coverage' && (
        <>
          <input
            value={coverage.search}
            onChange={e => coverage.setSearch(e.target.value)}
            placeholder="Search clients…"
            style={{ ...s.input, width: 280, marginBottom: 14 }}
          />

          {coverage.loading ? (
            <SkeletonTable rows={5} />
          ) : coverage.items.length === 0 ? (
            <div style={s.empty}>
              <p style={s.emptyTitle}>Nothing reaches any client yet</p>
              <p style={s.emptyDesc}>Assign a rule to a client, a bucket or a client group and it will show here.</p>
            </div>
          ) : (
            <>
              {/* Surfaced above the table rather than only per row: a desk that
                  has to scroll to find out it is losing money will not find out. */}
              {Number(coverage.raw?.lossMakingCount ?? 0) > 0 && (
                <div style={s.warnBanner}>
                  <strong>{String(coverage.raw?.lossMakingCount)} client
                  {Number(coverage.raw?.lossMakingCount) === 1 ? '' : 's'} discounted below the markup.</strong>{' '}
                  The airline does not fund a discount — it comes out of your margin, so these fares
                  sell at a loss before the processing fee.
                </div>
              )}
              <div style={{ ...s.tableWrap, opacity: coverage.refreshing ? 0.55 : 1 }}>
                <table style={s.table}>
                  <thead>
                    <tr>
                      {['Client', 'Markup', 'Discount', 'Processing fee', 'Net'].map(h =>
                        <th key={h} style={s.th}>{h}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {coverage.items.map(c => (
                      <tr key={c.clientId}>
                        {/* Links to the client's Controls tab, not just to the
                            client. A rule can resolve correctly and still not
                            apply, because the kind is switched off for this
                            client — and until now this screen had no way to
                            reach that switch. AllocationsTab already links OUT
                            to the Markup/Discount/Processing fee screens; this
                            is the reverse of that link, which was missing, and
                            its absence is what turns "my discount isn't
                            applying" into a hunt. */}
                        <td style={s.td}>
                          <Link href={`/tmc/clients/${c.clientId}?tab=controls`} style={s.clientLink}>
                            {c.clientName}
                          </Link>
                          {c.ambiguous && <span style={{ ...s.pill, ...s.ambiguous, marginLeft: 6 }}>ambiguous</span>}
                        </td>
                        {([
                          ['markup', c.markup, c.markupVia],
                          ['discount', c.discount, c.discountVia],
                          ['processing_fee', c.fee, c.feeVia],
                        ] as const).map(([kind, rate, via]) => {
                          const off = (c.switchedOff ?? []).includes(kind)
                          const cell = coverageCell(rate, off)
                          return (
                            <td key={kind} style={{ ...s.td, ...(cell.muted ? s.mutedCell : {}) }}>
                              {cell.text}
                              {/* The route it reaches by is still worth showing
                                  when the kind is switched off — it says the
                                  arrangement survives the switch, so turning it
                                  back on does not mean rebuilding anything. */}
                              {via && <span style={s.via}>{via}</span>}
                              {/* More than one rule of this kind reaches the
                                  client under different categories. Resolution
                                  returns one winner per kind, and this view has
                                  no flight to decide between them — so the rate
                                  above is one of several, not the answer. Said
                                  out loud, because printing one of two rules
                                  with no qualifier is how a desk concludes the
                                  other was never saved. */}
                              {(c.variesByCategory ?? []).includes(kind) && (
                                <span
                                  style={s.varies}
                                  title="More than one rule of this kind reaches this client, filed under different categories. Which applies depends on the flight — domestic or international, BSP or LCC."
                                >
                                  varies by category
                                </span>
                              )}
                            </td>
                          )
                        })}
                        {/* Three states here too, for the same reason the rate
                            cells have three: a bare dash reads as "nothing is
                            configured", and for this column that is usually
                            wrong. A net percentage cannot be worked out when
                            either side is a FIXED amount — ₹500 against 5% needs
                            a fare — so those rows say "mixed" rather than
                            implying there is nothing to see. */}
                        <td style={{ ...s.td, ...s.mono, ...(c.lossMaking ? s.loss : {}) }}>
                          {c.netPercent !== null
                            ? `${c.netPercent > 0 ? '+' : ''}${c.netPercent}%`
                            : (c.markup || c.discount)
                              ? <span style={s.netMixed} title="One of these rules is a fixed amount, so the net depends on the fare and cannot be shown here.">mixed</span>
                              : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          <Pagination
            page={coverage.page} pageSize={10} total={coverage.total}
            onPageChange={coverage.setPage} busy={coverage.refreshing}
            noun="clients"
          />
        </>
      )}

      {(selected || creating) && (
        <>
          <div style={s.backdrop} onClick={closePanel} />
          <div style={s.panel}>
            <div style={s.panelHead}>
              <h2 style={s.panelTitle}>
                {creating ? `New ${KIND_LABELS[kind].toLowerCase()}` : `Edit ${KIND_LABELS[kind].toLowerCase()}`}
              </h2>
              <button onClick={closePanel} style={s.closeBtn}>✕</button>
            </div>

            <div style={s.panelBody}>
              <p style={s.sectionLabel}>Applies to</p>
              <div style={s.field}>
                <label style={s.label}>Category</label>
                <select value={form.category_id} onChange={e => setForm({ ...form, category_id: e.target.value })} style={s.input}>
                  <option value="">Select a category</option>
                  {categories.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
                </select>
                <span style={s.hint}>Domestic or international, BSP or LCC — derived from the booking and matched here.</span>
              </div>

              <div style={s.field}>
                <label style={s.label}>Airline</label>
                <AirlineDropdown value={form.airline_code} onChange={v => setForm({ ...form, airline_code: v })} />
                <span style={s.hint}>Leave blank for every airline.</span>
              </div>

              <div style={s.row2}>
                <div style={s.field}>
                  <label style={s.label}>Cabin</label>
                  <select value={form.cabin} onChange={e => setForm({ ...form, cabin: e.target.value })} style={s.input}>
                    <option value="">All cabins</option>
                    {CABINS.map(c => <option key={c} value={c}>{CABIN_LABELS[c]}</option>)}
                  </select>
                </div>
                <div style={s.field}>
                  <label style={s.label}>Booking class</label>
                  <input
                    value={form.rbd_spec}
                    onChange={e => setForm({ ...form, rbd_spec: e.target.value.toUpperCase() })}
                    placeholder="Any class" style={{ ...s.input, ...s.mono }}
                  />
                  <span style={s.hint}>A list, like &ldquo;Y, B, M&rdquo;. Not the cabin — one cabin holds many classes.</span>
                </div>
              </div>

              <div style={s.field}>
                <label style={s.label}>Fare type</label>
                <select value={form.fare_type} onChange={e => setForm({ ...form, fare_type: e.target.value })} style={s.input}>
                  {FARE_TYPES.map(f => <option key={f} value={f}>{FARE_TYPE_LABELS[f]}</option>)}
                </select>
              </div>

              <p style={s.sectionLabel}>Amount</p>
              <div style={s.row2}>
                <div style={s.field}>
                  <label style={s.label}>Calculation</label>
                  <select value={form.calc_type} onChange={e => setForm({ ...form, calc_type: e.target.value })} style={s.input}>
                    {CALC_TYPES.map(t => <option key={t} value={t}>{t === 'percent' ? 'Percentage' : 'Fixed amount'}</option>)}
                  </select>
                </div>
                <div style={s.field}>
                  <label style={s.label}>{form.calc_type === 'percent' ? 'Rate (%)' : 'Amount (₹)'}</label>
                  <input
                    value={form.rate}
                    onChange={e => setForm({ ...form, rate: e.target.value.replace(/[^0-9.]/g, '') })}
                    style={{ ...s.input, ...s.mono }}
                  />
                </div>
              </div>

              <div style={s.field}>
                <label style={s.label}>Calculated on</label>
                <select value={form.calc_on} onChange={e => setForm({ ...form, calc_on: e.target.value })} style={s.input}>
                  {calcOnOptions.map(c => <option key={c} value={c}>{CALC_ON_LABELS[c]}</option>)}
                </select>
                {needsTaxLines && (
                  // Honest rather than silent. YQ arrives as a tax line and the
                  // fuel surcharge arrives as a separate field, and whether the
                  // two overlap has not been confirmed against a live payload.
                  <span style={s.warnHint}>
                    Uses individual tax codes. Confirm against a real fare before relying on it —
                    YQ may or may not already be counted inside the other-taxes figure.
                  </span>
                )}
              </div>

              {isFee && (
                <>
                  <p style={s.sectionLabel}>How it is charged</p>
                  <div style={s.field}>
                    <label style={s.label}>Basis</label>
                    <select value={form.calc_basis} onChange={e => setForm({ ...form, calc_basis: e.target.value })} style={s.input}>
                      {CALC_BASES.map(b => <option key={b} value={b}>{CALC_BASIS_LABELS[b]}</option>)}
                    </select>
                    <span style={s.hint}>Passengers always multiply. This decides whether sectors do too.</span>
                  </div>
                  <div style={s.field}>
                    <label style={s.label}>Exclude taxes</label>
                    <input
                      value={form.exclude_tax_codes}
                      onChange={e => setForm({ ...form, exclude_tax_codes: e.target.value.toUpperCase() })}
                      placeholder="K3, YR" style={{ ...s.input, ...s.mono }}
                    />
                    <span style={s.hint}>Tax codes carved out of the basis, comma separated.</span>
                  </div>
                  <label style={s.checkRow}>
                    <input type="checkbox" checked={form.include_ssr}
                      onChange={e => setForm({ ...form, include_ssr: e.target.checked })} />
                    Include SSR charges in the basis
                  </label>
                </>
              )}

              <p style={s.sectionLabel}>Validity</p>
              <div style={s.row2}>
                <div style={s.field}>
                  <label style={s.label}>Valid from</label>
                  <input type="date" value={form.valid_from}
                    onChange={e => setForm({ ...form, valid_from: e.target.value })} style={s.input} />
                </div>
                <div style={s.field}>
                  <label style={s.label}>Valid to</label>
                  <input type="date" value={form.valid_to}
                    onChange={e => setForm({ ...form, valid_to: e.target.value })} style={s.input} />
                </div>
              </div>

              <label style={s.checkRow}>
                <input type="checkbox" checked={form.active}
                  onChange={e => setForm({ ...form, active: e.target.checked })} />
                Active
              </label>

              <div style={s.field}>
                <label style={s.label}>Notes</label>
                <input value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} style={s.input} />
              </div>

              <div style={s.btnRow}>
                <button onClick={save} disabled={busy} style={{ ...s.primaryBtn, opacity: busy ? 0.5 : 1 }}>
                  {busy ? 'Saving…' : 'Save'}
                </button>
                {selected && <button onClick={remove} style={s.dangerBtn}>Delete</button>}
              </div>

              {/* Assignment needs a rule id, so it only exists once saved. */}
              {!creating && selected && (
                <>
                  <p style={s.sectionLabel}>Reaches</p>
                  {assignments.length === 0 ? (
                    <p style={s.hint}>Not assigned to anyone — this rule currently changes no fare.</p>
                  ) : (
                    <div style={s.chipRow}>
                      {assignments.map(a => (
                        <span key={a.id} style={s.chip}>
                          {a.targetName}
                          <span style={s.chipVia}>{a.via}</span>
                          <button onClick={() => removeAssignment(a.id)} style={s.chipX}>×</button>
                        </span>
                      ))}
                    </div>
                  )}

                  <div style={{ ...s.row2, marginTop: 10 }}>
                    <select value={assignKind}
                      onChange={e => { setAssignKind(e.target.value as 'client'); setAssignTarget('') }}
                      style={s.input}>
                      <option value="client">A client</option>
                      <option value="bucket">A bucket</option>
                      <option value="client_group">A client group</option>
                    </select>
                    <SearchableSelect
                      value={assignTarget}
                      onChange={setAssignTarget}
                      options={targetOptions}
                      placeholder="Search…"
                      emptyMessage="No matches"
                    />
                  </div>
                  <button onClick={addAssignment} disabled={!assignTarget || busy}
                    style={{ ...s.primaryBtn, marginTop: 8, opacity: !assignTarget || busy ? 0.5 : 1 }}>
                    Add
                  </button>
                </>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  root: { paddingBottom: 60 },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap', marginBottom: 16 },
  title: { fontSize: 20, fontWeight: 600, color: '#0A0A14', margin: '0 0 4px', letterSpacing: '-0.3px' },
  sub: { fontSize: 13, color: '#6B7280', margin: 0, lineHeight: 1.6, maxWidth: 640 },

  filters: { display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' },
  input: { height: 36, padding: '0 10px', fontSize: 13, color: '#111827', background: '#fff', border: '1px solid #D1D5DB', borderRadius: 7, outline: 'none', boxSizing: 'border-box' },
  mono: { fontFamily: 'var(--font-mono)' },

  tableWrap: { border: '1px solid #E5E7EB', borderRadius: 8, overflowX: 'auto' },
  table: { borderCollapse: 'collapse', width: '100%', minWidth: 860 },
  th: { padding: '8px 10px', textAlign: 'left', background: '#F9FAFB', borderBottom: '1px solid #E5E7EB', fontSize: 10.5, fontWeight: 600, color: '#374151', whiteSpace: 'nowrap' },
  td: { padding: '9px 10px', fontSize: 12, color: '#374151', borderBottom: '1px solid #F3F4F6', whiteSpace: 'nowrap' },
  row: { cursor: 'pointer' },
  via: { display: 'block', fontSize: 10.5, color: '#9CA3AF' },
  clientLink: { color: '#000835', fontWeight: 600, textDecoration: 'none' },
  mutedCell: { color: '#9CA3AF' },
  loss: { color: '#DC2626', fontWeight: 600 },
  // Quieter than a rate, because it is the absence of an answer rather than an
  // answer. Carries a title so the reason is one hover away instead of a guess.
  netMixed: { color: '#9CA3AF', fontStyle: 'italic', cursor: 'help' },
  // Amber, not red: an unassigned rule is not broken, it is unfinished. Red is
  // reserved for the loss-making net, which is a live commercial problem.
  reachesNobody: { color: '#92400E', fontWeight: 600, cursor: 'help' },
  // Sits under the `via` line, quieter than the rate but not hidden — it
  // qualifies the number above it, so it has to be read with it.
  varies: { display: 'block', fontSize: 10.5, color: '#92400E', cursor: 'help', marginTop: 1 },

  pill: { display: 'inline-block', fontSize: 10, fontWeight: 600, borderRadius: 4, padding: '1px 6px', border: '1px solid' },
  ambiguous: { background: '#FEF3C7', color: '#92400E', borderColor: '#FDE68A' },

  empty: { background: '#fff', border: '1px dashed #D1D5DB', borderRadius: 10, padding: '22px 18px', textAlign: 'center' },
  emptyTitle: { fontSize: 13, fontWeight: 600, color: '#111827', margin: '0 0 5px' },
  emptyDesc: { fontSize: 12, color: '#6B7280', margin: 0, lineHeight: 1.6 },

  backdrop: { position: 'fixed', inset: 0, background: 'rgba(10,10,20,0.35)', zIndex: 40 },
  panel: { position: 'fixed', top: 0, right: 0, bottom: 0, width: 'min(560px, 92vw)', background: '#fff', borderLeft: '1px solid #E5E7EB', zIndex: 41, display: 'flex', flexDirection: 'column' },
  panelHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 18px', borderBottom: '1px solid #E5E7EB' },
  panelTitle: { fontSize: 15, fontWeight: 600, color: '#111827', margin: 0 },
  closeBtn: { background: 'none', border: 'none', fontSize: 15, color: '#6B7280', cursor: 'pointer' },
  panelBody: { padding: '16px 18px', overflowY: 'auto' },

  sectionLabel: { fontSize: 10, fontFamily: 'var(--font-mono)', letterSpacing: '0.11em', textTransform: 'uppercase', color: '#9CA3AF', margin: '20px 0 10px', paddingBottom: 5, borderBottom: '1px solid #F3F4F6' },
  field: { display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 12 },
  row2: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 },
  label: { fontSize: 11, fontWeight: 600, color: '#374151' },
  hint: { fontSize: 10.5, color: '#9CA3AF', lineHeight: 1.5 },
  warnHint: { fontSize: 10.5, color: '#92400E', lineHeight: 1.5, background: '#FFFBEB', border: '1px solid #FDE68A', borderRadius: 6, padding: '6px 8px' },
  checkRow: { display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5, color: '#374151', marginBottom: 12 },

  chipRow: { display: 'flex', gap: 6, flexWrap: 'wrap' },
  chip: { display: 'inline-flex', alignItems: 'center', gap: 7, background: '#fff', border: '1px solid #D1D5DB', borderRadius: 6, padding: '4px 9px', fontSize: 12, color: '#374151' },
  chipVia: { color: '#9CA3AF', fontSize: 10.5 },
  chipX: { background: 'none', border: 'none', color: '#9CA3AF', fontSize: 15, lineHeight: 1, cursor: 'pointer', padding: 0 },

  btnRow: { display: 'flex', gap: 8, marginTop: 8 },
  primaryBtn: { height: 34, padding: '0 14px', background: '#000835', color: '#fff', fontSize: 12.5, fontWeight: 600, border: 'none', borderRadius: 7, cursor: 'pointer' },
  dangerBtn: { height: 34, padding: '0 14px', background: '#fff', color: '#DC2626', fontSize: 12.5, border: '1px solid #FECACA', borderRadius: 7, cursor: 'pointer' },

  errorBanner: { background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8, padding: '10px 14px', fontSize: 12, color: '#DC2626', marginBottom: 14 },
  successBanner: { background: '#ECFDF5', border: '1px solid #A7F3D0', borderRadius: 8, padding: '10px 14px', fontSize: 12, color: '#065F46', marginBottom: 14 },
  warnBanner: { background: '#FFFBEB', border: '1px solid #FDE68A', borderRadius: 8, padding: '10px 14px', fontSize: 12, color: '#92400E', marginBottom: 14, lineHeight: 1.6 },
}
