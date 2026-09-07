'use client'

import { useState } from 'react'
import Pagination from '@/app/components/Pagination'
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
}

interface Staff { id: string; full_name: string; email: string; status: string }

const EMPTY: Omit<Branch, 'id' | 'staffCount'> = {
  name: '', branch_no: '', profit_centre_code: '',
  gst_number: '', gst_name: '', gst_email: '', gst_contact: '',
  gst_address_1: '', gst_address_2: '',
  country: 'India', gst_state: '', gst_city: '', gst_zip: '',
  iata_number: '', office_id: '',
  is_head_office: false, status: 'active',
}

export default function BranchesPage() {
  const list = usePagedList<Branch>('/api/tmc/branches')
  const branches = list.items

  const [selectedId, setSelectedId] = useState('')
  const [creating, setCreating] = useState(false)
  const [form, setForm] = useState({ ...EMPTY })
  const [staff, setStaff] = useState<Staff[]>([])

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  function set<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm(prev => ({ ...prev, [key]: value }))
  }

  async function open(id: string) {
    setCreating(false)
    setSelectedId(id)
    setError(''); setSuccess('')
    const d = await fetch(`/api/tmc/branches/${id}`).then(r => r.json())
    if (!d.ok) { setError(d.error || 'Could not load that branch.'); return }
    setForm({
      name: d.branch.name ?? '',
      branch_no: d.branch.branch_no ?? '',
      profit_centre_code: d.branch.profit_centre_code ?? '',
      gst_number: d.branch.gst_number ?? '',
      gst_name: d.branch.gst_name ?? '',
      gst_email: d.branch.gst_email ?? '',
      gst_contact: d.branch.gst_contact ?? '',
      gst_address_1: d.branch.gst_address_1 ?? '',
      gst_address_2: d.branch.gst_address_2 ?? '',
      country: d.branch.country ?? 'India',
      gst_state: d.branch.gst_state ?? '',
      gst_city: d.branch.gst_city ?? '',
      gst_zip: d.branch.gst_zip ?? '',
      iata_number: d.branch.iata_number ?? '',
      office_id: d.branch.office_id ?? '',
      is_head_office: d.branch.is_head_office,
      status: d.branch.status,
    })
    setStaff(d.staff ?? [])
  }

  function startNew() {
    setCreating(true)
    setSelectedId('')
    setForm({ ...EMPTY })
    setStaff([])
    setError(''); setSuccess('')
  }

  async function save() {
    if (!form.name.trim()) { setError('Branch name is required.'); return }
    setBusy(true); setError('')
    try {
      const res = creating
        ? await fetch('/api/tmc/branches', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(form),
          })
        : await fetch(`/api/tmc/branches/${selectedId}`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(form),
          })
      const d = await res.json()
      if (!d.ok) { setError(d.error || 'Could not save.'); return }
      setSuccess(creating ? 'Branch created.' : 'Branch saved.')
      list.refetch()
      if (creating) await open(d.branch.id)
    } finally { setBusy(false) }
  }

  async function remove() {
    if (!confirm(`Delete "${form.name}"?`)) return
    setBusy(true); setError('')
    try {
      const d = await fetch(`/api/tmc/branches/${selectedId}`, { method: 'DELETE' }).then(r => r.json())
      if (!d.ok) { setError(d.error || 'Could not delete.'); return }
      setSelectedId('')
      list.refetch()
    } finally { setBusy(false) }
  }

  // Warns, never blocks — the GSTIN is the TMC's own certificate and refusing an
  // unusual-but-real one is worse than storing one that needs correcting.
  const gstWarning = gstinFinding(form.gst_number, form.gst_state)
  const derivedPan = readGstin(form.gst_number).pan

  const panelOpen = creating || Boolean(selectedId)

  return (
    <div style={s.root}>
      <div style={s.header}>
        <div>
          <h1 style={s.title}>Branches</h1>
          <p style={s.sub}>
            Your own offices. Each carries its own GST registration — in India that is per state, so
            a branch is the entity that raises invoices, not just an address.
          </p>
        </div>
        <button onClick={startNew} style={s.primaryBtn}>New branch</button>
      </div>

      {error && <div style={s.errorBanner}>{error}</div>}
      {success && <div style={s.successBanner}>{success}</div>}

      <div style={s.split}>
        <div style={s.list}>
          <input
            value={list.search}
            onChange={e => list.setSearch(e.target.value)}
            placeholder="Search name, number, city…"
            style={{ ...s.input, marginBottom: 8 }}
          />

          {list.loading ? (
            <SkeletonTable rows={6} cols={2} />
          ) : branches.length === 0 ? (
            <div style={s.empty}>
              <p style={s.emptyTitle}>
                {list.search ? 'No branches match' : 'No branches yet'}
              </p>
              <p style={s.emptyDesc}>
                {list.search
                  ? 'Search covers every branch, not just this page.'
                  : 'Add your first office. Counsellors can then be assigned to it.'}
              </p>
            </div>
          ) : (
            <div style={list.refreshing ? s.dimmed : undefined}>
              {branches.map(b => (
                <button
                  key={b.id}
                  onClick={() => open(b.id)}
                  style={{ ...s.card, ...(b.id === selectedId ? s.cardOn : {}) }}
                >
                  <span style={s.cardTop}>
                    <span style={s.cardName}>{b.name}</span>
                    {b.is_head_office && <span style={s.hqPill}>HQ</span>}
                    {b.status === 'inactive' && <span style={s.inactivePill}>Inactive</span>}
                  </span>
                  <span style={s.cardMeta}>
                    {[b.branch_no, b.gst_city, b.gst_state].filter(Boolean).join(' · ') || 'No location set'}
                  </span>
                  <span style={s.cardMeta}>
                    {b.staffCount === 0
                      ? 'No staff assigned'
                      : `${b.staffCount} ${b.staffCount === 1 ? 'person' : 'people'}`}
                  </span>
                </button>
              ))}
            </div>
          )}

          <Pagination
            page={list.page} pageSize={10} total={list.total}
            onPageChange={list.setPage} busy={list.refreshing} noun="branches"
          />
        </div>

        <div style={s.detail}>
          {!panelOpen ? (
            <p style={s.muted}>Select a branch to edit it, or create one.</p>
          ) : (
            <>
              <h2 style={s.panelTitle}>{creating ? 'New branch' : form.name || 'Branch'}</h2>

              {/* ── Identity ────────────────────────────────────────────── */}
              <div style={s.sectionLabel}>Identity</div>
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
                    style={{ ...s.input, fontFamily: 'var(--font-mono)' }} />
                </div>
                <div style={{ ...s.field, flex: 1 }}>
                  <label style={s.label}>Profit centre code</label>
                  <input value={form.profit_centre_code ?? ''} onChange={e => set('profit_centre_code', e.target.value)}
                    style={{ ...s.input, fontFamily: 'var(--font-mono)' }} />
                </div>
              </div>

              {/* ── GST ─────────────────────────────────────────────────── */}
              <div style={s.sectionLabel}>Registered GST details</div>
              <div style={s.field}>
                <label style={s.label}>GST number</label>
                <input value={form.gst_number ?? ''} onChange={e => set('gst_number', e.target.value.toUpperCase())}
                  placeholder="07AAAAA0000A1Z5" maxLength={15}
                  style={{ ...s.input, fontFamily: 'var(--font-mono)', letterSpacing: '0.04em' }} />
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
                  <input type="email" value={form.gst_email ?? ''} onChange={e => set('gst_email', e.target.value)}
                    style={s.input} />
                </div>
                <div style={{ ...s.field, flex: 1 }}>
                  <label style={s.label}>Invoice contact</label>
                  <input value={form.gst_contact ?? ''} onChange={e => set('gst_contact', e.target.value)}
                    style={s.input} />
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
              <div style={s.field}>
                <label style={s.label}>Country</label>
                <CountryDropdown value={form.country} onChange={v => set('country', v)} />
              </div>
              <div style={s.field}>
                <label style={s.label}>State</label>
                {/* Closed list, unlike city: the GSTIN's first two digits have to
                    agree with something, and free text could never be checked. */}
                <StateDropdown value={form.gst_state ?? ''} onChange={v => set('gst_state', v)} />
              </div>
              <div style={s.row}>
                <div style={{ ...s.field, flex: 2 }}>
                  <label style={s.label}>City</label>
                  <CityDropdown
                    value={form.gst_city ?? ''}
                    onChange={v => set('gst_city', v)}
                    state={form.gst_state ?? undefined}
                  />
                </div>
                <div style={{ ...s.field, flex: 1 }}>
                  <label style={s.label}>PIN code</label>
                  <input value={form.gst_zip ?? ''} onChange={e => set('gst_zip', e.target.value)}
                    style={{ ...s.input, fontFamily: 'var(--font-mono)' }} />
                </div>
              </div>

              {/* ── Settlement ──────────────────────────────────────────── */}
              <div style={s.sectionLabel}>Settlement</div>
              <div style={s.row}>
                <div style={{ ...s.field, flex: 1 }}>
                  <label style={s.label}>IATA / ARC number</label>
                  <input value={form.iata_number ?? ''} onChange={e => set('iata_number', e.target.value.toUpperCase())}
                    style={{ ...s.input, fontFamily: 'var(--font-mono)' }} />
                </div>
                <div style={{ ...s.field, flex: 1 }}>
                  <label style={s.label}>Office ID / PCC</label>
                  <input value={form.office_id ?? ''} onChange={e => set('office_id', e.target.value.toUpperCase())}
                    placeholder="DELIN2100" style={{ ...s.input, fontFamily: 'var(--font-mono)' }} />
                </div>
              </div>
              <p style={s.hint}>
                Recorded for settlement and reconciliation. They do <strong>not</strong> yet change
                where a booking is ticketed — the app connects to one GDS office today.
              </p>

              {/* ── Status ──────────────────────────────────────────────── */}
              <div style={s.sectionLabel}>Status</div>
              <label style={s.checkRow}>
                <input type="checkbox" checked={form.is_head_office}
                  onChange={e => set('is_head_office', e.target.checked)} />
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

              {!creating && (
                <>
                  <div style={s.sectionLabel}>Staff here</div>
                  {staff.length === 0 ? (
                    <p style={s.hint}>
                      Nobody assigned yet. Counsellors are put in a branch from the Users screen.
                    </p>
                  ) : (
                    <div style={s.chipRow}>
                      {staff.map(p => (
                        <span key={p.id} style={s.staffChip}>
                          {p.full_name}
                          <span style={{ color: '#9CA3AF' }}>{p.email}</span>
                        </span>
                      ))}
                    </div>
                  )}
                  <p style={s.hint}>
                    A branch is organisational. It grants no access on its own — which clients
                    someone can reach is set per counsellor under Users.
                  </p>
                </>
              )}

              <div style={s.btnRow}>
                <button onClick={save} disabled={busy}
                  style={{ ...s.primaryBtn, opacity: busy ? 0.5 : 1 }}>
                  {busy ? 'Saving…' : 'Save'}
                </button>
                {!creating && <button onClick={remove} disabled={busy} style={s.dangerBtn}>Delete</button>}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  root: { paddingBottom: 60 },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap', marginBottom: 18 },
  title: { fontSize: 20, fontWeight: 600, color: 'var(--color-ink)', margin: '0 0 4px', letterSpacing: '-0.3px' },
  sub: { fontSize: 13, color: 'var(--color-secondary)', margin: 0, lineHeight: 1.6, maxWidth: 640 },

  split: { display: 'flex', gap: 20, alignItems: 'flex-start', flexWrap: 'wrap' },
  list: { width: 280, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 6 },
  card: { textAlign: 'left', background: '#fff', border: '1px solid var(--color-line)', borderLeft: '3px solid transparent', borderRadius: 8, padding: '10px 12px', cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 3, width: '100%', marginBottom: 6 },
  cardOn: { borderLeftColor: 'var(--color-rail)', background: '#F5F6FF' },
  cardTop: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  cardName: { fontSize: 13, fontWeight: 600, color: 'var(--color-ink)' },
  cardMeta: { fontSize: 11, color: 'var(--color-secondary)' },
  hqPill: { fontSize: 9, fontWeight: 700, color: '#3730A3', background: '#EEF2FF', borderRadius: 3, padding: '1px 5px', letterSpacing: '0.04em' },
  inactivePill: { fontSize: 9, fontWeight: 700, color: '#6B7280', background: '#F3F4F6', borderRadius: 3, padding: '1px 5px' },

  detail: { flex: 1, minWidth: 340, background: '#fff', border: '1px solid var(--color-line)', borderRadius: 10, padding: '18px 20px' },
  panelTitle: { fontSize: 16, fontWeight: 600, color: 'var(--color-ink)', margin: '0 0 4px' },

  field: { display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 14 },
  row: { display: 'flex', gap: 10, alignItems: 'flex-start' },
  label: { fontSize: 11, fontWeight: 600, color: 'var(--color-secondary)', textTransform: 'uppercase', letterSpacing: '0.5px' },
  input: { height: 38, padding: '0 10px', fontSize: 13, color: '#111827', background: '#fff', border: '1px solid var(--color-line-strong)', borderRadius: 7, outline: 'none', boxSizing: 'border-box', width: '100%' },
  checkRow: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--color-body)' },

  sectionLabel: { fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.11em', textTransform: 'uppercase', color: 'var(--color-secondary)', margin: '22px 0 12px', paddingBottom: 5, borderBottom: '1px solid var(--color-line)' },

  chipRow: { display: 'flex', gap: 6, flexWrap: 'wrap' },
  staffChip: { display: 'inline-flex', alignItems: 'center', gap: 7, background: '#F9FAFB', border: '1px solid var(--color-line)', borderRadius: 6, padding: '4px 9px', fontSize: 12 },

  btnRow: { display: 'flex', gap: 8, marginTop: 20 },
  muted: { fontSize: 13, color: 'var(--color-secondary)' },
  hint: { fontSize: 12, color: 'var(--color-secondary)', lineHeight: 1.55, margin: '4px 0 0' },
  hintWarn: { fontSize: 12, color: '#92400E', lineHeight: 1.55, margin: '4px 0 0' },
  dimmed: { opacity: 0.55, transition: 'opacity 120ms ease' },

  empty: { background: '#fff', border: '1px dashed var(--color-line-strong)', borderRadius: 10, padding: '22px 18px', textAlign: 'center' },
  emptyTitle: { fontSize: 13, fontWeight: 600, color: 'var(--color-ink)', margin: '0 0 5px' },
  emptyDesc: { fontSize: 12, color: 'var(--color-secondary)', margin: 0, lineHeight: 1.6 },

  errorBanner: { background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8, padding: '10px 14px', fontSize: 12, color: '#DC2626', marginBottom: 14 },
  successBanner: { background: '#ECFDF5', border: '1px solid #A7F3D0', borderRadius: 8, padding: '10px 14px', fontSize: 12, color: '#065F46', marginBottom: 14 },

  primaryBtn: { height: 34, padding: '0 16px', background: 'var(--color-rail)', color: '#fff', fontSize: 12, fontWeight: 600, border: 'none', borderRadius: 6, cursor: 'pointer' },
  dangerBtn: { height: 34, padding: '0 14px', background: '#fff', color: '#DC2626', fontSize: 12, border: '1px solid #FECACA', borderRadius: 6, cursor: 'pointer' },
}
