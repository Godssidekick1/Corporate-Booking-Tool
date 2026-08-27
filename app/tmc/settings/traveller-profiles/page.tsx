'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Papa from 'papaparse'

// ── /tmc/settings/traveller-profiles ─────────────────────────────────────────
// One screen for everything a travel desk maintains about a client's people:
// band, cost centre, department, designation, reporting line, and the passport
// and contact details a booking actually needs.
//
// Replaces the old Hierarchy page. Reporting line and band were two fields on a
// person; keeping them on a separate screen meant editing someone took two
// places and neither showed the whole record.
// ─────────────────────────────────────────────────────────────────────────────

interface Company { id: string; name: string }
interface Band { id: string; code: string; label: string; rank: number }
interface CostCentre { id: string; code: string; name: string }

interface TravelerProfile {
  title?: string
  gender?: string
  dateOfBirth?: string
  passportNumber?: string
  issuingCountry?: string
  nationality?: string
  passportExpiryDate?: string
  email?: string
  mobile?: string
  address?: string
  city?: string
  state?: string
  zipCode?: string
}

interface Employee {
  id: string
  full_name: string
  email: string
  role: string
  status: string
  band_code: string | null
  band_rank: number | null
  department: string | null
  cost_centre: string | null
  designation: string | null
  manager_id: string | null
  top_of_hierarchy: boolean
  traveler_profile: TravelerProfile | null
  trips: number
  profileComplete: boolean
}

const TITLES = ['MR', 'MRS', 'MS', 'MSTR']
const GENDERS = ['Male', 'Female']
const TOP_OF_HIERARCHY = '__top__'

// Grouped so the panel reads as sections rather than one long column of inputs.
const PROFILE_SECTIONS: { heading: string; fields: { key: keyof TravelerProfile; label: string; placeholder?: string }[] }[] = [
  {
    heading: 'Identity',
    fields: [
      { key: 'dateOfBirth', label: 'Date of birth', placeholder: 'DD/MM/YYYY' },
      { key: 'nationality', label: 'Nationality', placeholder: 'Indian' },
    ],
  },
  {
    heading: 'Passport',
    fields: [
      { key: 'passportNumber', label: 'Passport number' },
      { key: 'passportExpiryDate', label: 'Expiry', placeholder: 'DD/MM/YYYY' },
      { key: 'issuingCountry', label: 'Issuing country' },
    ],
  },
  {
    heading: 'Contact',
    fields: [
      { key: 'mobile', label: 'Mobile' },
      { key: 'email', label: 'Contact email' },
      { key: 'address', label: 'Address' },
      { key: 'city', label: 'City' },
      { key: 'state', label: 'State' },
      { key: 'zipCode', label: 'Postcode' },
    ],
  },
]

export default function TravellerProfilesPage() {
  const [companies, setCompanies] = useState<Company[]>([])
  const [companyId, setCompanyId] = useState('')

  const [employees, setEmployees] = useState<Employee[]>([])
  const [bands, setBands] = useState<Band[]>([])
  const [costCentres, setCostCentres] = useState<CostCentre[]>([])

  const [selectedId, setSelectedId] = useState('')
  const [draft, setDraft] = useState<Employee | null>(null)
  const [dirty, setDirty] = useState(false)

  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [importing, setImporting] = useState(false)
  const [query, setQuery] = useState('')
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [importReport, setImportReport] = useState<{ updated: number; skipped: number; errors: { row: number; email: string; error: string }[] } | null>(null)

  const fileRef = useRef<HTMLInputElement>(null)
  const successTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  function showSuccess(msg: string) {
    setSuccess(msg)
    if (successTimer.current) clearTimeout(successTimer.current)
    successTimer.current = setTimeout(() => setSuccess(''), 4000)
  }

  useEffect(() => {
    fetch('/api/tmc/companies').then(r => r.json())
      .then(d => { if (d.ok) setCompanies(d.companies) })
  }, [])

  useEffect(() => {
    if (!companyId) return
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId])

  async function load() {
    setLoading(true); setError(''); setImportReport(null)
    try {
      const d = await fetch(`/api/tmc/traveler-profiles?companyId=${companyId}`).then(r => r.json())
      if (!d.ok) { setError(d.error || 'Could not load traveller profiles.'); return }
      setEmployees(d.employees)
      setBands(d.bands)
      setCostCentres(d.costCentres)
      setSelectedId('')
      setDraft(null)
      setDirty(false)
    } finally { setLoading(false) }
  }

  function select(emp: Employee) {
    if (dirty && !confirm('You have unsaved changes. Discard them?')) return
    setSelectedId(emp.id)
    setDraft(structuredClone(emp))
    setDirty(false)
    setError('')
  }

  function edit(patch: Partial<Employee>) {
    setDraft(prev => (prev ? { ...prev, ...patch } : prev))
    setDirty(true); setSuccess('')
  }

  function editProfile(key: keyof TravelerProfile, value: string) {
    setDraft(prev => prev
      ? { ...prev, traveler_profile: { ...(prev.traveler_profile ?? {}), [key]: value } }
      : prev)
    setDirty(true); setSuccess('')
  }

  async function save() {
    if (!draft) return
    setSaving(true); setError('')
    try {
      // Two endpoints because they own different things: the profile route
      // handles the person's record, the employees route owns the reporting
      // line, which the approval engine reads.
      const profileSave = fetch(`/api/tmc/traveler-profiles/${draft.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fullName: draft.full_name,
          band: draft.band_code ?? undefined,
          costCentre: draft.cost_centre,
          department: draft.department,
          designation: draft.designation,
          profile: draft.traveler_profile ?? {},
        }),
      }).then(r => r.json())

      const original = employees.find(e => e.id === draft.id)
      const hierarchyChanged =
        original?.manager_id !== draft.manager_id ||
        original?.top_of_hierarchy !== draft.top_of_hierarchy

      const hierarchySave = hierarchyChanged
        ? fetch(`/api/tmc/employees/${draft.id}`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              managerId: draft.top_of_hierarchy ? null : draft.manager_id,
              topOfHierarchy: draft.top_of_hierarchy,
            }),
          }).then(r => r.json())
        : Promise.resolve({ ok: true })

      const [profileResult, hierarchyResult] = await Promise.all([profileSave, hierarchySave])

      if (!profileResult.ok) { setError(profileResult.error || 'Could not save the profile.'); return }
      if (!hierarchyResult.ok) { setError(hierarchyResult.error || 'Could not save the reporting line.'); return }

      setEmployees(prev => prev.map(e => (e.id === draft.id ? { ...draft } : e)))
      setDirty(false)
      showSuccess(`${draft.full_name} saved.`)
    } finally { setSaving(false) }
  }

  function downloadCsv() {
    // A plain navigation rather than fetch + blob: the route already sets
    // Content-Disposition, so the browser handles the filename and save dialog.
    window.location.href = `/api/tmc/traveler-profiles/csv?companyId=${companyId}`
  }

  function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setError(''); setImportReport(null); setImporting(true)

    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: async results => {
        try {
          const rows = results.data as Record<string, string>[]
          const d = await fetch('/api/tmc/traveler-profiles/csv', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ companyId, rows }),
          }).then(r => r.json())

          if (!d.ok) { setError(d.error || 'Could not import the file.'); return }
          setImportReport(d)
          if (d.updated > 0) await load()
          showSuccess(`${d.updated} profile${d.updated === 1 ? '' : 's'} updated.`)
        } finally {
          setImporting(false)
          if (fileRef.current) fileRef.current.value = ''
        }
      },
      error: err => {
        setError(`Could not read the file: ${err.message}`)
        setImporting(false)
      },
    })
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return employees
    return employees.filter(e =>
      e.full_name.toLowerCase().includes(q) ||
      e.email.toLowerCase().includes(q) ||
      (e.cost_centre ?? '').toLowerCase().includes(q) ||
      (e.department ?? '').toLowerCase().includes(q) ||
      (e.designation ?? '').toLowerCase().includes(q)
    )
  }, [employees, query])

  const incomplete = employees.filter(e => !e.profileComplete).length

  return (
    <div style={s.root}>
      <div style={s.header}>
        <h1 style={s.title}>Traveller profiles</h1>
        <p style={s.sub}>
          Everything the desk maintains for a client&apos;s people — band, cost centre,
          reporting line, and the passport and contact details a booking needs.
        </p>
      </div>

      <div style={s.toolbar}>
        <div style={s.field}>
          <label style={s.label}>Client</label>
          <select value={companyId} onChange={e => setCompanyId(e.target.value)} style={{ ...s.input, width: 240 }}>
            <option value="">Select a client…</option>
            {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>

        {companyId && (
          <div style={s.toolbarActions}>
            <button onClick={downloadCsv} style={s.ghostBtn}>↓ Export CSV</button>
            <button
              onClick={() => fileRef.current?.click()}
              disabled={importing}
              style={s.ghostBtn}
            >
              {importing ? 'Importing…' : '↑ Import CSV'}
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,text/csv"
              onChange={handleUpload}
              style={{ display: 'none' }}
            />
          </div>
        )}
      </div>

      {error && <div style={s.errorBanner}>⚠ {error}</div>}
      {success && <div style={s.successBanner}>✓ {success}</div>}

      {importReport && (
        <div style={importReport.skipped > 0 ? s.warnBanner : s.successBanner}>
          <strong>{importReport.updated} updated</strong>
          {importReport.skipped > 0 && <>, {importReport.skipped} skipped</>}
          {importReport.errors.length > 0 && (
            <ul style={s.errorList}>
              {importReport.errors.slice(0, 8).map((err, i) => (
                <li key={i}>Row {err.row}{err.email ? ` (${err.email})` : ''}: {err.error}</li>
              ))}
              {importReport.errors.length > 8 && <li>…and {importReport.errors.length - 8} more</li>}
            </ul>
          )}
        </div>
      )}

      {!companyId ? (
        <div style={s.empty}>
          <p style={s.emptyTitle}>Pick a client</p>
          <p style={s.emptyDesc}>Their people and travel profiles will appear here.</p>
        </div>
      ) : loading ? (
        <div style={s.loadingWrap}>
          <div style={s.spinner} />
          <p style={s.muted}>Loading traveller profiles…</p>
        </div>
      ) : (
        <>
          {incomplete > 0 && (
            <div style={s.warnBanner}>
              <strong>{incomplete} profile{incomplete === 1 ? '' : 's'} incomplete.</strong>{' '}
              A traveller with no date of birth cannot be ticketed — the booking will fail at
              the passenger step rather than at search.
            </div>
          )}

          <input
            type="search"
            placeholder="Search name, email, cost centre, designation…"
            value={query}
            onChange={e => setQuery(e.target.value)}
            style={s.search}
          />

          <div style={s.split}>
            {/* ── Roster ──────────────────────────────────────────── */}
            <div style={s.listPane}>
              <table style={s.table}>
                <thead>
                  <tr>
                    {['Employee', 'Band', 'Cost centre', 'Trips'].map(h => (
                      <th key={h} style={s.th}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(emp => (
                    <tr
                      key={emp.id}
                      onClick={() => select(emp)}
                      style={{
                        ...s.tr,
                        background: emp.id === selectedId ? '#F5F7FF' : 'transparent',
                        cursor: 'pointer',
                      }}
                    >
                      <td style={s.td}>
                        <div style={s.nameRow}>
                          <span style={s.name}>{emp.full_name}</span>
                          {!emp.profileComplete && <span style={s.incompleteDot} title="Profile incomplete" />}
                        </div>
                        <div style={s.email}>{emp.email}</div>
                        {(emp.designation || emp.department) && (
                          <div style={s.meta}>
                            {[emp.designation, emp.department].filter(Boolean).join(' · ')}
                          </div>
                        )}
                      </td>
                      <td style={s.td}>
                        {emp.band_code
                          ? <span style={s.badge}>{emp.band_code}</span>
                          : <span style={s.muted}>—</span>}
                      </td>
                      <td style={s.td}>
                        {emp.cost_centre || <span style={s.muted}>—</span>}
                      </td>
                      <td style={s.td}>
                        <span style={s.trips}>{emp.trips}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {filtered.length === 0 && (
                <div style={s.empty}>
                  <p style={s.emptyDesc}>
                    {query ? 'Nobody matches that search.' : 'This client has no employees yet.'}
                  </p>
                </div>
              )}
            </div>

            {/* ── Detail ──────────────────────────────────────────── */}
            <div style={s.detailPane}>
              {!draft ? (
                <div style={s.empty}>
                  <p style={s.emptyTitle}>No one selected</p>
                  <p style={s.emptyDesc}>Pick someone to see and edit their full profile.</p>
                </div>
              ) : (
                <>
                  <div style={s.detailHead}>
                    <div>
                      <h2 style={s.detailName}>{draft.full_name}</h2>
                      <p style={s.detailSub}>
                        {draft.email} · {draft.trips} trip{draft.trips === 1 ? '' : 's'}
                      </p>
                    </div>
                    <div style={s.detailActions}>
                      {dirty && <span style={s.unsaved}>Unsaved</span>}
                      <button
                        onClick={save}
                        disabled={!dirty || saving}
                        style={{ ...s.primaryBtn, opacity: !dirty || saving ? 0.5 : 1 }}
                      >
                        {saving ? 'Saving…' : 'Save'}
                      </button>
                    </div>
                  </div>

                  <h3 style={s.sectionHeading}>Corporate</h3>
                  <div style={s.grid}>
                    <Field label="Full name">
                      <input
                        type="text" value={draft.full_name}
                        onChange={e => edit({ full_name: e.target.value })}
                        style={s.input}
                      />
                    </Field>

                    <Field label="Band">
                      <select
                        value={draft.band_code ?? ''}
                        onChange={e => edit({ band_code: e.target.value })}
                        style={s.input}
                      >
                        <option value="" disabled>Pick a band…</option>
                        {bands.map(b => (
                          <option key={b.id} value={b.code}>{b.code} · {b.label} (rank {b.rank})</option>
                        ))}
                      </select>
                    </Field>

                    <Field label="Cost centre">
                      <select
                        value={draft.cost_centre ?? ''}
                        onChange={e => edit({ cost_centre: e.target.value || null })}
                        style={s.input}
                      >
                        <option value="">None</option>
                        {costCentres.map(c => (
                          <option key={c.id} value={c.code}>{c.code} · {c.name}</option>
                        ))}
                        {/* A value set before this list existed would otherwise
                            vanish from the dropdown and look like "None". */}
                        {draft.cost_centre && !costCentres.some(c => c.code === draft.cost_centre) && (
                          <option value={draft.cost_centre}>{draft.cost_centre} (not in list)</option>
                        )}
                      </select>
                    </Field>

                    <Field label="Department">
                      <input
                        type="text" value={draft.department ?? ''}
                        onChange={e => edit({ department: e.target.value || null })}
                        placeholder="Engineering"
                        style={s.input}
                      />
                    </Field>

                    <Field label="Designation">
                      <input
                        type="text" value={draft.designation ?? ''}
                        onChange={e => edit({ designation: e.target.value || null })}
                        placeholder="Head of IT"
                        style={s.input}
                      />
                    </Field>

                    <Field label="Reports to">
                      <select
                        value={draft.top_of_hierarchy ? TOP_OF_HIERARCHY : (draft.manager_id ?? '')}
                        onChange={e => {
                          const v = e.target.value
                          if (v === TOP_OF_HIERARCHY) edit({ top_of_hierarchy: true, manager_id: null })
                          else edit({ top_of_hierarchy: false, manager_id: v || null })
                        }}
                        style={s.input}
                      >
                        <option value="">Not set yet</option>
                        <option value={TOP_OF_HIERARCHY}>Nobody — top of hierarchy</option>
                        {employees.filter(o => o.id !== draft.id).map(o => (
                          <option key={o.id} value={o.id}>{o.full_name}</option>
                        ))}
                      </select>
                    </Field>
                  </div>

                  <h3 style={s.sectionHeading}>Traveller</h3>
                  <div style={s.grid}>
                    <Field label="Title">
                      <select
                        value={draft.traveler_profile?.title ?? ''}
                        onChange={e => editProfile('title', e.target.value)}
                        style={s.input}
                      >
                        <option value="">—</option>
                        {TITLES.map(t => <option key={t} value={t}>{t}</option>)}
                      </select>
                    </Field>
                    <Field label="Gender">
                      <select
                        value={draft.traveler_profile?.gender ?? ''}
                        onChange={e => editProfile('gender', e.target.value)}
                        style={s.input}
                      >
                        <option value="">—</option>
                        {GENDERS.map(g => <option key={g} value={g}>{g}</option>)}
                      </select>
                    </Field>
                  </div>

                  {PROFILE_SECTIONS.map(section => (
                    <div key={section.heading}>
                      <h4 style={s.subHeading}>{section.heading}</h4>
                      <div style={s.grid}>
                        {section.fields.map(f => (
                          <Field key={f.key} label={f.label}>
                            <input
                              type="text"
                              value={draft.traveler_profile?.[f.key] ?? ''}
                              onChange={e => editProfile(f.key, e.target.value)}
                              placeholder={f.placeholder}
                              style={s.input}
                            />
                          </Field>
                        ))}
                      </div>
                    </div>
                  ))}
                </>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={s.field}>
      <label style={s.label}>{label}</label>
      {children}
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  root: { fontFamily: "'Inter', -apple-system, sans-serif", paddingBottom: 60 },
  header: { marginBottom: 18 },
  title: { fontSize: 20, fontWeight: 600, color: '#0A0A14', margin: '0 0 4px', letterSpacing: '-0.3px' },
  sub: { fontSize: 13, color: '#6B7280', margin: 0, lineHeight: 1.6, maxWidth: 660 },

  toolbar: { display: 'flex', gap: 16, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 16 },
  toolbarActions: { display: 'flex', gap: 8, marginLeft: 'auto' },

  field: { display: 'flex', flexDirection: 'column', gap: 5 },
  label: { fontSize: 11, fontWeight: 600, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.5px' },
  input: { height: 36, padding: '0 10px', fontSize: 13, color: '#111827', background: '#fff', border: '1px solid #D1D5DB', borderRadius: 7, outline: 'none', width: '100%' },
  search: { height: 38, width: '100%', maxWidth: 420, padding: '0 12px', fontSize: 13, background: '#fff', border: '1px solid #D1D5DB', borderRadius: 8, outline: 'none', marginBottom: 14 },

  errorBanner: { background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8, padding: '10px 14px', fontSize: 12, color: '#DC2626', marginBottom: 14 },
  successBanner: { background: '#ECFDF5', border: '1px solid #A7F3D0', borderRadius: 8, padding: '10px 14px', fontSize: 12, color: '#065F46', marginBottom: 14 },
  warnBanner: { background: '#FEF3C7', border: '1px solid #FDE68A', borderRadius: 8, padding: '11px 14px', fontSize: 12, color: '#92400E', marginBottom: 14, lineHeight: 1.6 },
  errorList: { margin: '6px 0 0', paddingLeft: 18 },

  split: { display: 'grid', gridTemplateColumns: 'minmax(320px, 1fr) minmax(340px, 1fr)', gap: 16, alignItems: 'start' },
  listPane: { background: '#fff', border: '1px solid #E5E7EB', borderRadius: 10, overflow: 'hidden', maxHeight: '70vh', overflowY: 'auto' },
  detailPane: { background: '#fff', border: '1px solid #E5E7EB', borderRadius: 10, padding: 18, maxHeight: '70vh', overflowY: 'auto' },

  table: { borderCollapse: 'collapse', width: '100%' },
  th: { padding: '9px 12px', textAlign: 'left', background: '#F9FAFB', borderBottom: '1px solid #E5E7EB', fontSize: 11, fontWeight: 600, color: '#374151', position: 'sticky', top: 0, zIndex: 1 },
  tr: { borderBottom: '1px solid #F3F4F6' },
  td: { padding: '9px 12px', fontSize: 13, color: '#374151', verticalAlign: 'top' },
  nameRow: { display: 'flex', alignItems: 'center', gap: 6 },
  name: { fontSize: 13, fontWeight: 500, color: '#111827' },
  email: { fontSize: 11, color: '#9CA3AF' },
  meta: { fontSize: 11, color: '#6B7280', marginTop: 2 },
  incompleteDot: { width: 6, height: 6, borderRadius: '50%', background: '#F59E0B', flexShrink: 0 },
  badge: { display: 'inline-block', padding: '2px 7px', background: '#EEF2FF', color: '#3730A3', fontSize: 10, fontWeight: 700, borderRadius: 4 },
  trips: { fontSize: 12, fontWeight: 600, color: '#374151' },
  muted: { color: '#9CA3AF', fontSize: 12 },

  detailHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 18, paddingBottom: 14, borderBottom: '1px solid #F3F4F6' },
  detailName: { fontSize: 16, fontWeight: 600, color: '#111827', margin: '0 0 3px' },
  detailSub: { fontSize: 12, color: '#9CA3AF', margin: 0 },
  detailActions: { display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 },
  unsaved: { fontSize: 11, fontWeight: 500, color: '#92400E', background: '#FEF3C7', border: '1px solid #FDE68A', borderRadius: 4, padding: '3px 8px' },

  sectionHeading: { fontSize: 12, fontWeight: 700, color: '#111827', textTransform: 'uppercase', letterSpacing: '0.6px', margin: '18px 0 10px' },
  subHeading: { fontSize: 11, fontWeight: 600, color: '#6B7280', margin: '16px 0 8px' },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12 },

  primaryBtn: { height: 34, padding: '0 16px', background: '#000835', color: '#fff', fontSize: 13, fontWeight: 600, border: 'none', borderRadius: 7, cursor: 'pointer' },
  ghostBtn: { height: 34, padding: '0 13px', background: '#fff', color: '#374151', fontSize: 12, fontWeight: 500, border: '1px solid #D1D5DB', borderRadius: 7, cursor: 'pointer' },

  empty: { padding: '40px 20px', textAlign: 'center' },
  emptyTitle: { fontSize: 13, fontWeight: 600, color: '#374151', margin: '0 0 4px' },
  emptyDesc: { fontSize: 12, color: '#9CA3AF', margin: 0 },
  loadingWrap: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, padding: '60px' },
  spinner: { width: 24, height: 24, border: '2.5px solid #E5E7EB', borderTopColor: '#000835', borderRadius: '50%', animation: 'spin 0.7s linear infinite' },
}
