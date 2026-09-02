'use client'

import { useEffect, useState, useRef, useMemo } from 'react'
import BandLadderEditor, { type BandDraft } from './BandLadderEditor'
import Papa from 'papaparse'
import { canAccess } from '@/app/lib/permissions/canAccess'

interface Employee {
  full_name: string
  email: string
  role: string
  tmc_id: string
}

interface Client {
  id: string
  name: string
  status: string
  setup_completed: boolean
  created_at: string
}

interface client_group {
  id: string
  name: string
  city: string | null
}

interface PolicyGroupOption {
  id: string
  name: string
  code: string | null
  bandRanks: number[]
}

interface CsvEmployeeRow {
  email: string
  full_name: string
  role: string
  band: string
  department: string
  cost_centre: string
  _valid: boolean
  _error?: string
}

const SIZES = ['1-50', '51-200', '201-1000', '1001+']
const BOOKING_MODES: { value: string; label: string }[] = [
  { value: 'sbt', label: 'SBT — Self-Booking' },
  { value: 'cbt', label: 'CBT — Consultant-Booking' },
  { value: 'both', label: 'Hybrid — Both' },
]
const VALID_ROLES = ['employee', 'manager', 'finance', 'admin']
const MAX_EMPLOYEES = 250

const initialForm = {
  corporateName: '', adminName: '', adminEmail: '',
  registeredAddress: '', gstNumber: '', industry: '', primaryContactPhone: '',
  size: '', bookingMode: 'sbt', client_groupId: '', policyGroupId: '',
}

// A starting point only — the TMC edits these to match whatever the client
// actually calls its bands. Not a shared default: TMC-created clients define
// their own ladder, and only self-registration falls back to a fixed one.
const initialBands: BandDraft[] = [
  { code: 'L1', label: 'Junior',    rank: 1 },
  { code: 'L2', label: 'Associate', rank: 2 },
  { code: 'L3', label: 'Senior',    rank: 3 },
]

export default function TmcDashboardPage() {
  const [employee, setEmployee] = useState<Employee | null>(null)
  const [permissions, setPermissions] = useState<string[]>([])
  const [clients, setClients] = useState<Client[]>([])
  const [client_groups, setclient_groups] = useState<client_group[]>([])
  const [loading, setLoading] = useState(true)
  const [showInviteForm, setShowInviteForm] = useState(false)
  const [form, setForm] = useState(initialForm)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState('')
  const [formSuccess, setFormSuccess] = useState('')

  const [bands, setBands] = useState<BandDraft[]>(initialBands)
  const [policyGroups, setPolicyGroups] = useState<PolicyGroupOption[]>([])

  // CSV state
  const [csvRows, setCsvRows] = useState<CsvEmployeeRow[]>([])
  const [csvFileName, setCsvFileName] = useState('')
  const [csvError, setCsvError] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    Promise.all([
      fetch('/api/me').then(r => r.json()),
      fetch('/api/tmc/clients').then(r => r.json()),
      fetch('/api/tmc/client-groups').then(r => r.json()),
      // Existing policy groups, so a new client can reuse one at creation
      // instead of being left unprotected until someone links one later.
      fetch('/api/tmc/policy-groups').then(r => r.json()),
    ]).then(([meData, clientsData, client_groupsData, policyGroupsData]) => {
      if (meData.ok) {
        setEmployee(meData.employee)
        setPermissions(meData.permissions ?? [])
      }
      if (clientsData.ok) setClients(clientsData.clients)
      if (client_groupsData.ok) setclient_groups(client_groupsData.clientGroups)
      if (policyGroupsData.ok) setPolicyGroups(policyGroupsData.groups)
    }).finally(() => setLoading(false))
  }, [])

  const canCreateClient = canAccess(employee?.role, permissions, 'manage_users')

  const firstName = employee?.full_name?.split(' ')[0] ?? '…'

  function handleFormChange(e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) {
    setForm(prev => ({ ...prev, [e.target.name]: e.target.value }))
  }

  function resetForm() {
    setForm(initialForm)
    setBands(initialBands)
    setCsvRows([])
    setCsvFileName('')
    setCsvError('')
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  function handleCsvUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setCsvError('')
    setCsvFileName(file.name)

    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        const raw = results.data as Record<string, string>[]

        if (raw.length > MAX_EMPLOYEES) {
          setCsvError(`This file has ${raw.length} rows. Maximum is ${MAX_EMPLOYEES}.`)
          setCsvRows([])
          return
        }

        const parsed: CsvEmployeeRow[] = raw.map(row => {
          const email = (row.email || '').trim().toLowerCase()
          const full_name = (row.full_name || row.name || '').trim()
          const role = (row.role || 'employee').trim().toLowerCase()
          // Kept verbatim — the band is validated against the ladder the TMC
          // defines above, which it may still be editing. Uppercasing it here
          // used to be safe when every client had L1..L5; it now corrupts
          // codes like "Band 3", and defaulting to a literal "L1" invents a
          // band the client may not have.
          const band = (row.band || '').trim()
          const department = (row.department || '').trim()
          const cost_centre = (row.cost_centre || row.cost_center || '').trim()

          let error: string | undefined
          if (!email || !email.includes('@')) error = 'Invalid or missing email'
          else if (!full_name) error = 'Missing full name'
          else if (!VALID_ROLES.includes(role)) error = `Invalid role: ${role}`

          return {
            email, full_name, role, band, department, cost_centre,
            _valid: !error, _error: error,
          }
        })

        setCsvRows(parsed)
      },
      error: (err) => {
        setCsvError(`Could not parse file: ${err.message}`)
      },
    })
  }

  // Band validity depends on the ladder being edited on this same form, so it
  // is derived at render rather than frozen at parse time — editing a band code
  // re-validates the roster immediately instead of failing server-side.
  const validatedCsvRows = useMemo(() => {
    const byLowerCode = new Map(
      bands.filter(b => b.code.trim()).map(b => [b.code.trim().toLowerCase(), b.code.trim()])
    )
    const mostJunior = bands.reduce<BandDraft | null>(
      (lowest, b) => (!lowest || b.rank < lowest.rank ? b : lowest), null
    )

    return csvRows.map(row => {
      if (row._error) return row

      const raw = row.band.trim()
      // An empty band column means "most junior", which is the only default
      // that holds whatever the client calls its bands.
      const resolved = raw
        ? byLowerCode.get(raw.toLowerCase())
        : mostJunior?.code.trim()

      if (!resolved) {
        return {
          ...row,
          _valid: false,
          _error: raw
            ? `Band "${raw}" is not one of this client's bands`
            : 'No band given and no bands defined',
        }
      }

      return { ...row, band: resolved, _valid: true, _error: undefined }
    })
  }, [csvRows, bands])

  const validCsvCount = validatedCsvRows.filter(r => r._valid).length
  const invalidCsvCount = validatedCsvRows.length - validCsvCount

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setFormError('')
    setFormSuccess('')

    if (invalidCsvCount > 0) {
      setFormError(`Fix ${invalidCsvCount} invalid row(s) in the employee list before submitting.`)
      return
    }

    setSubmitting(true)
    try {
      const employeesPayload = validatedCsvRows.filter(r => r._valid).map(r => ({
        email: r.email, full_name: r.full_name, role: r.role,
        band: r.band, department: r.department || undefined, cost_centre: r.cost_centre || undefined,
      }))

      const res = await fetch('/api/tmc/create-corporate/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client: {
            ...form,
            client_groupId: form.client_groupId || null,
            policyGroupId: form.policyGroupId || null,
            // Label falls back to the code so a ladder built by holding Tab is
            // submittable without typing a description for every rung.
            bands: bands.map(b => ({
              code: b.code.trim(),
              label: b.label.trim() || b.code.trim(),
              rank: Number(b.rank),
            })),
          },
          employees: employeesPayload,
        }),
      })
      const data = await res.json()

      if (!res.ok) {
        setFormError(data.error || 'Something went wrong.')
        return
      }

      const empSummary = employeesPayload.length > 0
        ? ` ${data.employeesCreated} of ${employeesPayload.length} employees added.`
        : ''
      setFormSuccess(`"${form.corporateName}" created. Invite sent to ${form.adminEmail}.${empSummary}`)
      resetForm()
      setShowInviteForm(false)

      const clientsData = await fetch('/api/tmc/clients').then(r => r.json())
      if (clientsData.ok) setClients(clientsData.clients)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <>
      {/* Main */}
      <div style={s.mainInner}>
        <div style={s.topBar}>
          <div>
            <h1 style={s.heading}>Welcome, {firstName}</h1>
            <p style={s.sub}>Manage your corporate clients from here.</p>
          </div>
          {canCreateClient && (
            <button onClick={() => { setShowInviteForm(true); setFormError(''); setFormSuccess('') }} style={s.primaryBtn}>
              + Add client
            </button>
          )}
        </div>

        {formSuccess && <div style={s.successBanner}>✓ {formSuccess}</div>}

        {showInviteForm && canCreateClient && (
          <form onSubmit={handleSubmit} style={s.formCard}>
            <div style={s.formHeader}>
              <h2 style={s.formTitle}>Add a client</h2>
              <button type="button" onClick={() => { setShowInviteForm(false); resetForm() }} style={s.closeBtn}>✕</button>
            </div>
            <p style={s.formSub}>
              We'll create the client, seed default bands, and send the admin an invite.
              Optionally upload a CSV to add their employee roster at the same time.
            </p>

            {/* ── client_group ── */}
            <SectionLabel>Client group</SectionLabel>
            <div style={s.fields}>
              <div style={s.field}>
                <label style={s.label}>Assign to client group</label>
                {client_groups.length === 0 ? (
                  <p style={s.noclient_groupHint}>
                    No client groups yet — <a href="/tmc/configurations/client-groups" style={s.inlineLink}>create one</a> to group your clients, or leave unassigned.
                  </p>
                ) : (
                  <select name="client_groupId" value={form.client_groupId} onChange={handleFormChange} style={s.input}>
                    <option value="">Unassigned</option>
                    {client_groups.map(b => (
                      <option key={b.id} value={b.id}>{b.name}{b.city ? ` — ${b.city}` : ''}</option>
                    ))}
                  </select>
                )}
              </div>
            </div>

            {/* ── Client basics ── */}
            <SectionLabel>Client</SectionLabel>
            <div style={s.fields}>
              <Field label="Client name" name="corporateName" value={form.corporateName} onChange={handleFormChange} required placeholder="Acme Corp" />
              <Field label="Industry" name="industry" value={form.industry} onChange={handleFormChange} placeholder="e.g. Manufacturing" />
              <div style={s.field}>
                <label style={s.label}>Client size</label>
                <select name="size" value={form.size} onChange={handleFormChange} style={s.input}>
                  <option value="">Select…</option>
                  {SIZES.map(sz => <option key={sz} value={sz}>{sz} employees</option>)}
                </select>
              </div>
              <div style={s.field}>
                <label style={s.label}>Booking mode</label>
                <select name="bookingMode" value={form.bookingMode} onChange={handleFormChange} style={s.input}>
                  {BOOKING_MODES.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
                </select>
              </div>
            </div>

            {/* ── Bands + policy ── */}
            <SectionLabel>Bands &amp; policy</SectionLabel>
            <BandLadderEditor bands={bands} onChange={setBands} disabled={submitting} />

            <div style={s.fields}>
              <div style={{ ...s.field, gridColumn: '1 / -1' }}>
                <label style={s.label}>Policy group (optional)</label>
                <select
                  name="policyGroupId"
                  value={form.policyGroupId}
                  onChange={handleFormChange}
                  style={s.input}
                >
                  <option value="">No policy group — assign later</option>
                  {policyGroups.map(g => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                      {g.code ? ` (${g.code})` : ''}
                      {g.bandRanks.length > 0 ? ` — ranks ${g.bandRanks.join(', ')}` : ' — no ranks yet'}
                    </option>
                  ))}
                </select>
                <p style={s.fieldHint}>
                  Reuses one of your existing policy templates. Without one, this
                  client&apos;s bookings are not checked against any policy until a
                  group is linked.
                </p>
              </div>
            </div>

            {/* ── Registration details ── */}
            <SectionLabel>Registration details</SectionLabel>
            <div style={s.fields}>
              <Field label="Registered address" name="registeredAddress" value={form.registeredAddress} onChange={handleFormChange} placeholder="Street, city, state" wide />
              <Field label="GST / Tax ID" name="gstNumber" value={form.gstNumber} onChange={handleFormChange} placeholder="22AAAAA0000A1Z5" />
              <Field label="Primary contact phone" name="primaryContactPhone" value={form.primaryContactPhone} onChange={handleFormChange} placeholder="+91 98765 43210" />
            </div>

            {/* ── Admin ── */}
            <SectionLabel>Corporate admin</SectionLabel>
            <div style={s.fields}>
              <Field label="Admin full name" name="adminName" value={form.adminName} onChange={handleFormChange} required placeholder="Jane Smith" />
              <Field label="Admin work email" name="adminEmail" value={form.adminEmail} onChange={handleFormChange} required type="email" placeholder="jane@acmecorp.com" />
            </div>

            {/* ── Employee CSV ── */}
            <SectionLabel>Employee roster (optional)</SectionLabel>
            <div style={s.csvUploadBox}>
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv"
                onChange={handleCsvUpload}
                style={s.fileInput}
              />
              <p style={s.csvHint}>
                CSV columns: <code>email, full_name, role, band, department, cost_centre</code>.
                Role defaults to "employee", band defaults to "L1" if omitted. Max {MAX_EMPLOYEES} rows.
              </p>
              {csvFileName && !csvError && (
                <div style={s.csvSummary}>
                  <span>{csvFileName} — {validatedCsvRows.length} rows</span>
                  {validCsvCount > 0 && <span style={s.csvOk}>{validCsvCount} valid</span>}
                  {invalidCsvCount > 0 && <span style={s.csvBad}>{invalidCsvCount} invalid</span>}
                </div>
              )}
              {csvError && <p style={s.error}>{csvError}</p>}

              {validatedCsvRows.length > 0 && (
                <div style={s.csvPreviewWrap}>
                  <table style={s.csvTable}>
                    <thead>
                      <tr>
                        {['Email', 'Name', 'Role', 'Band', 'Status'].map(h => (
                          <th key={h} style={s.csvTh}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {validatedCsvRows.slice(0, 20).map((row, i) => (
                        <tr key={i} style={{ background: row._valid ? 'transparent' : '#FEF2F2' }}>
                          <td style={s.csvTd}>{row.email || '—'}</td>
                          <td style={s.csvTd}>{row.full_name || '—'}</td>
                          <td style={s.csvTd}>{row.role}</td>
                          <td style={s.csvTd}>{row.band}</td>
                          <td style={s.csvTd}>
                            {row._valid
                              ? <span style={s.csvOk}>✓ valid</span>
                              : <span style={s.csvBad}>{row._error}</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {validatedCsvRows.length > 20 && (
                    <p style={s.csvMoreNote}>+ {validatedCsvRows.length - 20} more rows not shown</p>
                  )}
                </div>
              )}
            </div>

            {formError && <p style={s.error}>{formError}</p>}

            <div style={s.formActions}>
              <button type="button" onClick={() => { setShowInviteForm(false); resetForm() }} style={s.ghostBtn}>
                Cancel
              </button>
              <button type="submit" disabled={submitting} style={{ ...s.primaryBtn, opacity: submitting ? 0.7 : 1 }}>
                {submitting ? 'Creating…' : 'Create client →'}
              </button>
            </div>
          </form>
        )}

        {/* The client list itself lives in the nav and on /tmc/clients. What
            belongs here is how the portfolio is performing, which a list of
            names never answered. */}
        <DashboardStats />
      </div>
    </>
  )
}

// ── DashboardStats ───────────────────────────────────────────────────────────
// Booking activity across the portfolio. Loads independently of the rest of the
// dashboard so a slow aggregate never holds up the create-client form.
// ─────────────────────────────────────────────────────────────────────────────

interface ClientStat {
  clientId: string
  name: string
  employees: number
  bookings: number
  recentBookings: number
  spend: number
  lastBookingAt: string | null
}

interface Totals {
  clients: number
  activeClients: number
  employees: number
  bookings: number
  recentBookings: number
  spend: number
  maxBookings: number
  minBookings: number
  avgBookings: number
}

function DashboardStats() {
  const [totals, setTotals] = useState<Totals | null>(null)
  const [clients, setClients] = useState<ClientStat[]>([])
  const [trend, setTrend] = useState<{ weekStart: string; bookings: number }[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false

    fetch('/api/tmc/stats')
      .then(r => r.json())
      .then(d => {
        if (cancelled) return
        if (!d.ok) { setError(d.error || 'Could not load statistics.'); return }
        setTotals(d.totals); setClients(d.clients); setTrend(d.trend)
      })
      .catch(() => { if (!cancelled) setError('Could not load statistics.') })
      .finally(() => { if (!cancelled) setLoading(false) })

    return () => { cancelled = true }
  }, [])

  if (loading) {
    return (
      <div style={st.loadingWrap}>
        <div style={st.spinner} />
        <p style={st.muted}>Crunching booking activity…</p>
      </div>
    )
  }

  if (error) return <div style={st.errorBanner}>⚠ {error}</div>
  if (!totals) return null

  const peak = Math.max(1, ...trend.map(t => t.bookings))
  const busiest = clients[0]
  const dormant = clients.filter(c => c.bookings === 0)

  return (
    <>
      <div style={st.tiles}>
        <Tile label="Clients" value={totals.clients} sub={`${totals.activeClients} have booked`} />
        <Tile label="Travellers" value={totals.employees} sub="across all clients" />
        <Tile label="Bookings" value={totals.bookings} sub={`${totals.recentBookings} in the last 30 days`} />
        <Tile
          label="Booking spend"
          value={`₹${Math.round(totals.spend).toLocaleString('en-IN')}`}
          sub="all time"
        />
      </div>

      <div style={st.tiles}>
        <Tile label="Busiest client" value={totals.maxBookings} sub={busiest?.name ?? '—'} />
        <Tile
          label="Average per active client"
          value={totals.avgBookings}
          sub="clients with no bookings excluded"
        />
        <Tile
          label="Quietest active client"
          value={clients.filter(c => c.bookings > 0).slice(-1)[0]?.bookings ?? 0}
          sub={clients.filter(c => c.bookings > 0).slice(-1)[0]?.name ?? '—'}
        />
        <Tile
          label="Yet to book"
          value={dormant.length}
          sub={dormant.length > 0 ? 'worth a nudge' : 'everyone is active'}
          warn={dormant.length > 0}
        />
      </div>

      <div style={st.section}>
        <h2 style={st.sectionTitle}>Bookings over the last 8 weeks</h2>
        {/* Deliberately a plain bar row rather than a chart library — it is one
            series of eight numbers, and a dependency would outweigh it. */}
        <div style={st.chart}>
          {trend.map(week => (
            <div key={week.weekStart} style={st.barCol} title={`${week.bookings} bookings`}>
              <div style={st.barTrack}>
                <div style={{ ...st.bar, height: `${(week.bookings / peak) * 100}%` }} />
              </div>
              <span style={st.barValue}>{week.bookings}</span>
              <span style={st.barLabel}>
                {new Date(week.weekStart).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div style={st.section}>
        <h2 style={st.sectionTitle}>By client</h2>
        {clients.length === 0 ? (
          <p style={st.muted}>No clients yet.</p>
        ) : (
          <div style={st.tableWrap}>
            <table style={st.table}>
              <thead>
                <tr>
                  {['Client', 'Travellers', 'Bookings', 'Last 30d', 'Spend', 'Last booking'].map(h => (
                    <th key={h} style={st.th}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {clients.map(c => (
                  <tr
                    key={c.clientId}
                    onClick={() => { window.location.href = `/tmc/clients/${c.clientId}` }}
                    style={st.tr}
                  >
                    <td style={{ ...st.td, fontWeight: 500, color: '#111827' }}>{c.name}</td>
                    <td style={st.td}>{c.employees}</td>
                    <td style={st.td}>
                      <div style={st.barCell}>
                        <span style={st.barCellValue}>{c.bookings}</span>
                        <div style={st.miniTrack}>
                          <div style={{
                            ...st.miniBar,
                            width: `${totals.maxBookings ? (c.bookings / totals.maxBookings) * 100 : 0}%`,
                          }} />
                        </div>
                      </div>
                    </td>
                    <td style={st.td}>{c.recentBookings}</td>
                    <td style={st.td}>₹{Math.round(c.spend).toLocaleString('en-IN')}</td>
                    <td style={{ ...st.td, color: '#9CA3AF', fontSize: 12 }}>
                      {c.lastBookingAt
                        ? new Date(c.lastBookingAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
                        : 'Never'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  )
}

function Tile({ label, value, sub, warn }: {
  label: string
  value: string | number
  sub?: string
  warn?: boolean
}) {
  return (
    <div style={{ ...st.tile, borderColor: warn ? '#FDE68A' : '#E5E7EB' }}>
      <span style={st.tileLabel}>{label}</span>
      <span style={{ ...st.tileValue, color: warn ? '#92400E' : '#0A0A14' }}>{value}</span>
      {sub && <span style={st.tileSub}>{sub}</span>}
    </div>
  )
}

const st: Record<string, React.CSSProperties> = {
  tiles: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 12, marginBottom: 14 },
  tile: { background: '#fff', border: '1px solid', borderRadius: 10, padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 3 },
  tileLabel: { fontSize: 11, fontWeight: 600, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.5px' },
  tileValue: { fontSize: 24, fontWeight: 700, letterSpacing: '-0.5px' },
  tileSub: { fontSize: 11, color: '#9CA3AF' },

  section: { background: '#fff', border: '1px solid #E5E7EB', borderRadius: 12, padding: 20, marginTop: 16 },
  sectionTitle: { fontSize: 14, fontWeight: 600, color: '#111827', margin: '0 0 16px' },

  chart: { display: 'flex', gap: 10, alignItems: 'flex-end', height: 150 },
  barCol: { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5, height: '100%' },
  barTrack: { flex: 1, width: '100%', display: 'flex', alignItems: 'flex-end', background: '#F9FAFB', borderRadius: 5, overflow: 'hidden' },
  bar: { width: '100%', background: '#000835', borderRadius: '5px 5px 0 0', minHeight: 2, transition: 'height 0.25s' },
  barValue: { fontSize: 11, fontWeight: 700, color: '#374151' },
  barLabel: { fontSize: 10, color: '#9CA3AF', whiteSpace: 'nowrap' },

  tableWrap: { overflowX: 'auto' },
  table: { borderCollapse: 'collapse', width: '100%' },
  th: { padding: '9px 12px', textAlign: 'left', background: '#F9FAFB', borderBottom: '1px solid #E5E7EB', fontSize: 11, fontWeight: 600, color: '#374151', whiteSpace: 'nowrap' },
  tr: { borderBottom: '1px solid #F3F4F6', cursor: 'pointer' },
  td: { padding: '9px 12px', fontSize: 13, color: '#374151' },
  barCell: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 110 },
  barCellValue: { fontSize: 13, fontWeight: 600, color: '#111827', minWidth: 26 },
  miniTrack: { flex: 1, height: 6, background: '#F3F4F6', borderRadius: 3, overflow: 'hidden' },
  miniBar: { height: '100%', background: '#000835', borderRadius: 3 },

  loadingWrap: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, padding: 60 },
  spinner: { width: 24, height: 24, border: '2.5px solid #E5E7EB', borderTopColor: '#000835', borderRadius: '50%', animation: 'spin 0.7s linear infinite' },
  muted: { fontSize: 12, color: '#9CA3AF', margin: 0 },
  errorBanner: { background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8, padding: '10px 14px', fontSize: 12, color: '#DC2626' },
}

// ── Small field helpers ─────────────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <p style={s.sectionLabel}>{children}</p>
}

function Field({ label, name, value, onChange, required, type = 'text', placeholder, wide }: {
  label: string
  name: string
  value: string
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void
  required?: boolean
  type?: string
  placeholder?: string
  wide?: boolean
}) {
  return (
    <div style={{ ...s.field, gridColumn: wide ? '1 / -1' : undefined }}>
      <label style={s.label}>{label}</label>
      <input
        name={name} type={type} required={required}
        value={value} onChange={onChange}
        placeholder={placeholder} style={s.input}
      />
    </div>
  )
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  mainInner: { padding: '40px 48px' },
  topBar: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '24px' },
  heading: { fontSize: '22px', fontWeight: 700, color: '#0A0A14', margin: '0 0 4px', letterSpacing: '-0.3px' },
  sub: { fontSize: '14px', color: '#6B7280', margin: 0 },
  primaryBtn: { height: '38px', padding: '0 16px', backgroundColor: '#000835', color: '#fff', fontSize: '13px', fontWeight: 600, border: 'none', borderRadius: '8px', cursor: 'pointer' },
  successBanner: { backgroundColor: '#ECFDF5', border: '1px solid #A7F3D0', borderRadius: '8px', padding: '12px 16px', fontSize: '13px', color: '#065F46', marginBottom: '20px' },
  formCard: { backgroundColor: '#fff', border: '1px solid #E5E7EB', borderRadius: '12px', padding: '24px', marginBottom: '24px' },
  formHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' },
  formTitle: { fontSize: '16px', fontWeight: 600, color: '#111827', margin: 0 },
  closeBtn: { backgroundColor: 'transparent', border: 'none', color: '#9CA3AF', fontSize: '16px', cursor: 'pointer' },
  formSub: { fontSize: '13px', color: '#6B7280', margin: '0 0 18px', lineHeight: '1.5' },
  noclient_groupHint: { fontSize: '12px', color: '#9CA3AF', margin: 0, lineHeight: '1.5' },
  inlineLink: { color: '#000835', fontWeight: 600, textDecoration: 'underline' },
  sectionLabel: { fontSize: '11px', fontWeight: 700, color: '#9CA3AF', textTransform: 'uppercase' as const, letterSpacing: '0.5px', margin: '18px 0 10px' },
  fields: { display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '14px' },
  field: { display: 'flex', flexDirection: 'column', gap: '6px' },
  fieldHint: { fontSize: '11px', color: '#9CA3AF', margin: 0, lineHeight: 1.5 },
  label: { fontSize: '12px', fontWeight: 500, color: '#374151' },
  input: { height: '38px', padding: '0 10px', fontSize: '13px', color: '#111827', backgroundColor: '#F9FAFB', border: '1px solid #E5E7EB', borderRadius: '7px', outline: 'none' },
  error: { fontSize: '13px', color: '#DC2626', backgroundColor: '#FEF2F2', border: '1px solid #FECACA', borderRadius: '6px', padding: '10px 12px', margin: '14px 0 0' },
  formActions: { display: 'flex', gap: '10px', justifyContent: 'flex-end', marginTop: '20px' },
  ghostBtn: { height: '38px', padding: '0 16px', backgroundColor: 'transparent', color: '#6B7280', fontSize: '13px', border: '1px solid #D1D5DB', borderRadius: '8px', cursor: 'pointer' },
  csvUploadBox: { background: '#F9FAFB', border: '1px dashed #D1D5DB', borderRadius: '8px', padding: '14px' },
  fileInput: { fontSize: '12px', marginBottom: '8px' },
  csvHint: { fontSize: '11px', color: '#9CA3AF', margin: '0 0 8px', lineHeight: '1.5' },
  csvSummary: { display: 'flex', gap: '10px', alignItems: 'center', fontSize: '12px', color: '#374151', marginBottom: '10px' },
  csvOk: { color: '#065F46', fontWeight: 600, fontSize: '11px' },
  csvBad: { color: '#DC2626', fontWeight: 600, fontSize: '11px' },
  csvPreviewWrap: { maxHeight: '220px', overflowY: 'auto' as const, border: '1px solid #E5E7EB', borderRadius: '6px', background: '#fff' },
  csvTable: { width: '100%', borderCollapse: 'collapse' as const },
  csvTh: { padding: '6px 10px', textAlign: 'left' as const, fontSize: '10px', fontWeight: 600, color: '#9CA3AF', textTransform: 'uppercase' as const, background: '#F9FAFB', borderBottom: '1px solid #E5E7EB', position: 'sticky' as const, top: 0 },
  csvTd: { padding: '6px 10px', fontSize: '12px', color: '#374151', borderBottom: '1px solid #F3F4F6' },
  csvMoreNote: { fontSize: '11px', color: '#9CA3AF', padding: '8px 10px', margin: 0 },
  section: { backgroundColor: '#fff', border: '1px solid #E5E7EB', borderRadius: '10px', overflow: 'hidden' },
  sectionHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 20px', borderBottom: '1px solid #F3F4F6' },
  sectionTitle: { fontSize: '14px', fontWeight: 600, color: '#111827', margin: 0 },
  sectionCount: { fontSize: '12px', color: '#9CA3AF' },
  table: { width: '100%', borderCollapse: 'collapse' as const },
  th: { padding: '10px 20px', textAlign: 'left' as const, fontSize: '11px', fontWeight: 600, color: '#9CA3AF', textTransform: 'uppercase' as const, letterSpacing: '0.5px', backgroundColor: '#F9FAFB', borderBottom: '1px solid #F3F4F6' },
  td: { padding: '14px 20px', fontSize: '13px', color: '#374151', borderBottom: '1px solid #F9FAFB' },
  clientName: { fontWeight: 500, color: '#111827' },
  badge: { display: 'inline-block', padding: '2px 8px', borderRadius: '4px', fontSize: '11px', fontWeight: 500 },
  emptyState: { padding: '48px 20px', textAlign: 'center' as const },
  emptyTitle: { fontSize: '14px', fontWeight: 600, color: '#374151', margin: '0 0 6px' },
  emptyDesc: { fontSize: '13px', color: '#9CA3AF', margin: 0 },
}