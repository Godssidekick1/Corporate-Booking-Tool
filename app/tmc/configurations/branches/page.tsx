'use client'

import { useCallback, useState } from 'react'
import Pagination from '@/app/components/Pagination'
import SlideOver from '@/app/components/SlideOver'
import { SkeletonTable } from '@/app/components/Skeleton'
import CountryDropdown from '@/app/components/CountryDropdown'
import StateDropdown from '@/app/components/StateDropdown'
import CityDropdown from '@/app/components/CityDropdown'
import { usePagedList } from '@/app/hooks/usePagedList'
import { gstinFinding, readGstin } from '@/app/lib/data/gstin'

// ── /tmc/configurations/branches ─────────────────────────────────────────────
// The TMC's own offices.
//
// A branch here is primarily a TAX-REGISTRATION entity: GST registers per state
// in India, so each branch is a distinct registered place of business raising
// its own invoices. That is why the address fields are the GST address rather
// than a postal one, and why gst_name (the legal name on the certificate) is
// separate from the working name.
//
// Not a permission boundary and not a client group — both stated on the screen,
// because both are what someone will assume.
//
// Same shape as the other masters: a table, edited in the slide-over.
// ─────────────────────────────────────────────────────────────────────────────

interface Branch {
  id: string
  name: string
  branch_no: string | null
  profit_centre_code: string | null
  gst_number: string | null
  gst_name: string | null
  gst_email: string | null
  gst_contact: string | null
  gst_address_1: string | null
  gst_address_2: string | null
  country: string
  gst_state: string | null
  gst_city: string | null
  gst_zip: string | null
  iata_number: string | null
  office_id: string | null
  is_head_office: boolean
  status: string
  staffCount: number
  updated_at: string
  updated_by_name: string | null
}

interface Staff { id: string; full_name: string; email: string; status: string }

type Form = Omit<Branch, 'id' | 'staffCount' | 'updated_at' | 'updated_by_name'>

const EMPTY: Form = {
  name: '', branch_no: '', profit_centre_code: '',
  gst_number: '', gst_name: '', gst_email: '', gst_contact: '',
  gst_address_1: '', gst_address_2: '',
  country: 'India', gst_state: '', gst_city: '', gst_zip: '',
  iata_number: '', office_id: '',
  is_head_office: false, status: 'active',
}

const STATUS_FILTERS = [
  { id: '', label: 'Status: All' },
  { id: 'active', label: 'Status: Active' },
  { id: 'inactive', label: 'Status: Inactive' },
]

function when(iso: string): string {
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
}

function toForm(b: Branch): Form {
  return {
    name: b.name ?? '',
    branch_no: b.branch_no ?? '',
    profit_centre_code: b.profit_centre_code ?? '',
    gst_number: b.gst_number ?? '',
    gst_name: b.gst_name ?? '',
    gst_email: b.gst_email ?? '',
    gst_contact: b.gst_contact ?? '',
    gst_address_1: b.gst_address_1 ?? '',
    gst_address_2: b.gst_address_2 ?? '',
    country: b.country ?? 'India',
    gst_state: b.gst_state ?? '',
    gst_city: b.gst_city ?? '',
    gst_zip: b.gst_zip ?? '',
    iata_number: b.iata_number ?? '',
    office_id: b.office_id ?? '',
    is_head_office: b.is_head_office,
    status: b.status,
  }
}

export default function BranchesPage() {
  const [status, setStatus] = useState('')
  const list = usePagedList<Branch>('/api/tmc/branches', { params: { status: status || undefined } })

  // The editor. `editing.id` null = a new branch.
  const [editing, setEditing] = useState<{ id: string | null } | null>(null)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [form, setForm] = useState<Form>({ ...EMPTY })
  const [original, setOriginal] = useState('')
  const [staff, setStaff] = useState<Staff[]>([])

  const [busy, setBusy] = useState(false)
  const [panelError, setPanelError] = useState('')
  const [success, setSuccess] = useState('')

  const dirty = editing !== null && JSON.stringify(form) !== original

  function set<K extends keyof Form>(key: K, value: Form[K]) {
    setForm(prev => ({ ...prev, [key]: value }))
  }

  async function open(id: string) {
    setEditing({ id }); setPanelError(''); setSuccess('')
    setLoadingDetail(true)
    try {
      const d = await fetch(`/api/tmc/branches/${id}`).then(r => r.json())
      if (!d.ok) { setPanelError(d.error || 'Could not load that branch.'); return }
      const f = toForm(d.branch)
      setForm(f)
      setOriginal(JSON.stringify(f))
      setStaff(d.staff ?? [])
    } catch {
      setPanelError('Could not load that branch. Check your connection and try again.')
    } finally {
      setLoadingDetail(false)
    }
  }

  function startNew() {
    setEditing({ id: null }); setPanelError(''); setSuccess('')
    setForm({ ...EMPTY })
    setOriginal(JSON.stringify(EMPTY))
    setStaff([])
  }

  const close = useCallback(() => {
    if (dirty && !confirm('Discard your changes to this branch?')) return
    setEditing(null)
  }, [dirty])

  async function save() {
    if (!editing) return
    if (!form.name.trim()) { setPanelError('Branch name is required.'); return }
    setBusy(true); setPanelError('')
    try {
      const res = editing.id === null
        ? await fetch('/api/tmc/branches', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form),
          })
        : await fetch(`/api/tmc/branches/${editing.id}`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form),
          })
      const d = await res.json()
      if (!d.ok) { setPanelError(d.error || 'Could not save the branch.'); return }
      setSuccess(editing.id === null ? `Branch "${d.branch.name}" created.` : `Branch "${d.branch.name}" saved.`)
      setEditing(null)
      list.refetch()
    } catch {
      setPanelError('Could not save. Check your connection and try again.')
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    if (!editing?.id || !confirm(`Delete the branch "${form.name}"?`)) return
    setBusy(true); setPanelError('')
    try {
      const d = await fetch(`/api/tmc/branches/${editing.id}`, { method: 'DELETE' }).then(r => r.json())
      if (!d.ok) { setPanelError(d.error || 'Could not delete the branch.'); return }
      setSuccess(`Branch "${form.name}" deleted.`)
      setEditing(null)
      list.refetch()
    } catch {
      setPanelError('Could not delete. Check your connection and try again.')
    } finally {
      setBusy(false)
    }
  }

  // Warns, never blocks — the GSTIN is the TMC's own certificate and refusing an
  // unusual-but-real one is worse than storing one that needs correcting.
  const gstWarning = gstinFinding(form.gst_number, form.gst_state)
  const derivedPan = readGstin(form.gst_number).pan
  const filtering = Boolean(list.search) || Boolean(status)

  return (
    <div>
      <div style={s.header}>
        <div>
          <h1 style={s.title}>Branches</h1>
          <p style={s.sub}>
            Your own offices. Each carries its own GST registration — in India that is per state, so
            a branch is the entity that raises invoices, not just an address.
          </p>
        </div>
        <button type="button" onClick={startNew} style={s.primaryBtn}>New branch</button>
      </div>

      {success && <div style={s.successBanner}>{success}</div>}
      {list.error && <div style={s.errorBanner}>{list.error}</div>}

      <div style={s.filters}>
        <input
          value={list.search}
          onChange={e => list.setSearch(e.target.value)}
          placeholder="Search name, number, city or state"
          style={{ ...s.input, flex: 2, minWidth: 200 }}
        />
        <select value={status} onChange={e => setStatus(e.target.value)} style={{ ...s.input, flex: 1, minWidth: 160 }}>
          {STATUS_FILTERS.map(f => <option key={f.id} value={f.id}>{f.label}</option>)}
        </select>
      </div>

      {list.loading ? (
        <SkeletonTable rows={8} cols={7} />
      ) : list.items.length === 0 ? (
        <div style={s.empty}>
          <div style={s.emptyTitle}>{filtering ? 'No branches match' : 'No branches yet'}</div>
          <p style={s.emptyDesc}>
            {filtering
              ? 'Search and filters cover every branch, not just this page.'
              : 'Add your first office. Counsellors can then be assigned to it.'}
          </p>
        </div>
      ) : (
        <div style={{ ...s.tableWrap, ...(list.refreshing ? s.dimmed : {}) }}>
          <table style={s.table}>
            <thead>
              <tr>
                <th style={s.th}>Branch</th>
                <th style={s.th}>Location</th>
                <th style={s.th}>GSTIN</th>
                <th style={s.th}>IATA / Office ID</th>
                <th style={s.th}>Staff</th>
                <th style={s.th}>Status</th>
                <th style={s.th}>Updated</th>
              </tr>
            </thead>
            <tbody>
              {list.items.map((b, i) => {
                const finding = gstinFinding(b.gst_number, b.gst_state)
                return (
                  <tr
                    key={b.id}
                    onClick={() => open(b.id)}
                    style={{ ...s.tr, background: editing?.id === b.id ? '#F5F6FF' : i % 2 ? '#FAFAFA' : '#fff', cursor: 'pointer' }}
                  >
                    <td style={s.td}>
                      <span style={s.name}>{b.name}</span>
                      {b.is_head_office && <span style={s.hqPill}>Head office</span>}
                      {b.branch_no && <div style={{ marginTop: 4 }}><span style={s.code}>{b.branch_no}</span></div>}
                    </td>
                    <td style={s.td}>
                      {[b.gst_city, b.gst_state].filter(Boolean).join(', ') || <span style={s.muted}>No location set</span>}
                    </td>
                    <td style={s.td}>
                      {b.gst_number ? (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }} title={finding ?? undefined}>
                          <span style={s.mono}>{b.gst_number}</span>
                          {finding && <span style={s.warnMark} aria-label={finding}>!</span>}
                        </span>
                      ) : <span style={s.muted}>—</span>}
                    </td>
                    <td style={s.td}>
                      {b.iata_number || b.office_id
                        ? <span style={s.mono}>{[b.iata_number, b.office_id].filter(Boolean).join(' · ')}</span>
                        : <span style={s.muted}>—</span>}
                    </td>
                    <td style={s.td}>
                      {b.staffCount === 0 ? <span style={s.muted}>None</span> : b.staffCount}
                    </td>
                    <td style={s.td}>
                      <span style={{ ...s.statusPill, ...(b.status === 'active' ? s.statusActive : s.statusInactive) }}>
                        <span style={s.dot} />{b.status === 'active' ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                    <td style={s.td}>
                      <div style={s.dates}>{when(b.updated_at)}</div>
                      {b.updated_by_name && <div style={s.by}>{b.updated_by_name}</div>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <Pagination page={list.page} pageSize={10} total={list.total} onPageChange={list.setPage} busy={list.refreshing} noun="branches" />

      <SlideOver
        open={editing !== null}
        onClose={close}
        title={editing?.id === null
          ? 'New branch'
          : <>{form.name || 'Branch'}{form.is_head_office && <span style={s.hqPill}>Head office</span>}</>}
        footer={
          <>
            <button type="button" onClick={save} disabled={busy || loadingDetail || (!dirty && editing?.id !== null)}
              style={{ ...s.primaryBtn, opacity: busy || loadingDetail || (!dirty && editing?.id !== null) ? 0.5 : 1 }}>
              {busy ? 'Saving…' : editing?.id === null ? 'Create branch' : 'Save changes'}
            </button>
            <button type="button" onClick={close} style={s.ghostBtn}>Cancel</button>
            {editing?.id && (
              <button type="button" onClick={remove} disabled={busy} style={{ ...s.dangerBtn, marginLeft: 'auto' }}>Delete</button>
            )}
          </>
        }
      >
        {panelError && <div style={s.errorBanner}>{panelError}</div>}

        {loadingDetail ? (
          <SkeletonTable rows={6} cols={2} />
        ) : (
          <>
            {/* ── Identity ────────────────────────────────────────────── */}
            <div style={{ ...s.sectionLabel, marginTop: 0 }}>Identity</div>
            <div style={s.field}>
              <label style={s.label}>Branch name</label>
              <input value={form.name} onChange={e => set('name', e.target.value)}
                placeholder="Delhi — Connaught Place" style={s.input} />
              <p style={s.hint}>What the desk calls it. The legal name goes under GST details.</p>
            </div>
            <div style={s.row}>
              <div style={{ ...s.field, flex: 1 }}>
                <label style={s.label}>Branch no.</label>
                <input value={form.branch_no ?? ''} onChange={e => set('branch_no', e.target.value.toUpperCase())}
                  style={{ ...s.input, ...s.mono }} />
              </div>
              <div style={{ ...s.field, flex: 1 }}>
                <label style={s.label}>Profit centre code</label>
                <input value={form.profit_centre_code ?? ''} onChange={e => set('profit_centre_code', e.target.value)}
                  style={{ ...s.input, ...s.mono }} />
              </div>
            </div>

            {/* ── GST ─────────────────────────────────────────────────── */}
            <div style={s.sectionLabel}>Registered GST details</div>
            <div style={s.field}>
              <label style={s.label}>GST number</label>
              <input value={form.gst_number ?? ''} onChange={e => set('gst_number', e.target.value.toUpperCase())}
                placeholder="07AAAAA0000A1Z5" maxLength={15}
                style={{ ...s.input, ...s.mono, letterSpacing: '0.04em' }} />
              {gstWarning
                ? <p style={s.hintWarn}>{gstWarning}</p>
                : derivedPan && <p style={s.hint}>PAN {derivedPan} — read from the GSTIN, not stored separately.</p>}
            </div>
            <div style={s.field}>
              <label style={s.label}>Registered name</label>
              <input value={form.gst_name ?? ''} onChange={e => set('gst_name', e.target.value)}
                placeholder="Acme Travel Services Private Limited" style={s.input} />
            </div>
            <div style={s.row}>
              <div style={{ ...s.field, flex: 1 }}>
                <label style={s.label}>Invoice email</label>
                <input type="email" value={form.gst_email ?? ''} onChange={e => set('gst_email', e.target.value)} style={s.input} />
              </div>
              <div style={{ ...s.field, flex: 1 }}>
                <label style={s.label}>Invoice contact</label>
                <input value={form.gst_contact ?? ''} onChange={e => set('gst_contact', e.target.value)} style={s.input} />
              </div>
            </div>
            <div style={s.field}>
              <label style={s.label}>Address line 1</label>
              <input value={form.gst_address_1 ?? ''} onChange={e => set('gst_address_1', e.target.value)} style={s.input} />
            </div>
            <div style={s.field}>
              <label style={s.label}>Address line 2</label>
              <input value={form.gst_address_2 ?? ''} onChange={e => set('gst_address_2', e.target.value)} style={s.input} />
            </div>
            <div style={s.row}>
              <div style={{ ...s.field, flex: 1 }}>
                <label style={s.label}>Country</label>
                <CountryDropdown value={form.country} onChange={v => {
                  if (v !== form.country) { set('gst_state', ''); set('gst_city', '') }
                  set('country', v)
                }} />
              </div>
              <div style={{ ...s.field, flex: 1 }}>
                <label style={s.label}>State</label>
                {/* Closed list, unlike city: the GSTIN's first two digits have to
                    agree with something, and free text could never be checked. */}
                <StateDropdown value={form.gst_state ?? ''} onChange={v => set('gst_state', v)} country={form.country} />
              </div>
            </div>
            <div style={s.row}>
              <div style={{ ...s.field, flex: 2 }}>
                <label style={s.label}>City</label>
                <CityDropdown value={form.gst_city ?? ''} onChange={v => set('gst_city', v)}
                  country={form.country} state={form.gst_state ?? undefined} />
              </div>
              <div style={{ ...s.field, flex: 1 }}>
                <label style={s.label}>PIN code</label>
                <input value={form.gst_zip ?? ''} onChange={e => set('gst_zip', e.target.value)} style={{ ...s.input, ...s.mono }} />
              </div>
            </div>

            {/* ── Settlement ──────────────────────────────────────────── */}
            <div style={s.sectionLabel}>Settlement</div>
            <div style={s.row}>
              <div style={{ ...s.field, flex: 1 }}>
                <label style={s.label}>IATA / ARC number</label>
                <input value={form.iata_number ?? ''} onChange={e => set('iata_number', e.target.value.toUpperCase())}
                  style={{ ...s.input, ...s.mono }} />
              </div>
              <div style={{ ...s.field, flex: 1 }}>
                <label style={s.label}>Office ID / PCC</label>
                <input value={form.office_id ?? ''} onChange={e => set('office_id', e.target.value.toUpperCase())}
                  placeholder="DELIN2100" style={{ ...s.input, ...s.mono }} />
              </div>
            </div>
            <p style={s.hint}>
              Recorded for settlement and reconciliation. They do <strong>not</strong> yet change
              where a booking is ticketed — the app connects to one GDS office today.
            </p>

            {/* ── Status ──────────────────────────────────────────────── */}
            <div style={s.sectionLabel}>Status</div>
            <label style={s.checkRow}>
              <input type="checkbox" checked={form.is_head_office} onChange={e => set('is_head_office', e.target.checked)} />
              <span>Head office</span>
            </label>
            <p style={s.hint}>Only one branch can hold this — marking another moves it.</p>
            <div style={{ ...s.field, marginTop: 12 }}>
              <label style={s.label}>Status</label>
              <select value={form.status} onChange={e => set('status', e.target.value)} style={s.input}>
                <option value="active">Active</option>
                <option value="inactive">Inactive — retired, history kept</option>
              </select>
            </div>

            {editing?.id && (
              <>
                <div style={s.sectionLabel}>Staff here · {staff.length}</div>
                {staff.length === 0 ? (
                  <p style={s.hint}>Nobody assigned yet. Counsellors are put in a branch from the Users screen.</p>
                ) : (
                  <div style={s.staffList}>
                    {staff.map(p => (
                      <div key={p.id} style={s.staffRow}>
                        <span style={{ flex: 1, minWidth: 0 }}>
                          <span style={{ color: 'var(--color-ink)', fontWeight: 500 }}>{p.full_name}</span>
                          <span style={{ color: '#9CA3AF', marginLeft: 8 }}>{p.email}</span>
                        </span>
                        {p.status !== 'active' && <span style={s.inactiveSmall}>Inactive</span>}
                      </div>
                    ))}
                  </div>
                )}
                <p style={s.hint}>
                  A branch is organisational. It grants no access on its own — which clients
                  someone can reach is set per counsellor under Users.
                </p>
              </>
            )}
          </>
        )}
      </SlideOver>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap', marginBottom: 16 },
  title: { fontSize: 20, fontWeight: 600, color: 'var(--color-ink)', margin: '0 0 4px', letterSpacing: '-0.3px' },
  sub: { fontSize: 13, color: 'var(--color-secondary)', margin: 0, lineHeight: 1.6, maxWidth: 640 },

  filters: { display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' },
  input: { height: 36, padding: '0 10px', fontSize: 13, color: '#111827', background: '#fff', border: '1px solid var(--color-line-strong)', borderRadius: 7, outline: 'none', boxSizing: 'border-box', width: '100%' },
  mono: { fontFamily: 'var(--font-mono)' },

  tableWrap: { background: '#fff', border: '1px solid var(--color-line)', borderRadius: 10, overflowX: 'auto' },
  table: { borderCollapse: 'collapse', width: '100%' },
  th: { padding: '10px 14px', textAlign: 'left', background: '#F9FAFB', borderBottom: '1px solid var(--color-line)', fontSize: 11, fontWeight: 600, color: '#374151', whiteSpace: 'nowrap' },
  tr: { borderBottom: '1px solid #F3F4F6' },
  td: { padding: '10px 14px', fontSize: 13, color: 'var(--color-body)', verticalAlign: 'middle', whiteSpace: 'nowrap' },
  name: { fontWeight: 500, color: 'var(--color-ink)' },
  dimmed: { opacity: 0.55, transition: 'opacity 120ms ease' },
  muted: { color: '#9CA3AF' },
  dates: { fontSize: 12, fontVariantNumeric: 'tabular-nums', color: 'var(--color-body)' },
  by: { fontSize: 11.5, color: 'var(--color-secondary)', marginTop: 2 },
  code: { fontFamily: 'var(--font-mono)', fontSize: 11.5, fontWeight: 600, color: '#111827', background: '#F3F4F6', borderRadius: 4, padding: '2px 7px' },
  hqPill: { marginLeft: 8, fontSize: 10, fontWeight: 700, color: '#3730A3', background: '#EEF2FF', borderRadius: 4, padding: '2px 6px', textTransform: 'uppercase', letterSpacing: '0.04em', verticalAlign: 'middle' },
  warnMark: { width: 16, height: 16, borderRadius: '50%', background: '#FEF3C7', color: '#92400E', border: '1px solid #FDE68A', fontSize: 10, fontWeight: 700, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' },
  statusPill: { display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 600, borderRadius: 999, padding: '2px 9px', border: '1px solid transparent' },
  statusActive: { background: '#ECFDF5', color: '#065F46', borderColor: '#A7F3D0' },
  statusInactive: { background: '#F3F4F6', color: '#6B7280', borderColor: '#E5E7EB' },
  dot: { width: 5, height: 5, borderRadius: '50%', background: 'currentColor' },

  empty: { background: '#fff', border: '1px dashed var(--color-line-strong)', borderRadius: 10, padding: '28px 22px', textAlign: 'center' },
  emptyTitle: { fontSize: 14, fontWeight: 600, color: 'var(--color-ink)' },
  emptyDesc: { fontSize: 12, color: 'var(--color-secondary)', margin: '6px 0 0' },

  sectionLabel: { fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.11em', textTransform: 'uppercase', color: 'var(--color-secondary)', margin: '18px 0 10px', paddingBottom: 5, borderBottom: '1px solid var(--color-line)' },
  field: { display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 14, minWidth: 0 },
  row: { display: 'flex', gap: 10, alignItems: 'flex-start' },
  label: { fontSize: 11, fontWeight: 600, color: 'var(--color-secondary)', textTransform: 'uppercase', letterSpacing: '0.5px' },
  checkRow: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--color-body)' },
  hint: { fontSize: 12, color: 'var(--color-secondary)', lineHeight: 1.55, margin: '4px 0 0' },
  hintWarn: { fontSize: 12, color: '#92400E', lineHeight: 1.55, margin: '4px 0 0' },

  staffList: { display: 'flex', flexDirection: 'column', gap: 4 },
  staffRow: { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', background: '#F9FAFB', borderRadius: 7, fontSize: 12.5 },
  inactiveSmall: { fontSize: 10.5, fontWeight: 600, color: '#6B7280', background: '#F3F4F6', border: '1px solid #E5E7EB', borderRadius: 999, padding: '1px 8px' },

  primaryBtn: { height: 32, padding: '0 14px', background: 'var(--color-rail)', color: '#fff', fontSize: 12, fontWeight: 600, border: 'none', borderRadius: 6, cursor: 'pointer' },
  ghostBtn: { height: 30, padding: '0 11px', background: '#fff', color: '#374151', fontSize: 12, border: '1px solid var(--color-line-strong)', borderRadius: 6, cursor: 'pointer' },
  dangerBtn: { height: 32, padding: '0 12px', background: '#fff', color: '#DC2626', fontSize: 12, border: '1px solid #FECACA', borderRadius: 6, cursor: 'pointer' },

  errorBanner: { background: '#FEF2F2', border: '1px solid #FECACA', color: '#DC2626', borderRadius: 8, padding: '10px 14px', fontSize: 12, marginBottom: 14, lineHeight: 1.5 },
  successBanner: { background: '#ECFDF5', border: '1px solid #A7F3D0', color: '#065F46', borderRadius: 8, padding: '10px 14px', fontSize: 12, marginBottom: 14 },
}
