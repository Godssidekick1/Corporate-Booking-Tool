'use client'

import { useEffect, useState } from 'react'
import SearchableSelect from '@/app/components/SearchableSelect'
import Pagination from '@/app/components/Pagination'
import { SkeletonTable } from '@/app/components/Skeleton'
import { usePagedList } from '@/app/hooks/usePagedList'
import { useLookup } from '@/app/hooks/useLookup'
import { formatRbdSpec } from '@/app/lib/fop/rbdSpec'
import { FOP_STATUS_LABELS, CARD_TYPE_LABELS, type FopStatus } from '@/app/lib/fop/fopStatus'

// ── /tmc/configurations/forms-of-payment ─────────────────────────────────────
// How a ticket gets paid for at issuance.
//
// TWO DIMENSIONS THE OLD SCREEN COLLAPSES INTO ONE "CARD TYPE" FIELD:
//   what kind of instrument (card or cash — cash meaning BSP settlement, which
//   airlines routinely require on discounted fares), and whose money it is
//   (the agency's, the client's, or the traveller's).
//
// NOTHING HERE IS TRANSMITTED. The aggregator does have a Payment slot, unlike
// deal codes which had nowhere to go at all — but its expected shape is
// undocumented, and a silently-ignored payment object looks exactly like a
// working one. The resolved method is recorded for settlement, and no copy on
// this page may suggest a card was charged.
// ─────────────────────────────────────────────────────────────────────────────

interface Fop {
  id: string
  label: string
  fop_type: 'card' | 'cash'
  payer: 'agency' | 'corporate' | 'traveller'
  card_type: string | null
  last4: string | null
  expiry_month: number | null
  expiry_year: number | null
  gds_alias: string | null
  branch_id: string | null
  owner_client_id: string | null
  owner_employee_id: string | null
  airline_code: string | null
  rbd_spec: string | null
  active: boolean
  notes: string | null
  status: FopStatus
  description: string
}

interface Assignment { id: string; kind: string; targetId: string; targetName: string }

const PAYER_LABELS: Record<Fop['payer'], string> = {
  agency: 'Agency',
  corporate: 'Corporate',
  traveller: 'Traveller',
}

// What each payer means commercially, shown in the editor because the choice
// has consequences that are not obvious from the word.
const PAYER_HINTS: Record<Fop['payer'], string> = {
  agency: 'Your card. You carry the float and the credit risk, and keep the rebate.',
  corporate: 'The client’s lodged card, charged directly. No float and no rebate for you.',
  traveller: 'The traveller pays and reclaims. Nothing to settle, but it moves to expenses.',
}

const STATUS_STYLE: Record<FopStatus, React.CSSProperties> = {
  active:   { background: '#ECFDF5', color: '#065F46', borderColor: '#A7F3D0' },
  expiring: { background: '#FEF3C7', color: '#92400E', borderColor: '#FDE68A' },
  expired:  { background: '#FEF2F2', color: '#DC2626', borderColor: '#FECACA' },
  inactive: { background: '#F3F4F6', color: '#6B7280', borderColor: '#E5E7EB' },
}

const EMPTY_FORM = {
  label: '', fop_type: 'card' as Fop['fop_type'], payer: 'agency' as Fop['payer'],
  card_type: 'AX', last4: '', expiry_month: '', expiry_year: '', gds_alias: '',
  branch_id: '', owner_client_id: '', owner_employee_id: '',
  airline_code: '', rbd_spec: '', active: true, notes: '',
}

export default function FormsOfPaymentPage() {
  const [filterType, setFilterType] = useState('')
  const [filterPayer, setFilterPayer] = useState('')
  const [filterStatus, setFilterStatus] = useState('')

  const list = usePagedList<Fop>('/api/tmc/forms-of-payment', {
    params: { type: filterType, payer: filterPayer, status: filterStatus },
  })

  const [selected, setSelected] = useState<Fop | null>(null)
  const [creating, setCreating] = useState(false)
  const [form, setForm] = useState(EMPTY_FORM)
  const [assignments, setAssignments] = useState<Assignment[]>([])

  const [assignKind, setAssignKind] = useState<'client' | 'client_group' | 'bucket'>('client')
  const [assignTarget, setAssignTarget] = useState('')

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  const branchLookup = useLookup('/api/tmc/branches', form.branch_id)
  const clientLookup = useLookup('/api/tmc/clients', form.owner_client_id)
  const assignLookup = useLookup(
    assignKind === 'client' ? '/api/tmc/clients'
      : assignKind === 'bucket' ? '/api/tmc/buckets'
      : '/api/tmc/client-groups',
    assignTarget
  )

  const panelOpen = creating || !!selected

  function openNew() {
    setSelected(null); setCreating(true); setAssignments([])
    setForm(EMPTY_FORM); setError(''); setSuccess('')
  }

  async function openFop(fop: Fop) {
    setCreating(false); setSelected(fop); setError(''); setSuccess('')
    setForm({
      label: fop.label,
      fop_type: fop.fop_type,
      payer: fop.payer,
      card_type: fop.card_type ?? 'AX',
      last4: fop.last4 ?? '',
      expiry_month: fop.expiry_month ? String(fop.expiry_month) : '',
      expiry_year: fop.expiry_year ? String(fop.expiry_year) : '',
      gds_alias: fop.gds_alias ?? '',
      branch_id: fop.branch_id ?? '',
      owner_client_id: fop.owner_client_id ?? '',
      owner_employee_id: fop.owner_employee_id ?? '',
      airline_code: fop.airline_code ?? '',
      rbd_spec: fop.rbd_spec ?? '',
      active: fop.active,
      notes: fop.notes ?? '',
    })
    const d = await fetch(`/api/tmc/forms-of-payment/${fop.id}`).then(r => r.json())
    if (d.ok) setAssignments(d.assignments)
  }

  function closePanel() { setSelected(null); setCreating(false) }

  useEffect(() => {
    if (!panelOpen) return
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') closePanel() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [panelOpen])

  async function save() {
    setBusy(true); setError('')
    try {
      // Card fields are sent only when this IS a card. The editor keeps them in
      // state while they are hidden — so switching to cash and saving used to
      // post card_type: 'AX' from the default, and the form showing no card
      // fields at all came back with "cash cannot carry card details".
      const isCardNow = form.fop_type === 'card'

      const payload = {
        ...form,
        card_type: isCardNow ? form.card_type : null,
        last4: isCardNow ? form.last4 || null : null,
        expiry_month: isCardNow && form.expiry_month ? Number(form.expiry_month) : null,
        expiry_year: isCardNow && form.expiry_year ? Number(form.expiry_year) : null,
        gds_alias: isCardNow ? form.gds_alias || null : null,
        branch_id: form.branch_id || null,
        owner_client_id: form.payer === 'corporate' ? form.owner_client_id || null : null,
        owner_employee_id: form.payer === 'traveller' ? form.owner_employee_id || null : null,
        airline_code: form.airline_code || null,
        rbd_spec: form.rbd_spec || null,
        notes: form.notes || null,
      }
      const res = creating
        ? await fetch('/api/tmc/forms-of-payment', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          })
        : await fetch(`/api/tmc/forms-of-payment/${selected!.id}`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          })
      const d = await res.json()
      if (!d.ok) { setError(d.error || 'Could not save.'); return }
      setSuccess(creating ? 'Payment method created.' : 'Saved.')
      closePanel()
      list.refetch()
    } finally { setBusy(false) }
  }

  async function remove() {
    if (!selected) return
    if (!confirm(`Delete "${selected.label}"?`)) return
    setBusy(true); setError('')
    try {
      const d = await fetch(`/api/tmc/forms-of-payment/${selected.id}`, { method: 'DELETE' }).then(r => r.json())
      if (!d.ok) { setError(d.error || 'Could not delete.'); return }
      closePanel()
      list.refetch()
    } finally { setBusy(false) }
  }

  async function addAssignment() {
    if (!assignTarget || !selected) return
    setBusy(true); setError('')
    try {
      const d = await fetch('/api/tmc/fop-assignments', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fopId: selected.id, targets: [{ kind: assignKind, id: assignTarget }] }),
      }).then(r => r.json())
      if (!d.ok) { setError(d.error || 'Could not assign.'); return }
      setAssignTarget('')
      const refreshed = await fetch(`/api/tmc/forms-of-payment/${selected.id}`).then(r => r.json())
      if (refreshed.ok) setAssignments(refreshed.assignments)
    } finally { setBusy(false) }
  }

  async function removeAssignment(id: string) {
    setBusy(true)
    try {
      await fetch(`/api/tmc/fop-assignments?id=${id}`, { method: 'DELETE' })
      setAssignments(prev => prev.filter(a => a.id !== id))
    } finally { setBusy(false) }
  }

  const isCard = form.fop_type === 'card'

  return (
    <div style={s.root}>
      <div style={s.header}>
        <div>
          <h1 style={s.title}>Forms of payment</h1>
          <p style={s.sub}>
            How a ticket is settled at issuance — the agency’s card, the client’s, the traveller’s,
            or cash through BSP. The resolved method is recorded on the booking for settlement; it
            is not sent to the airline.
          </p>
        </div>
        <button onClick={openNew} style={s.primaryBtn}>New payment method</button>
      </div>

      {error && <div style={s.errorBanner}>{error}</div>}
      {success && <div style={s.successBanner}>{success}</div>}

      <div style={s.filters}>
        <input
          value={list.search} onChange={e => list.setSearch(e.target.value)}
          placeholder="Search label, airline or last 4" style={{ ...s.input, flex: 2, minWidth: 200 }}
        />
        <select value={filterType} onChange={e => setFilterType(e.target.value)} style={{ ...s.input, flex: 1 }}>
          <option value="">Type: All</option>
          <option value="card">Card</option>
          <option value="cash">Cash / BSP</option>
        </select>
        <select value={filterPayer} onChange={e => setFilterPayer(e.target.value)} style={{ ...s.input, flex: 1 }}>
          <option value="">Payer: All</option>
          {(Object.keys(PAYER_LABELS) as Fop['payer'][]).map(p => (
            <option key={p} value={p}>{PAYER_LABELS[p]}</option>
          ))}
        </select>
        <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} style={{ ...s.input, flex: 1 }}>
          <option value="">Status: All</option>
          {(Object.keys(FOP_STATUS_LABELS) as FopStatus[]).map(k => (
            <option key={k} value={k}>{FOP_STATUS_LABELS[k]}</option>
          ))}
        </select>
      </div>

      {list.loading ? (
        <SkeletonTable rows={10} cols={7} />
      ) : list.items.length === 0 ? (
        <div style={s.empty}>
          <p style={s.emptyTitle}>
            {list.search ? 'Nothing matches that search' : 'No payment methods yet'}
          </p>
          <p style={s.emptyDesc}>
            {list.search
              ? 'Search covers every payment method, not just this page.'
              : 'Add one. A method with no client assigned becomes the default for everyone in its scope — which is what you want for the card you settle most bookings on.'}
          </p>
        </div>
      ) : (
        <>
          <div style={{ ...s.tableWrap, ...(list.refreshing ? s.dimmed : {}) }}>
            <table style={s.table}>
              <thead>
                <tr>
                  {['Label', 'Instrument', 'Payer', 'Airline', 'Classes', 'Branch', 'Status'].map(h => (
                    <th key={h} style={s.th}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {list.items.map((f, i) => (
                  <tr
                    key={f.id}
                    onClick={() => openFop(f)}
                    style={{ ...s.tr, background: i % 2 === 0 ? '#fff' : '#FAFAFA', cursor: 'pointer' }}
                  >
                    <td style={{ ...s.td, fontWeight: 500, color: 'var(--color-ink)' }}>{f.label}</td>
                    <td style={{ ...s.td, fontSize: 12 }}>{f.description}</td>
                    <td style={s.td}><span style={s.payerPill}>{PAYER_LABELS[f.payer]}</span></td>
                    <td style={{ ...s.td, ...s.mono }}>{f.airline_code ?? <span style={s.muted}>Any</span>}</td>
                    <td style={{ ...s.td, fontSize: 12 }}>{formatRbdSpec(f.rbd_spec)}</td>
                    <td style={{ ...s.td, fontSize: 12 }}>
                      {f.branch_id ? 'Branch-specific' : <span style={s.muted}>All branches</span>}
                    </td>
                    <td style={s.td}>
                      <span style={{ ...s.statusPill, ...STATUS_STYLE[f.status] }}>
                        <span style={{ ...s.dot, background: 'currentColor' }} />
                        {FOP_STATUS_LABELS[f.status]}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <Pagination
            page={list.page} pageSize={10} total={list.total}
            onPageChange={list.setPage} busy={list.refreshing} noun="payment methods"
          />
        </>
      )}

      {/* ── Editor ────────────────────────────────────────────────────────── */}
      {panelOpen && (
        <>
          <div onClick={closePanel} style={s.backdrop} />
          <div style={s.panel}>
            <div style={s.panelHead}>
              <h2 style={s.panelTitle}>{creating ? 'New payment method' : 'Edit payment method'}</h2>
              <button onClick={closePanel} style={s.ghostBtn}>Close</button>
            </div>

            <div style={s.panelBody}>
              <div style={s.sectionLabel}>Identity</div>

              <div style={s.field}>
                <label style={s.label}>Label</label>
                <input
                  value={form.label} onChange={e => setForm(f => ({ ...f, label: e.target.value }))}
                  placeholder="Amex BTA — Delhi" style={s.input}
                />
                <p style={s.hint}>What a counsellor will recognise it by.</p>
              </div>

              <div style={s.row}>
                <div style={{ ...s.field, flex: 1 }}>
                  <label style={s.label}>Instrument</label>
                  <select
                    value={form.fop_type}
                    onChange={e => setForm(f => ({ ...f, fop_type: e.target.value as Fop['fop_type'] }))}
                    style={s.input}
                  >
                    <option value="card">Card</option>
                    <option value="cash">Cash / BSP settlement</option>
                  </select>
                </div>
                <div style={{ ...s.field, flex: 1 }}>
                  <label style={s.label}>Payer</label>
                  <select
                    value={form.payer}
                    onChange={e => setForm(f => ({ ...f, payer: e.target.value as Fop['payer'] }))}
                    style={s.input}
                  >
                    {(Object.keys(PAYER_LABELS) as Fop['payer'][]).map(p => (
                      <option key={p} value={p}>{PAYER_LABELS[p]}</option>
                    ))}
                  </select>
                </div>
              </div>
              <p style={s.hint}>{PAYER_HINTS[form.payer]}</p>

              {form.payer === 'corporate' && (
                <div style={{ ...s.field, marginTop: 12 }}>
                  <label style={s.label}>Card belongs to</label>
                  <SearchableSelect
                    value={form.owner_client_id}
                    onChange={id => setForm(f => ({ ...f, owner_client_id: id }))}
                    options={clientLookup.options}
                    onSearch={clientLookup.onSearch}
                    loading={clientLookup.loading}
                    selectedLabel={clientLookup.selectedLabel}
                    placeholder="Search clients…"
                    emptyMessage="No clients match"
                  />
                  <p style={s.hint}>
                    Only this client’s own people will ever see it.
                  </p>
                </div>
              )}

              {isCard && (
                <>
                  <div style={s.sectionLabel}>Card details</div>
                  <div style={s.row}>
                    <div style={{ ...s.field, flex: 1 }}>
                      <label style={s.label}>Card type</label>
                      <select
                        value={form.card_type}
                        onChange={e => setForm(f => ({ ...f, card_type: e.target.value }))}
                        style={s.input}
                      >
                        {Object.entries(CARD_TYPE_LABELS).map(([code, name]) => (
                          <option key={code} value={code}>{code} — {name}</option>
                        ))}
                      </select>
                    </div>
                    <div style={{ ...s.field, flex: 1 }}>
                      <label style={s.label}>Last 4 digits</label>
                      <input
                        value={form.last4}
                        onChange={e => setForm(f => ({ ...f, last4: e.target.value.replace(/\D/g, '').slice(0, 4) }))}
                        placeholder="4003" inputMode="numeric" style={{ ...s.input, ...s.mono }}
                      />
                    </div>
                  </div>
                  <p style={s.hintWarn}>
                    Last four only. Full card numbers are never stored here — the card itself stays
                    in your GDS profile.
                  </p>

                  <div style={{ ...s.row, marginTop: 12 }}>
                    <div style={{ ...s.field, flex: 1 }}>
                      <label style={s.label}>Expiry month</label>
                      <input
                        value={form.expiry_month}
                        onChange={e => setForm(f => ({ ...f, expiry_month: e.target.value.replace(/\D/g, '').slice(0, 2) }))}
                        placeholder="09" inputMode="numeric" style={{ ...s.input, ...s.mono }}
                      />
                    </div>
                    <div style={{ ...s.field, flex: 1 }}>
                      <label style={s.label}>Expiry year</label>
                      <input
                        value={form.expiry_year}
                        onChange={e => setForm(f => ({ ...f, expiry_year: e.target.value.replace(/\D/g, '').slice(0, 4) }))}
                        placeholder="2027" inputMode="numeric" style={{ ...s.input, ...s.mono }}
                      />
                    </div>
                  </div>

                  <div style={s.field}>
                    <label style={s.label}>GDS alias</label>
                    <input
                      value={form.gds_alias}
                      onChange={e => setForm(f => ({ ...f, gds_alias: e.target.value }))}
                      placeholder="The lodged card's reference in your GDS profile" style={s.input}
                    />
                  </div>
                </>
              )}

              <div style={s.sectionLabel}>Applies to</div>

              <div style={s.field}>
                <label style={s.label}>Branch</label>
                <SearchableSelect
                  value={form.branch_id}
                  onChange={id => setForm(f => ({ ...f, branch_id: id }))}
                  options={branchLookup.options}
                  onSearch={branchLookup.onSearch}
                  loading={branchLookup.loading}
                  selectedLabel={branchLookup.selectedLabel}
                  placeholder="All branches"
                  emptyMessage="No branches match"
                />
                <p style={s.hint}>
                  Leave blank for every branch. A branch-specific method beats a TMC-wide one.
                </p>
              </div>

              <div style={s.row}>
                <div style={{ ...s.field, flex: 1 }}>
                  <label style={s.label}>Airline</label>
                  <input
                    value={form.airline_code}
                    onChange={e => setForm(f => ({ ...f, airline_code: e.target.value.toUpperCase() }))}
                    maxLength={2} placeholder="Any" style={{ ...s.input, ...s.mono }}
                  />
                </div>
                <div style={{ ...s.field, flex: 2 }}>
                  <label style={s.label}>Booking classes</label>
                  <input
                    value={form.rbd_spec}
                    onChange={e => setForm(f => ({ ...f, rbd_spec: e.target.value.toUpperCase() }))}
                    placeholder="Any class" style={s.input}
                  />
                </div>
              </div>
              <p style={s.hint}>
                Single letters, comma separated — &ldquo;Y, B, M&rdquo;. Blank means any class. Every
                leg of the trip has to be in the list for this to apply, so a card an airline refuses
                in one class is not used because another leg qualified.
              </p>

              <div style={s.sectionLabel}>Status</div>
              <label style={s.checkRow}>
                <input type="checkbox" checked={form.active}
                  onChange={e => setForm(f => ({ ...f, active: e.target.checked }))} />
                <span>Active</span>
              </label>
              <p style={s.hint}>
                The status in the list also accounts for the card&rsquo;s expiry date.
              </p>

              <div style={s.field}>
                <label style={s.label}>Notes</label>
                <input value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                  placeholder="Agreement reference, who to call about it" style={s.input} />
              </div>

              {!creating && (
                <>
                  <div style={s.sectionLabel}>Applies to which clients</div>
                  {assignments.length === 0 ? (
                    <p style={s.hint}>
                      Not assigned to anyone — so this is the <strong>default</strong> for everything
                      in its scope. Assign clients only to override that for them.
                    </p>
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
                        options={assignLookup.options}
                        onSearch={assignLookup.onSearch}
                        loading={assignLookup.loading}
                        selectedLabel={assignLookup.selectedLabel}
                        placeholder="Search…"
                        emptyMessage="No matches"
                      />
                    </div>
                    <button onClick={addAssignment} disabled={!assignTarget || busy}
                      style={{ ...s.primaryBtn, opacity: !assignTarget || busy ? 0.5 : 1 }}>
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
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  root: { paddingBottom: 60 },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap', marginBottom: 16 },
  title: { fontSize: 20, fontWeight: 600, color: 'var(--color-ink)', margin: '0 0 4px', letterSpacing: '-0.3px' },
  sub: { fontSize: 13, color: 'var(--color-secondary)', margin: 0, lineHeight: 1.6, maxWidth: 640 },

  filters: { display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' },
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
  payerPill: { fontSize: 11, fontWeight: 600, color: '#3730A3', background: '#EEF2FF', borderRadius: 4, padding: '2px 7px' },
  statusPill: { display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 600, borderRadius: 999, padding: '2px 9px', border: '1px solid transparent' },
  dot: { width: 5, height: 5, borderRadius: '50%', flexShrink: 0 },
  dimmed: { opacity: 0.55, transition: 'opacity 120ms ease' },

  muted: { color: '#9CA3AF' },
  hint: { fontSize: 12, color: 'var(--color-secondary)', lineHeight: 1.55, margin: '4px 0 0' },
  hintWarn: { fontSize: 12, color: '#92400E', lineHeight: 1.55, margin: '4px 0 0' },

  empty: { background: '#fff', border: '1px dashed var(--color-line-strong)', borderRadius: 10, padding: '28px 22px', textAlign: 'center' },
  emptyTitle: { fontSize: 14, fontWeight: 600, color: 'var(--color-ink)', margin: '0 0 5px' },
  emptyDesc: { fontSize: 12, color: 'var(--color-secondary)', margin: 0, lineHeight: 1.6, maxWidth: 520, marginLeft: 'auto', marginRight: 'auto' },

  errorBanner: { background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8, padding: '10px 14px', fontSize: 12, color: '#DC2626', marginBottom: 14 },
  successBanner: { background: '#ECFDF5', border: '1px solid #A7F3D0', borderRadius: 8, padding: '10px 14px', fontSize: 12, color: '#065F46', marginBottom: 14 },

  chipRow: { display: 'flex', gap: 6, flexWrap: 'wrap' },
  assignChip: { display: 'inline-flex', alignItems: 'center', gap: 7, background: '#fff', border: '1px solid var(--color-line-strong)', borderRadius: 6, padding: '4px 8px', fontSize: 12 },
  chipX: { background: 'none', border: 'none', color: '#9CA3AF', fontSize: 15, lineHeight: 1, cursor: 'pointer', padding: 0 },

  backdrop: { position: 'fixed', inset: 0, background: 'rgba(10,10,20,0.28)', zIndex: 40 },
  panel: { position: 'fixed', top: 0, right: 0, bottom: 0, width: 'min(560px, 92vw)', background: '#fff', zIndex: 41, display: 'flex', flexDirection: 'column', boxShadow: '-8px 0 32px rgba(0,8,53,0.12)' },
  panelHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 20px', borderBottom: '1px solid var(--color-line)' },
  panelTitle: { fontSize: 15, fontWeight: 600, color: 'var(--color-ink)', margin: 0 },
  panelBody: { flex: 1, overflowY: 'auto', padding: '16px 20px' },
  panelFoot: { display: 'flex', gap: 8, padding: '14px 20px', borderTop: '1px solid var(--color-line)' },

  primaryBtn: { height: 32, padding: '0 14px', background: 'var(--color-rail)', color: '#fff', fontSize: 12, fontWeight: 600, border: 'none', borderRadius: 6, cursor: 'pointer' },
  ghostBtn: { height: 30, padding: '0 11px', background: '#fff', color: '#374151', fontSize: 12, border: '1px solid var(--color-line-strong)', borderRadius: 6, cursor: 'pointer' },
  dangerBtn: { height: 32, padding: '0 12px', background: '#fff', color: '#DC2626', fontSize: 12, border: '1px solid #FECACA', borderRadius: 6, cursor: 'pointer' },
}
