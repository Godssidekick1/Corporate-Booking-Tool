'use client'

import { useEffect, useState } from 'react'
import SearchableSelect from '@/app/components/SearchableSelect'
import Pagination from '@/app/components/Pagination'
import { SkeletonTable } from '@/app/components/Skeleton'
import { usePagedList } from '@/app/hooks/usePagedList'
import { formatFlightSpec } from '@/app/lib/deal-codes/flightSpec'
import { STATUS_LABELS, type DealCodeStatus } from '@/app/lib/deal-codes/dealCodeStatus'

// ── /tmc/configurations/deal-codes ───────────────────────────────────────────
// Negotiated airline codes: tour codes, private fares, deal, tracking and
// promotion codes.
//
// The screen this replaces puts the corporate code on the deal row, which is
// what forces one-at-a-time assignment. Here a deal knows its airline, code and
// validity; who it reaches is a separate list on the same panel, so assigning
// twelve clients or one whole bucket is one action.
//
// NOTHING HERE IS TRANSMITTED. The aggregator API has no field for a tour code
// or an account code — searchFlights takes neither and addPassenger carries only
// Discount — so a resolved code is recorded on the booking for manual GDS entry
// and reconciliation. No copy on this page may imply otherwise.
// ─────────────────────────────────────────────────────────────────────────────

interface Category { id: string; code: string; label: string; allowedTypes: string[] }
interface DealCode {
  id: string
  category_id: string
  categoryCode: string | null
  airline_code: string
  code: string
  code_type: string
  flight_spec: string | null
  sales_from: string | null
  sales_to: string | null
  travel_from: string | null
  travel_to: string | null
  active: boolean
  notes: string | null
  status: DealCodeStatus
  targetCount: number
}
interface Assignment { id: string; kind: string; targetId: string; targetName: string }
interface Named { id: string; name: string }
// Coverage is the OUTCOME of resolution, not a definition: one row per client
// per airline per type, carrying only the winner. It deliberately shares no
// columns with the master beside it — category, flight and the date windows
// describe a deal, not what a client ends up with, and having both tables show
// them is what made the two tabs read as the same screen.
interface Coverage {
  clientId: string
  clientName: string
  airline: string
  codeType: string
  code: string
  via: string
  ambiguous: boolean
  beat: { code: string; via: string }[]
}
interface Verdict { row: number; code: string; valid: boolean; error?: string }

const CODE_TYPES = [
  { value: 'TC', label: 'TC — Tour code' },
  { value: 'PF', label: 'PF — Private fare' },
  { value: 'DC', label: 'DC — Deal code' },
  { value: 'TR', label: 'TR — Tracking code' },
  { value: 'PC', label: 'PC — Promotion code' },
]

const STATUS_STYLE: Record<DealCodeStatus, React.CSSProperties> = {
  active:       { background: '#ECFDF5', color: '#065F46', borderColor: '#A7F3D0' },
  scheduled:    { background: '#FEF3C7', color: '#92400E', borderColor: '#FDE68A' },
  sales_closed: { background: '#FEF2F2', color: '#DC2626', borderColor: '#FECACA' },
  expired:      { background: '#F3F4F6', color: '#6B7280', borderColor: '#E5E7EB' },
  inactive:     { background: '#F3F4F6', color: '#6B7280', borderColor: '#E5E7EB' },
}

const EMPTY_FORM = {
  category_id: '', airline_code: '', code: '', code_type: 'TC',
  flight_spec: '', sales_from: '', sales_to: '', travel_from: '', travel_to: '',
  active: true, notes: '',
}

export default function DealCodesPage() {
  const [tab, setTab] = useState<'codes' | 'coverage'>('codes')

  const [categories, setCategories] = useState<Category[]>([])

  const [filterCategory, setFilterCategory] = useState('')
  const [filterType, setFilterType] = useState('')
  const [filterStatus, setFilterStatus] = useState('')

  // Both tabs are server-paged and server-searched. The hook owns the request
  // sequencing, so a slow response for an earlier keystroke cannot overwrite a
  // newer one — which is the bug the previous hand-rolled version had.
  const codes = usePagedList<DealCode>('/api/tmc/deal-codes', {
    params: { categoryId: filterCategory, type: filterType, status: filterStatus },
    enabled: tab === 'codes',
  })

  const coverage = usePagedList<Coverage>('/api/tmc/deal-codes/effective', {
    enabled: tab === 'coverage',
  })

  const [selected, setSelected] = useState<DealCode | null>(null)
  const [creating, setCreating] = useState(false)
  const [form, setForm] = useState(EMPTY_FORM)
  const [assignments, setAssignments] = useState<Assignment[]>([])

  const [clients, setClients] = useState<Named[]>([])
  const [groups, setGroups] = useState<Named[]>([])
  const [buckets, setBuckets] = useState<Named[]>([])
  const [assignKind, setAssignKind] = useState<'client' | 'client_group' | 'bucket'>('client')
  const [assignTarget, setAssignTarget] = useState('')

  const [importOpen, setImportOpen] = useState(false)
  const [importRows, setImportRows] = useState<Record<string, string>[]>([])
  const [verdicts, setVerdicts] = useState<Verdict[]>([])
  const [importFile, setImportFile] = useState('')

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

  const category = categories.find(c => c.id === form.category_id)
  const allowedTypes = category?.allowedTypes ?? CODE_TYPES.map(t => t.value)

  function openNew() {
    setSelected(null)
    setCreating(true)
    setAssignments([])
    setForm({ ...EMPTY_FORM, category_id: categories[0]?.id ?? '' })
    setError(''); setSuccess('')
  }

  async function openDeal(deal: DealCode) {
    setCreating(false)
    setSelected(deal)
    setError(''); setSuccess('')
    setForm({
      category_id: deal.category_id,
      airline_code: deal.airline_code,
      code: deal.code,
      code_type: deal.code_type,
      flight_spec: deal.flight_spec ?? '',
      sales_from: deal.sales_from ?? '',
      sales_to: deal.sales_to ?? '',
      travel_from: deal.travel_from ?? '',
      travel_to: deal.travel_to ?? '',
      active: deal.active,
      notes: deal.notes ?? '',
    })
    const d = await fetch(`/api/tmc/deal-codes/${deal.id}`).then(r => r.json())
    if (d.ok) setAssignments(d.assignments)
  }

  function closePanel() {
    setSelected(null)
    setCreating(false)
  }

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
        ...form,
        flight_spec: form.flight_spec || null,
        sales_from: form.sales_from || null,
        sales_to: form.sales_to || null,
        travel_from: form.travel_from || null,
        travel_to: form.travel_to || null,
        notes: form.notes || null,
      }
      const res = creating
        ? await fetch('/api/tmc/deal-codes', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          })
        : await fetch(`/api/tmc/deal-codes/${selected!.id}`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          })
      const d = await res.json()
      if (!d.ok) { setError(d.error || 'Could not save.'); return }
      setSuccess(creating ? 'Deal code created.' : 'Deal code saved.')
      closePanel()
      codes.refetch()
    } finally { setBusy(false) }
  }

  async function remove() {
    if (!selected) return
    if (!confirm(`Delete "${selected.code}"?`)) return
    setBusy(true); setError('')
    try {
      const d = await fetch(`/api/tmc/deal-codes/${selected.id}`, { method: 'DELETE' }).then(r => r.json())
      if (!d.ok) { setError(d.error || 'Could not delete.'); return }
      closePanel()
      codes.refetch()
    } finally { setBusy(false) }
  }

  async function addAssignment() {
    if (!assignTarget || !selected) return
    setBusy(true); setError('')
    try {
      const d = await fetch('/api/tmc/deal-code-assignments', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dealCodeId: selected.id, targets: [{ kind: assignKind, id: assignTarget }] }),
      }).then(r => r.json())
      if (!d.ok) { setError(d.error || 'Could not assign.'); return }
      setAssignTarget('')
      const refreshed = await fetch(`/api/tmc/deal-codes/${selected.id}`).then(r => r.json())
      if (refreshed.ok) setAssignments(refreshed.assignments)
      codes.refetch()
    } finally { setBusy(false) }
  }

  async function removeAssignment(id: string) {
    setBusy(true)
    try {
      await fetch(`/api/tmc/deal-code-assignments?id=${id}`, { method: 'DELETE' })
      setAssignments(prev => prev.filter(a => a.id !== id))
      codes.refetch()
    } finally { setBusy(false) }
  }

  // ── CSV ────────────────────────────────────────────────────────────────────
  // Parsed in the browser only far enough to build rows; every validation rule
  // lives on the server, and the preview calls the same endpoint with dryRun so
  // the preview and the commit can never disagree.
  function parseCsv(text: string): Record<string, string>[] {
    const lines = text.split(/\r?\n/).filter(l => l.trim())
    if (lines.length < 2) return []
    const headers = lines[0].split(',').map(h => h.trim())
    return lines.slice(1).map(line => {
      const cells: string[] = []
      let current = ''
      let inQuotes = false
      for (let i = 0; i < line.length; i++) {
        const ch = line[i]
        if (ch === '"') {
          if (inQuotes && line[i + 1] === '"') { current += '"'; i++ }
          else inQuotes = !inQuotes
        } else if (ch === ',' && !inQuotes) { cells.push(current); current = '' }
        else current += ch
      }
      cells.push(current)
      return Object.fromEntries(headers.map((h, i) => [h, (cells[i] ?? '').trim()]))
    })
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setImportFile(file.name)
    const rows = parseCsv(await file.text())
    setImportRows(rows)
    const d = await fetch('/api/tmc/deal-codes/csv', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rows, dryRun: true }),
    }).then(r => r.json())
    if (d.ok) setVerdicts(d.verdicts)
    else setError(d.error || 'Could not read that file.')
  }

  async function commitImport() {
    setBusy(true)
    try {
      const d = await fetch('/api/tmc/deal-codes/csv', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows: importRows }),
      }).then(r => r.json())
      if (!d.ok) { setError(d.error || 'Import failed.'); return }
      setSuccess(`Imported ${d.imported} deal code${d.imported === 1 ? '' : 's'}.`)
      setImportOpen(false); setImportRows([]); setVerdicts([]); setImportFile('')
      codes.refetch()
    } finally { setBusy(false) }
  }

  const accepted = verdicts.filter(v => v.valid).length
  const rejected = verdicts.length - accepted

  const panelOpen = creating || !!selected

  return (
    <div style={s.root}>
      <div style={s.header}>
        <div>
          <h1 style={s.title}>Deal codes</h1>
          <p style={s.sub}>
            Negotiated codes across every airline you hold an agreement with. Codes are recorded
            here and stamped on bookings for manual GDS entry — nothing is sent to the airline.
          </p>
        </div>
        <div style={s.actions}>
          <button onClick={() => setImportOpen(true)} style={s.ghostBtn}>Import CSV</button>
          {/* A real anchor, not a Link: this is an API route that streams a
              file with Content-Disposition, so client-side routing would
              navigate to it rather than download it. Kept as an anchor rather
              than a scripted download so right-click and open-in-new-tab work. */}
          <a href="/api/tmc/deal-codes/csv" download style={{ ...s.ghostBtn, textDecoration: 'none', lineHeight: '30px' }}>Export</a>
          <button onClick={openNew} style={s.primaryBtn}>New deal code</button>
        </div>
      </div>

      <div style={s.tabs}>
        <button onClick={() => setTab('codes')} style={{ ...s.tab, ...(tab === 'codes' ? s.tabOn : {}) }}>
          Deal codes {codes.total > 0 && <span style={s.tabCount}>{codes.total}</span>}
        </button>
        <button onClick={() => setTab('coverage')} style={{ ...s.tab, ...(tab === 'coverage' ? s.tabOn : {}) }}>
          Coverage {coverage.total > 0 && <span style={s.tabCount}>{coverage.total}</span>}
        </button>
      </div>

      {error && <div style={s.errorBanner}>{error}</div>}
      {success && <div style={s.successBanner}>{success}</div>}

      {tab === 'codes' && (
        <>
          <div style={s.filters}>
            <input
              value={codes.search} onChange={e => codes.setSearch(e.target.value)}
              placeholder="Search code or airline" style={{ ...s.input, flex: 2, minWidth: 180 }}
            />
            <select value={filterCategory} onChange={e => setFilterCategory(e.target.value)} style={{ ...s.input, flex: 1 }}>
              <option value="">Category: All</option>
              {categories.map(c => <option key={c.id} value={c.id}>{c.code}</option>)}
            </select>
            <select value={filterType} onChange={e => setFilterType(e.target.value)} style={{ ...s.input, flex: 1 }}>
              <option value="">Type: All</option>
              {CODE_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
            <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} style={{ ...s.input, flex: 1 }}>
              <option value="">Status: All</option>
              {(Object.keys(STATUS_LABELS) as DealCodeStatus[]).map(k => (
                <option key={k} value={k}>{STATUS_LABELS[k]}</option>
              ))}
            </select>
          </div>

          {/* Three loading states, deliberately different. Skeleton on first
              paint, because there is nothing on screen to keep. Dimmed table on
              every refetch after that — collapsing a rendered table to a
              skeleton on each keystroke reads as the page breaking. */}
          {codes.loading ? (
            <SkeletonTable rows={10} cols={9} />
          ) : codes.items.length === 0 ? (
            <div style={s.empty}>
              <p style={s.emptyTitle}>
                {codes.search ? 'No deal codes match that search' : 'No deal codes yet'}
              </p>
              <p style={s.emptyDesc}>
                {codes.search
                  ? 'Search covers every deal code, not just this page — so nothing here matches.'
                  : 'Add one, or import a spreadsheet from an airline. Until a code is assigned to a client it is recorded but reaches nobody.'}
              </p>
            </div>
          ) : (
            <div style={{ ...s.tableWrap, ...(codes.refreshing ? s.dimmed : {}) }}>
              <table style={s.table}>
                <thead>
                  <tr>
                    {['Code', 'Type', 'Airline', 'Category', 'Flight', 'Sales window', 'Travel window', 'Status', 'Reaches'].map(h => (
                      <th key={h} style={s.th}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {codes.items.map((d, i) => (
                    <tr
                      key={d.id}
                      onClick={() => openDeal(d)}
                      style={{ ...s.tr, background: i % 2 === 0 ? '#fff' : '#FAFAFA', cursor: 'pointer' }}
                    >
                      <td style={s.td}><span style={s.code}>{d.code}</span></td>
                      <td style={s.td}><span style={s.typePill}>{d.code_type}</span></td>
                      <td style={{ ...s.td, ...s.mono }}>{d.airline_code}</td>
                      <td style={{ ...s.td, fontSize: 12, color: '#6B7280' }}>{d.categoryCode ?? '—'}</td>
                      <td style={{ ...s.td, fontSize: 12 }}>{formatFlightSpec(d.flight_spec)}</td>
                      <td style={{ ...s.td, ...s.dates }}>{window_(d.sales_from, d.sales_to)}</td>
                      <td style={{ ...s.td, ...s.dates }}>{window_(d.travel_from, d.travel_to)}</td>
                      <td style={s.td}>
                        <span style={{ ...s.statusPill, ...STATUS_STYLE[d.status] }}>
                          <span style={{ ...s.dot, background: 'currentColor' }} />
                          {STATUS_LABELS[d.status]}
                        </span>
                      </td>
                      <td style={{ ...s.td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                        {d.targetCount === 0
                          ? <span style={{ color: '#9CA3AF' }}>—</span>
                          : d.targetCount}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <Pagination
            page={codes.page} pageSize={10} total={codes.total}
            onPageChange={codes.setPage} busy={codes.refreshing} noun="deal codes"
          />
        </>
      )}

      {tab === 'coverage' && (
        <>
          <p style={s.tabIntro}>
            What each client actually ends up with. One row per client per airline per type,
            showing the winner and what it beat — the outcome of resolution, not the deals that
            fed it.
          </p>

          <div style={s.filters}>
            <input
              value={coverage.search} onChange={e => coverage.setSearch(e.target.value)}
              placeholder="Search client, bucket, group, code or airline"
              style={{ ...s.input, flex: 1, minWidth: 260, maxWidth: 420 }}
            />
          </div>

          {coverage.loading ? (
            <SkeletonTable rows={10} cols={6} />
          ) : coverage.items.length === 0 ? (
            <div style={s.empty}>
              <p style={s.emptyTitle}>
                {coverage.search ? 'Nothing matches that search' : 'No codes resolve for anyone yet'}
              </p>
              <p style={s.emptyDesc}>
                {coverage.search
                  ? 'Coverage is searched across every client, so nothing anywhere matches.'
                  : 'Either no deal code is assigned to a client, or every assigned code is outside its sales or travel window today.'}
              </p>
            </div>
          ) : (
            <>
              <div style={{ ...s.tableWrap, ...(coverage.refreshing ? s.dimmed : {}) }}>
                <table style={s.table}>
                  <thead>
                    <tr>
                      {['Client', 'Airline', 'Type', 'Code', 'Via', 'Beat'].map(h => (
                        <th key={h} style={s.th}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {coverage.items.map((e, i) => (
                      <tr
                        key={`${e.clientId}-${e.airline}-${e.codeType}`}
                        style={{ ...s.tr, background: i % 2 === 0 ? '#fff' : '#FAFAFA' }}
                      >
                        <td style={{ ...s.td, fontWeight: 500, color: 'var(--color-ink)' }}>{e.clientName}</td>
                        <td style={{ ...s.td, ...s.mono }}>{e.airline}</td>
                        <td style={s.td}><span style={s.typePill}>{e.codeType}</span></td>
                        <td style={s.td}>
                          <span style={s.code}>{e.code}</span>
                          {e.ambiguous && <span style={s.conflict}>Ambiguous</span>}
                        </td>
                        <td style={{ ...s.td, fontSize: 12 }}>{e.via}</td>
                        <td style={{ ...s.td, fontSize: 12, color: '#9CA3AF' }}>
                          {e.beat.length === 0
                            ? '—'
                            : e.beat.map(b => `${b.code} (${b.via})`).join(', ')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <Pagination
                page={coverage.page} pageSize={10} total={coverage.total}
                onPageChange={coverage.setPage} busy={coverage.refreshing} noun="resolved codes"
              />

              <p style={s.footnote}>
                One winner per airline per type — a private fare, a tour code and a tracking code
                can all apply to the same booking. Direct assignment beats a bucket, which beats a
                client group. <strong>Beat</strong> names the codes that also reached that client
                but lost.
              </p>
            </>
          )}
        </>
      )}

      {/* ── Editor slide-over ─────────────────────────────────────────────── */}
      {panelOpen && (
        <>
          <div onClick={closePanel} style={s.backdrop} />
          <div style={s.panel}>
            <div style={s.panelHead}>
              <h2 style={s.panelTitle}>{creating ? 'New deal code' : 'Edit deal code'}</h2>
              <button onClick={closePanel} style={s.ghostBtn}>Close</button>
            </div>

            <div style={s.panelBody}>
              <div style={s.sectionLabel}>Identity</div>

              <div style={s.field}>
                <label style={s.label}>Airline category</label>
                <select
                  value={form.category_id}
                  onChange={e => setForm(f => ({ ...f, category_id: e.target.value }))}
                  style={s.input}
                >
                  <option value="">Select a category…</option>
                  {categories.map(c => <option key={c.id} value={c.id}>{c.code} — {c.label}</option>)}
                </select>
              </div>

              <div style={s.row}>
                <div style={{ ...s.field, flex: 1 }}>
                  <label style={s.label}>Airline</label>
                  {/* Free text, not a picker: there is no airline reference list in
                      this codebase — carrier names come back from Amadeus on each
                      search — and a hardcoded list would go stale silently. */}
                  <input
                    value={form.airline_code}
                    onChange={e => setForm(f => ({ ...f, airline_code: e.target.value.toUpperCase() }))}
                    maxLength={2} placeholder="AI" style={{ ...s.input, ...s.mono }}
                  />
                </div>
                <div style={{ ...s.field, flex: 2 }}>
                  <label style={s.label}>Code</label>
                  <input
                    value={form.code}
                    onChange={e => setForm(f => ({ ...f, code: e.target.value.toUpperCase() }))}
                    placeholder="IN25AI0042" style={{ ...s.input, ...s.mono }}
                  />
                </div>
              </div>

              <div style={s.field}>
                <label style={s.label}>Type</label>
                <select
                  value={form.code_type}
                  onChange={e => setForm(f => ({ ...f, code_type: e.target.value }))}
                  style={s.input}
                >
                  {CODE_TYPES.map(t => (
                    <option key={t.value} value={t.value} disabled={!allowedTypes.includes(t.value)}>
                      {t.label}{allowedTypes.includes(t.value) ? '' : ` — not available for ${category?.code ?? 'this category'}`}
                    </option>
                  ))}
                </select>
                {category && !allowedTypes.includes(form.code_type) && (
                  <p style={s.hintWarn}>
                    {category.code} content has no field for this code type. Pick another, or change
                    the category.
                  </p>
                )}
              </div>

              <div style={s.sectionLabel}>Restrictions</div>
              <div style={s.field}>
                <label style={s.label}>Flight numbers</label>
                <input
                  value={form.flight_spec}
                  onChange={e => setForm(f => ({ ...f, flight_spec: e.target.value }))}
                  placeholder="Any flight" style={s.input}
                />
                <p style={s.hint}>
                  Leave blank for every flight. One number (2134), a list (138, 139), or a range
                  (800-899). A carrier prefix is allowed and checked against the airline above.
                </p>
              </div>

              <div style={s.sectionLabel}>Validity</div>
              <p style={s.hint}>
                Sales is when the deal may be booked; travel is when the passenger may fly. They
                are usually different — &ldquo;book by 31 Mar, travel by 31 Dec&rdquo;.
              </p>
              <div style={s.row}>
                <div style={{ ...s.field, flex: 1 }}>
                  <label style={s.label}>Sales from</label>
                  <input type="date" value={form.sales_from}
                    onChange={e => setForm(f => ({ ...f, sales_from: e.target.value }))} style={s.input} />
                </div>
                <div style={{ ...s.field, flex: 1 }}>
                  <label style={s.label}>Sales to</label>
                  <input type="date" value={form.sales_to}
                    onChange={e => setForm(f => ({ ...f, sales_to: e.target.value }))} style={s.input} />
                </div>
              </div>
              <div style={s.row}>
                <div style={{ ...s.field, flex: 1 }}>
                  <label style={s.label}>Travel from</label>
                  <input type="date" value={form.travel_from}
                    onChange={e => setForm(f => ({ ...f, travel_from: e.target.value }))} style={s.input} />
                </div>
                <div style={{ ...s.field, flex: 1 }}>
                  <label style={s.label}>Travel to</label>
                  <input type="date" value={form.travel_to}
                    onChange={e => setForm(f => ({ ...f, travel_to: e.target.value }))} style={s.input} />
                </div>
              </div>

              <div style={s.sectionLabel}>Status</div>
              <label style={s.checkRow}>
                <input type="checkbox" checked={form.active}
                  onChange={e => setForm(f => ({ ...f, active: e.target.checked }))} />
                <span>Active</span>
              </label>
              <p style={s.hint}>
                Turning this off stops the code applying without deleting it or its assignments.
                The status shown in the list also accounts for both date windows.
              </p>

              <div style={s.field}>
                <label style={s.label}>Notes</label>
                <input value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                  placeholder="Contract reference, who negotiated it" style={s.input} />
              </div>

              {/* Assignment lives on the deal so the common case — create it,
                  give it to somebody — is one panel rather than two screens. */}
              {!creating && (
                <>
                  <div style={s.sectionLabel}>Reaches</div>
                  {assignments.length === 0 ? (
                    <p style={s.hint}>Not assigned to anyone yet, so this code currently applies to no booking.</p>
                  ) : (
                    <div style={s.chipRow}>
                      {assignments.map(a => (
                        <span key={a.id} style={s.assignChip}>
                          <strong style={{ fontWeight: 600 }}>{a.targetName}</strong>
                          <span style={{ color: '#6B7280' }}>
                            {a.kind === 'client' ? 'Client' : a.kind === 'bucket' ? 'Bucket' : 'Group'}
                          </span>
                          <button onClick={() => removeAssignment(a.id)} style={s.chipX} title="Remove">×</button>
                        </span>
                      ))}
                    </div>
                  )}

                  <div style={{ ...s.row, marginTop: 10 }}>
                    <select
                      value={assignKind}
                      onChange={e => { setAssignKind(e.target.value as typeof assignKind); setAssignTarget('') }}
                      style={{ ...s.input, flex: 1 }}
                    >
                      <option value="client">Client</option>
                      <option value="bucket">Bucket</option>
                      <option value="client_group">Client group</option>
                    </select>
                    <div style={{ flex: 2 }}>
                      <SearchableSelect
                        value={assignTarget}
                        onChange={setAssignTarget}
                        options={(assignKind === 'client' ? clients : assignKind === 'bucket' ? buckets : groups)
                          .map(o => ({ id: o.id, label: o.name }))}
                        placeholder="Search…"
                        emptyMessage="No matches"
                      />
                    </div>
                    <button onClick={addAssignment} disabled={!assignTarget || busy} style={{ ...s.primaryBtn, opacity: !assignTarget || busy ? 0.5 : 1 }}>
                      Add
                    </button>
                  </div>
                </>
              )}
            </div>

            <div style={s.panelFoot}>
              <button onClick={save} disabled={busy} style={{ ...s.primaryBtn, opacity: busy ? 0.5 : 1 }}>
                {busy ? 'Saving…' : 'Save'}
              </button>
              {!creating && <button onClick={remove} disabled={busy} style={s.dangerBtn}>Delete</button>}
            </div>
          </div>
        </>
      )}

      {/* ── Import ────────────────────────────────────────────────────────── */}
      {importOpen && (
        <>
          <div onClick={() => setImportOpen(false)} style={s.backdrop} />
          <div style={s.modal}>
            <div style={s.panelHead}>
              <h2 style={s.panelTitle}>Import deal codes</h2>
              <button onClick={() => setImportOpen(false)} style={s.ghostBtn}>Close</button>
            </div>

            <div style={s.panelBody}>
              <p style={s.hint}>
                The export is the template — download it, edit in a spreadsheet, upload it back.
                Columns must match exactly.
              </p>

              <div style={s.field}>
                <label style={s.label}>CSV file</label>
                <input type="file" accept=".csv,text/csv" onChange={onFile} style={s.input} />
                {importFile && <p style={s.hint}>{importFile}</p>}
              </div>

              {verdicts.length > 0 && (
                <>
                  <div style={s.chipRow}>
                    <span style={{ ...s.statusPill, ...STATUS_STYLE.active }}>{accepted} accepted</span>
                    {rejected > 0 && (
                      <span style={{ ...s.statusPill, ...STATUS_STYLE.sales_closed }}>{rejected} rejected</span>
                    )}
                  </div>

                  <div style={{ ...s.tableWrap, marginTop: 10, maxHeight: 280, overflowY: 'auto' }}>
                    <table style={s.table}>
                      <thead>
                        <tr>{['Row', 'Code', 'Result'].map(h => <th key={h} style={s.th}>{h}</th>)}</tr>
                      </thead>
                      <tbody>
                        {verdicts.map(v => (
                          <tr key={v.row} style={{ ...s.tr, background: v.valid ? '#fff' : '#FEF2F2' }}>
                            <td style={{ ...s.td, ...s.mono, fontSize: 12 }}>{v.row}</td>
                            <td style={s.td}><span style={s.code}>{v.code || '—'}</span></td>
                            <td style={{ ...s.td, fontSize: 12, color: v.valid ? '#065F46' : '#DC2626' }}>
                              {v.valid ? 'Valid' : v.error}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  <p style={s.hint}>Rejected rows are skipped. Nothing is written until you confirm.</p>
                </>
              )}
            </div>

            <div style={s.panelFoot}>
              <button
                onClick={commitImport}
                disabled={busy || accepted === 0}
                style={{ ...s.primaryBtn, opacity: busy || accepted === 0 ? 0.5 : 1 }}
              >
                {busy ? 'Importing…' : `Import ${accepted} row${accepted === 1 ? '' : 's'}`}
              </button>
              <button onClick={() => setImportOpen(false)} style={s.ghostBtn}>Cancel</button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function window_(from: string | null, to: string | null): string {
  if (!from && !to) return 'Any'
  const fmt = (d: string | null) => (d ? d.slice(0, 10) : '—')
  return `${fmt(from)} → ${fmt(to)}`
}

const s: Record<string, React.CSSProperties> = {
  root: { paddingBottom: 60 },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap', marginBottom: 16 },
  title: { fontSize: 20, fontWeight: 600, color: 'var(--color-ink)', margin: '0 0 4px', letterSpacing: '-0.3px' },
  sub: { fontSize: 13, color: 'var(--color-secondary)', margin: 0, lineHeight: 1.6, maxWidth: 620 },
  actions: { display: 'flex', gap: 8, flexWrap: 'wrap' },

  tabs: { display: 'flex', gap: 20, borderBottom: '1px solid var(--color-line)', marginBottom: 18 },
  tab: { background: 'none', border: 'none', padding: '0 0 9px', fontSize: 13, color: 'var(--color-secondary)', cursor: 'pointer' },
  tabOn: { color: 'var(--color-ink)', fontWeight: 600, boxShadow: 'inset 0 -2px 0 var(--color-rail)' },
  tabCount: { marginLeft: 6, fontSize: 11, color: 'var(--color-secondary)', background: '#F3F4F6', borderRadius: 10, padding: '1px 7px' },

  filters: { display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' },
  tabIntro: { fontSize: 12.5, color: 'var(--color-secondary)', lineHeight: 1.6, margin: '0 0 14px', maxWidth: 680 },
  // Refetch state: the table stays exactly where it is and fades slightly, so a
  // search feels like the rows updating rather than the page rebuilding.
  dimmed: { opacity: 0.55, transition: 'opacity 120ms ease' },
  field: { display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 14 },
  row: { display: 'flex', gap: 10, alignItems: 'flex-end' },
  label: { fontSize: 11, fontWeight: 600, color: 'var(--color-secondary)', textTransform: 'uppercase', letterSpacing: '0.5px' },
  input: { height: 36, padding: '0 10px', fontSize: 13, color: '#111827', background: '#fff', border: '1px solid var(--color-line-strong)', borderRadius: 7, outline: 'none' },
  checkRow: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--color-body)', marginBottom: 6 },

  sectionLabel: { fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.11em', textTransform: 'uppercase', color: 'var(--color-secondary)', margin: '18px 0 10px', paddingBottom: 5, borderBottom: '1px solid var(--color-line)' },

  tableWrap: { background: '#fff', border: '1px solid var(--color-line)', borderRadius: 10, overflowX: 'auto' },
  table: { borderCollapse: 'collapse', width: '100%' },
  th: { padding: '10px 14px', textAlign: 'left', background: '#F9FAFB', borderBottom: '1px solid var(--color-line)', fontSize: 11, fontWeight: 600, color: '#374151', whiteSpace: 'nowrap' },
  tr: { borderBottom: '1px solid #F3F4F6' },
  td: { padding: '9px 14px', fontSize: 13, color: 'var(--color-body)', verticalAlign: 'middle', whiteSpace: 'nowrap' },
  mono: { fontFamily: 'var(--font-mono)' },
  dates: { fontSize: 12, fontVariantNumeric: 'tabular-nums', color: 'var(--color-secondary)' },
  code: { fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 600, color: '#111827', background: '#F3F4F6', borderRadius: 4, padding: '2px 7px' },
  typePill: { fontSize: 11, fontWeight: 700, color: '#3730A3', background: '#EEF2FF', borderRadius: 4, padding: '2px 6px' },
  statusPill: { display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 600, borderRadius: 999, padding: '2px 9px', border: '1px solid transparent' },
  dot: { width: 5, height: 5, borderRadius: '50%', flexShrink: 0 },
  conflict: { marginLeft: 6, fontSize: 10, fontWeight: 700, color: '#92400E', background: '#FEF3C7', borderRadius: 4, padding: '1px 5px' },

  muted: { fontSize: 13, color: 'var(--color-secondary)' },
  hint: { fontSize: 12, color: 'var(--color-secondary)', lineHeight: 1.55, margin: '4px 0 0' },
  hintWarn: { fontSize: 12, color: '#92400E', lineHeight: 1.55, margin: '4px 0 0' },
  footnote: { fontSize: 12, color: 'var(--color-secondary)', marginTop: 10, lineHeight: 1.6 },

  empty: { background: '#fff', border: '1px dashed var(--color-line-strong)', borderRadius: 10, padding: '28px 22px', textAlign: 'center' },
  emptyTitle: { fontSize: 14, fontWeight: 600, color: 'var(--color-ink)', margin: '0 0 5px' },
  emptyDesc: { fontSize: 12, color: 'var(--color-secondary)', margin: 0, lineHeight: 1.6 },

  errorBanner: { background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8, padding: '10px 14px', fontSize: 12, color: '#DC2626', marginBottom: 14 },
  successBanner: { background: '#ECFDF5', border: '1px solid #A7F3D0', borderRadius: 8, padding: '10px 14px', fontSize: 12, color: '#065F46', marginBottom: 14 },

  chipRow: { display: 'flex', gap: 6, flexWrap: 'wrap' },
  assignChip: { display: 'inline-flex', alignItems: 'center', gap: 7, background: '#fff', border: '1px solid var(--color-line-strong)', borderRadius: 6, padding: '4px 8px', fontSize: 12 },
  chipX: { background: 'none', border: 'none', color: '#9CA3AF', fontSize: 15, lineHeight: 1, cursor: 'pointer', padding: 0 },

  backdrop: { position: 'fixed', inset: 0, background: 'rgba(10,10,20,0.28)', zIndex: 40 },
  panel: { position: 'fixed', top: 0, right: 0, bottom: 0, width: 'min(560px, 92vw)', background: '#fff', zIndex: 41, display: 'flex', flexDirection: 'column', boxShadow: '-8px 0 32px rgba(0,8,53,0.12)' },
  modal: { position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', width: 'min(720px, 94vw)', maxHeight: '86vh', background: '#fff', borderRadius: 12, zIndex: 41, display: 'flex', flexDirection: 'column', boxShadow: '0 24px 64px rgba(0,8,53,0.22)' },
  panelHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 20px', borderBottom: '1px solid var(--color-line)' },
  panelTitle: { fontSize: 15, fontWeight: 600, color: 'var(--color-ink)', margin: 0 },
  panelBody: { flex: 1, overflowY: 'auto', padding: '16px 20px' },
  panelFoot: { display: 'flex', gap: 8, padding: '14px 20px', borderTop: '1px solid var(--color-line)' },

  primaryBtn: { height: 32, padding: '0 14px', background: 'var(--color-rail)', color: '#fff', fontSize: 12, fontWeight: 600, border: 'none', borderRadius: 6, cursor: 'pointer' },
  ghostBtn: { height: 30, padding: '0 11px', background: '#fff', color: '#374151', fontSize: 12, border: '1px solid var(--color-line-strong)', borderRadius: 6, cursor: 'pointer' },
  dangerBtn: { height: 32, padding: '0 12px', background: '#fff', color: '#DC2626', fontSize: 12, border: '1px solid #FECACA', borderRadius: 6, cursor: 'pointer' },
}
