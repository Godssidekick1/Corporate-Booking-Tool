'use client'

import { useEffect, useState, useRef } from 'react'
import Papa from 'papaparse'

interface Employee {
  full_name: string
  email: string
  role: string
  tmc_id: string
}

interface Company {
  id: string
  name: string
  status: string
  setup_completed: boolean
  created_at: string
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
  size: '', bookingMode: 'sbt',
}

export default function TmcDashboardPage() {
  const [employee, setEmployee] = useState<Employee | null>(null)
  const [companies, setCompanies] = useState<Company[]>([])
  const [loading, setLoading] = useState(true)
  const [showInviteForm, setShowInviteForm] = useState(false)
  const [form, setForm] = useState(initialForm)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState('')
  const [formSuccess, setFormSuccess] = useState('')

  // CSV state
  const [csvRows, setCsvRows] = useState<CsvEmployeeRow[]>([])
  const [csvFileName, setCsvFileName] = useState('')
  const [csvError, setCsvError] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    Promise.all([
      fetch('/api/me').then(r => r.json()),
      fetch('/api/tmc/companies').then(r => r.json()),
    ]).then(([meData, companiesData]) => {
      if (meData.ok) setEmployee(meData.employee)
      if (companiesData.ok) setCompanies(companiesData.companies)
    }).finally(() => setLoading(false))
  }, [])

  const firstName = employee?.full_name?.split(' ')[0] ?? '…'

  function handleFormChange(e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) {
    setForm(prev => ({ ...prev, [e.target.name]: e.target.value }))
  }

  function resetForm() {
    setForm(initialForm)
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
          const band = (row.band || 'L1').trim().toUpperCase()
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

  const validCsvCount = csvRows.filter(r => r._valid).length
  const invalidCsvCount = csvRows.length - validCsvCount

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
      const employeesPayload = csvRows.filter(r => r._valid).map(r => ({
        email: r.email, full_name: r.full_name, role: r.role,
        band: r.band, department: r.department || undefined, cost_centre: r.cost_centre || undefined,
      }))

      const res = await fetch('/api/tmc/create-corporate/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ company: form, employees: employeesPayload }),
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

      const companiesData = await fetch('/api/tmc/companies').then(r => r.json())
      if (companiesData.ok) setCompanies(companiesData.companies)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div style={s.root}>
      {/* Sidebar */}
      <nav style={s.nav}>
        <div>
          <div style={s.wordmark}>
            <span style={s.wmMain}>TravelDesk</span>
            <span style={s.wmBy}>by Amadeus</span>
          </div>
          <p style={s.navLabel}>TMC Admin</p>
          {[
            { label: 'Dashboard', href: '/tmc/dashboard', active: true  },
            { label: 'Companies', href: '/tmc/dashboard', active: false },
            { label: 'Settings',  href: '/tmc/settings',  active: false },
            { label: 'Reports',   href: '/tmc/reports',   active: false },
          ].map(item => (
            <a key={item.label} href={item.href} style={{
              ...s.navItem,
              backgroundColor: item.active ? 'rgba(255,255,255,0.1)' : 'transparent',
              color: item.active ? '#fff' : 'rgba(255,255,255,0.5)',
              fontWeight: item.active ? 600 : 400,
            }}>
              {item.label}
            </a>
          ))}
        </div>
        <div style={s.navFooter}>
          <p style={s.userName}>{loading ? '…' : employee?.full_name ?? '—'}</p>
          <p style={s.userRole}>TMC Admin</p>
          <button
            onClick={async () => {
              await fetch('/api/auth/signout', { method: 'POST' })
              window.location.href = '/login'
            }}
            style={{ ...s.signOutBtn, marginTop: '10px' }}
          >
            Sign out
          </button>
        </div>
      </nav>

      {/* Main */}
      <main style={s.main}>
        <div style={s.topBar}>
          <div>
            <h1 style={s.heading}>Welcome, {firstName}</h1>
            <p style={s.sub}>Manage your corporate clients from here.</p>
          </div>
          <button onClick={() => { setShowInviteForm(true); setFormError(''); setFormSuccess('') }} style={s.primaryBtn}>
            + Add corporate
          </button>
        </div>

        {formSuccess && <div style={s.successBanner}>✓ {formSuccess}</div>}

        {showInviteForm && (
          <form onSubmit={handleSubmit} style={s.formCard}>
            <div style={s.formHeader}>
              <h2 style={s.formTitle}>Add a corporate client</h2>
              <button type="button" onClick={() => { setShowInviteForm(false); resetForm() }} style={s.closeBtn}>✕</button>
            </div>
            <p style={s.formSub}>
              We'll create the company, seed default bands, and send the admin an invite.
              Optionally upload a CSV to add their employee roster at the same time.
            </p>

            {/* ── Company basics ── */}
            <SectionLabel>Company</SectionLabel>
            <div style={s.fields}>
              <Field label="Company name" name="corporateName" value={form.corporateName} onChange={handleFormChange} required placeholder="Acme Corp" />
              <Field label="Industry" name="industry" value={form.industry} onChange={handleFormChange} placeholder="e.g. Manufacturing" />
              <div style={s.field}>
                <label style={s.label}>Company size</label>
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
                  <span>{csvFileName} — {csvRows.length} rows</span>
                  {validCsvCount > 0 && <span style={s.csvOk}>{validCsvCount} valid</span>}
                  {invalidCsvCount > 0 && <span style={s.csvBad}>{invalidCsvCount} invalid</span>}
                </div>
              )}
              {csvError && <p style={s.error}>{csvError}</p>}

              {csvRows.length > 0 && (
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
                      {csvRows.slice(0, 20).map((row, i) => (
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
                  {csvRows.length > 20 && (
                    <p style={s.csvMoreNote}>+ {csvRows.length - 20} more rows not shown</p>
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
                {submitting ? 'Creating…' : 'Create company →'}
              </button>
            </div>
          </form>
        )}

        <div style={s.section}>
          <div style={s.sectionHeader}>
            <h2 style={s.sectionTitle}>Your companies</h2>
            <span style={s.sectionCount}>{companies.length} total</span>
          </div>

          {loading ? (
            <div style={s.emptyState}><p style={s.emptyTitle}>Loading…</p></div>
          ) : companies.length === 0 ? (
            <div style={s.emptyState}>
              <p style={s.emptyTitle}>No companies yet</p>
              <p style={s.emptyDesc}>Add your first corporate client using the button above.</p>
            </div>
          ) : (
            <table style={s.table}>
              <thead>
                <tr>
                  {['Company', 'Status', 'Setup', 'Onboarded'].map(h => (
                    <th key={h} style={s.th}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {companies.map((company, i) => (
                  <tr
                    key={company.id}
                    onClick={() => { window.location.href = `/tmc/companies/${company.id}` }}
                    style={{ backgroundColor: i % 2 === 0 ? '#fff' : '#FAFAFA', cursor: 'pointer' }}
                  >
                    <td style={s.td}><span style={s.companyName}>{company.name}</span></td>
                    <td style={s.td}>
                      <span style={{
                        ...s.badge,
                        backgroundColor: company.status === 'active' ? '#ECFDF5' : '#FEF3C7',
                        color: company.status === 'active' ? '#065F46' : '#92400E',
                      }}>{company.status}</span>
                    </td>
                    <td style={s.td}>
                      <span style={{
                        ...s.badge,
                        backgroundColor: company.setup_completed ? '#ECFDF5' : '#F3F4F6',
                        color: company.setup_completed ? '#065F46' : '#6B7280',
                      }}>{company.setup_completed ? 'Complete' : 'Pending'}</span>
                    </td>
                    <td style={{ ...s.td, color: '#9CA3AF', fontSize: '12px' }}>
                      {new Date(company.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </main>
    </div>
  )
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
  root: { display: 'flex', minHeight: '100vh', fontFamily: "'Inter', -apple-system, sans-serif", backgroundColor: '#F7F8FC' },
  nav: { width: '220px', flexShrink: 0, backgroundColor: '#000835', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', padding: '32px 20px' },
  wordmark: { display: 'flex', flexDirection: 'column', gap: '3px', marginBottom: '28px' },
  wmMain: { fontSize: '18px', fontWeight: 700, color: '#fff', letterSpacing: '-0.4px' },
  wmBy: { fontSize: '10px', color: 'rgba(255,255,255,0.35)', letterSpacing: '0.5px', textTransform: 'uppercase' as const },
  navLabel: { fontSize: '9px', fontWeight: 600, color: 'rgba(255,255,255,0.28)', letterSpacing: '1.1px', textTransform: 'uppercase' as const, margin: '0 0 12px' },
  navItem: { display: 'block', padding: '9px 12px', borderRadius: '7px', fontSize: '13px', textDecoration: 'none', marginBottom: '2px' },
  navFooter: { borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: '16px' },
  userName: { fontSize: '12px', fontWeight: 600, color: '#fff', margin: '0 0 2px' },
  userRole: { fontSize: '11px', color: 'rgba(255,255,255,0.4)', margin: 0 },
  signOutBtn: { width: '100%', height: '32px', backgroundColor: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.45)', fontSize: '12px', border: 'none', borderRadius: '6px', cursor: 'pointer' },
  main: { flex: 1, padding: '40px 48px', overflowY: 'auto' as const },
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
  sectionLabel: { fontSize: '11px', fontWeight: 700, color: '#9CA3AF', textTransform: 'uppercase' as const, letterSpacing: '0.5px', margin: '18px 0 10px' },
  fields: { display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '14px' },
  field: { display: 'flex', flexDirection: 'column', gap: '6px' },
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
  companyName: { fontWeight: 500, color: '#111827' },
  badge: { display: 'inline-block', padding: '2px 8px', borderRadius: '4px', fontSize: '11px', fontWeight: 500 },
  emptyState: { padding: '48px 20px', textAlign: 'center' as const },
  emptyTitle: { fontSize: '14px', fontWeight: 600, color: '#374151', margin: '0 0 6px' },
  emptyDesc: { fontSize: '13px', color: '#9CA3AF', margin: 0 },
}