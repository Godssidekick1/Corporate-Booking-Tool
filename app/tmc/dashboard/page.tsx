'use client'

import { useEffect, useState } from 'react'

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

export default function TmcDashboardPage() {
  const [employee, setEmployee] = useState<Employee | null>(null)
  const [companies, setCompanies] = useState<Company[]>([])
  const [loading, setLoading] = useState(true)
  const [showInviteForm, setShowInviteForm] = useState(false)
  const [form, setForm] = useState({ corporateName: '', adminName: '', adminEmail: '' })
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState('')
  const [formSuccess, setFormSuccess] = useState('')

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

  function handleFormChange(e: React.ChangeEvent<HTMLInputElement>) {
    setForm(prev => ({ ...prev, [e.target.name]: e.target.value }))
  }

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault()
    setFormError('')
    setFormSuccess('')
    setSubmitting(true)

    try {
      const res = await fetch('/api/tmc/create-corporate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      const data = await res.json()

      if (!res.ok) {
        setFormError(data.error || 'Something went wrong.')
        return
      }

      setFormSuccess(`Invite sent to ${form.adminEmail}.`)
      setForm({ corporateName: '', adminName: '', adminEmail: '' })
      setShowInviteForm(false)

      // Refresh companies list
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
        {/* Top bar */}
        <div style={s.topBar}>
          <div>
            <h1 style={s.heading}>Welcome, {firstName}</h1>
            <p style={s.sub}>Manage your corporate clients from here.</p>
          </div>
          <button onClick={() => { setShowInviteForm(true); setFormError(''); setFormSuccess('') }} style={s.primaryBtn}>
            + Invite corporate
          </button>
        </div>

        {/* Success banner */}
        {formSuccess && (
          <div style={s.successBanner}>
            ✓ {formSuccess}
          </div>
        )}

        {/* Invite form */}
        {showInviteForm && (
          <div style={s.formCard}>
            <div style={s.formHeader}>
              <h2 style={s.formTitle}>Invite a corporate client</h2>
              <button onClick={() => setShowInviteForm(false)} style={s.closeBtn}>✕</button>
            </div>
            <p style={s.formSub}>
              We'll create the company, seed default bands, and send the admin an invite to complete setup.
            </p>
            <form onSubmit={handleInvite} style={s.form}>
              <div style={s.fields}>
                <div style={s.field}>
                  <label style={s.label}>Company name</label>
                  <input
                    name="corporateName" type="text" required
                    value={form.corporateName} onChange={handleFormChange}
                    placeholder="Acme Corp" style={s.input}
                  />
                </div>
                <div style={s.field}>
                  <label style={s.label}>Admin full name</label>
                  <input
                    name="adminName" type="text" required
                    value={form.adminName} onChange={handleFormChange}
                    placeholder="Jane Smith" style={s.input}
                  />
                </div>
                <div style={s.field}>
                  <label style={s.label}>Admin work email</label>
                  <input
                    name="adminEmail" type="email" required
                    value={form.adminEmail} onChange={handleFormChange}
                    placeholder="jane@acmecorp.com" style={s.input}
                  />
                </div>
              </div>
              {formError && <p style={s.error}>{formError}</p>}
              <div style={s.formActions}>
                <button type="button" onClick={() => setShowInviteForm(false)} style={s.ghostBtn}>
                  Cancel
                </button>
                <button type="submit" disabled={submitting} style={{ ...s.primaryBtn, opacity: submitting ? 0.7 : 1 }}>
                  {submitting ? 'Sending invite…' : 'Send invite →'}
                </button>
              </div>
            </form>
          </div>
        )}

        {/* Companies list */}
        <div style={s.section}>
          <div style={s.sectionHeader}>
            <h2 style={s.sectionTitle}>Your companies</h2>
            <span style={s.sectionCount}>{companies.length} total</span>
          </div>

          {loading ? (
            <div style={s.emptyState}>
              <p style={s.emptyTitle}>Loading…</p>
            </div>
          ) : companies.length === 0 ? (
            <div style={s.emptyState}>
              <p style={s.emptyTitle}>No companies yet</p>
              <p style={s.emptyDesc}>Invite your first corporate client using the button above.</p>
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
                    style={{
                      backgroundColor: i % 2 === 0 ? '#fff' : '#FAFAFA',
                      cursor: 'pointer',
                    }}
                  >
                    <td style={s.td}>
                      <span style={s.companyName}>{company.name}</span>
                    </td>
                    <td style={s.td}>
                      <span style={{
                        ...s.badge,
                        backgroundColor: company.status === 'active' ? '#ECFDF5' : '#FEF3C7',
                        color: company.status === 'active' ? '#065F46' : '#92400E',
                      }}>
                        {company.status}
                      </span>
                    </td>
                    <td style={s.td}>
                      <span style={{
                        ...s.badge,
                        backgroundColor: company.setup_completed ? '#ECFDF5' : '#F3F4F6',
                        color: company.setup_completed ? '#065F46' : '#6B7280',
                      }}>
                        {company.setup_completed ? 'Complete' : 'Pending'}
                      </span>
                    </td>
                    <td style={{ ...s.td, color: '#9CA3AF', fontSize: '12px' }}>
                      {new Date(company.created_at).toLocaleDateString('en-GB', {
                        day: 'numeric', month: 'short', year: 'numeric'
                      })}
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
  formSub: { fontSize: '13px', color: '#6B7280', margin: '0 0 20px', lineHeight: '1.5' },
  form: { display: 'flex', flexDirection: 'column', gap: '16px' },
  fields: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '16px' },
  field: { display: 'flex', flexDirection: 'column', gap: '6px' },
  label: { fontSize: '12px', fontWeight: 500, color: '#374151' },
  input: { height: '38px', padding: '0 10px', fontSize: '13px', color: '#111827', backgroundColor: '#F9FAFB', border: '1px solid #E5E7EB', borderRadius: '7px', outline: 'none' },
  error: { fontSize: '13px', color: '#DC2626', backgroundColor: '#FEF2F2', border: '1px solid #FECACA', borderRadius: '6px', padding: '10px 12px', margin: 0 },
  formActions: { display: 'flex', gap: '10px', justifyContent: 'flex-end' },
  ghostBtn: { height: '38px', padding: '0 16px', backgroundColor: 'transparent', color: '#6B7280', fontSize: '13px', border: '1px solid #D1D5DB', borderRadius: '8px', cursor: 'pointer' },
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