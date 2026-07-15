'use client'

import { useEffect, useState } from 'react'

interface Employee {
  id: string
  full_name: string
  email: string
  role: 'admin' | 'manager' | 'finance' | 'employee'
  status: string
  band_code: string | null
  department: string | null
  onboarding_method: string | null
}

const ROLES = ['employee', 'manager', 'finance', 'admin'] as const
const STATUS_COLORS: Record<string, { bg: string; fg: string }> = {
  active:      { bg: '#ECFDF5', fg: '#065F46' },
  invited:     { bg: '#FEF3C7', fg: '#92400E' },
  deactivated: { bg: '#F3F4F6', fg: '#6B7280' },
}

type Mode = 'list' | 'invite' | 'direct'

export default function SettingsUsersPage() {
  const [employees, setEmployees] = useState<Employee[]>([])
  const [loading, setLoading] = useState(true)
  const [mode, setMode] = useState<Mode>('list')
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  useEffect(() => {
    loadEmployees()
  }, [])

  async function loadEmployees() {
    setLoading(true)
    try {
      const res = await fetch('/api/settings/users')
      const data = await res.json()
      if (data.ok) setEmployees(data.employees)
    } finally {
      setLoading(false)
    }
  }

  async function handleRoleChange(id: string, role: string) {
    setError(''); setSuccess('')
    const res = await fetch(`/api/settings/users/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role }),
    })
    const data = await res.json()
    if (!res.ok) { setError(data.error || 'Could not update role.'); return }
    setEmployees(prev => prev.map(e => e.id === id ? { ...e, role: data.employee.role } : e))
    setSuccess('Role updated.')
  }

  async function handleBandChange(id: string, band: string) {
    setError(''); setSuccess('')
    const res = await fetch(`/api/settings/users/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ band }),
    })
    const data = await res.json()
    if (!res.ok) { setError(data.error || 'Could not update band.'); return }
    setEmployees(prev => prev.map(e => e.id === id ? { ...e, band_code: data.employee.band_code } : e))
    setSuccess('Band updated.')
  }

  async function handleStatusToggle(emp: Employee) {
    const newStatus = emp.status === 'active' ? 'deactivated' : 'active'
    setError(''); setSuccess('')
    const res = await fetch(`/api/settings/users/${emp.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: newStatus }),
    })
    const data = await res.json()
    if (!res.ok) { setError(data.error || 'Could not update status.'); return }
    setEmployees(prev => prev.map(e => e.id === emp.id ? { ...e, status: data.employee.status } : e))
    setSuccess(newStatus === 'deactivated' ? 'User deactivated.' : 'User reactivated.')
  }

  return (
    <div style={s.root}>
      <div style={s.header}>
        <div>
          <h1 style={s.heading}>Users</h1>
          <p style={s.sub}>{employees.length} {employees.length === 1 ? 'person' : 'people'} in your company.</p>
        </div>
        <div style={s.headerBtns}>
          <button onClick={() => setMode('direct')} style={s.ghostBtn}>+ Add directly</button>
          <button onClick={() => setMode('invite')} style={s.primaryBtn}>+ Invite by email</button>
        </div>
      </div>

      {success && <div style={s.successBanner}>✓ {success}</div>}
      {error && <div style={s.errorBanner}>✕ {error}</div>}

      {mode === 'invite' && (
        <InviteForm
          onClose={() => setMode('list')}
          onDone={() => { setMode('list'); loadEmployees(); setSuccess('Invite sent.') }}
          onError={setError}
        />
      )}

      {mode === 'direct' && (
        <DirectAddForm
          onClose={() => setMode('list')}
          onDone={() => { setMode('list'); loadEmployees(); setSuccess('Employee added.') }}
          onError={setError}
        />
      )}

      <div style={s.card}>
        {loading ? (
          <div style={s.emptyState}><p style={s.emptyTitle}>Loading…</p></div>
        ) : employees.length === 0 ? (
          <div style={s.emptyState}>
            <p style={s.emptyTitle}>No employees yet</p>
            <p style={s.emptyDesc}>Invite your first team member using the button above.</p>
          </div>
        ) : (
          <table style={s.table}>
            <thead>
              <tr>
                {['Name', 'Email', 'Role', 'Band', 'Status', ''].map(h => (
                  <th key={h} style={s.th}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {employees.map((emp, i) => {
                const colors = STATUS_COLORS[emp.status] ?? STATUS_COLORS.active
                return (
                  <tr key={emp.id} style={{ background: i % 2 === 0 ? '#fff' : '#FAFAFA' }}>
                    <td style={s.td}><span style={s.name}>{emp.full_name}</span></td>
                    <td style={{ ...s.td, color: '#6B7280' }}>{emp.email}</td>
                    <td style={s.td}>
                      <select
                        value={emp.role}
                        onChange={e => handleRoleChange(emp.id, e.target.value)}
                        disabled={emp.status === 'deactivated'}
                        style={s.roleSelect}
                      >
                        {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
                      </select>
                    </td>
                    <td style={s.td}>
                      <select
                        value={emp.band_code ?? 'L1'}
                        onChange={e => handleBandChange(emp.id, e.target.value)}
                        disabled={emp.status === 'deactivated'}
                        style={s.roleSelect}
                      >
                        {['L1', 'L2', 'L3', 'L4', 'L5'].map(b => <option key={b} value={b}>{b}</option>)}
                      </select>
                    </td>
                    <td style={s.td}>
                      <span style={{ ...s.badge, background: colors.bg, color: colors.fg }}>
                        {emp.status}
                      </span>
                    </td>
                    <td style={{ ...s.td, textAlign: 'right' as const }}>
                      {emp.status !== 'invited' && (
                        <button
                          onClick={() => handleStatusToggle(emp)}
                          style={emp.status === 'active' ? s.deactivateBtn : s.reactivateBtn}
                        >
                          {emp.status === 'active' ? 'Deactivate' : 'Reactivate'}
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

// ── Invite form ───────────────────────────────────────────────────────────────

function InviteForm({ onClose, onDone, onError }: {
  onClose: () => void
  onDone: () => void
  onError: (msg: string) => void
}) {
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<typeof ROLES[number]>('employee')
  const [band, setBand] = useState('L1')
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    try {
      const res = await fetch('/api/setup/invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invites: [{ email, role, band }] }),
      })
      const data = await res.json()
      if (!res.ok) { onError(data.error || 'Could not send invite.'); return }
      const result = data.results?.[0]
      if (result?.status === 'failed') { onError(result.error); return }
      onDone()
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} style={s.formCard}>
      <div style={s.formHeader}>
        <h2 style={s.formTitle}>Invite by email</h2>
        <button type="button" onClick={onClose} style={s.closeBtn}>✕</button>
      </div>
      <p style={s.formSub}>They'll receive an email invite to set their own password.</p>
      <div style={s.fields}>
        <div style={s.field}>
          <label style={s.label}>Email</label>
          <input type="email" required value={email} onChange={e => setEmail(e.target.value)} placeholder="jane@company.com" style={s.input} />
        </div>
        <div style={s.field}>
          <label style={s.label}>Role</label>
          <select value={role} onChange={e => setRole(e.target.value as typeof ROLES[number])} style={s.input}>
            {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>
        <div style={s.field}>
          <label style={s.label}>Band</label>
          <select value={band} onChange={e => setBand(e.target.value)} style={s.input}>
            {['L1', 'L2', 'L3', 'L4', 'L5'].map(b => <option key={b} value={b}>{b}</option>)}
          </select>
        </div>
      </div>
      <div style={s.formActions}>
        <button type="button" onClick={onClose} style={s.ghostBtn}>Cancel</button>
        <button type="submit" disabled={submitting} style={{ ...s.primaryBtn, opacity: submitting ? 0.7 : 1 }}>
          {submitting ? 'Sending…' : 'Send invite →'}
        </button>
      </div>
    </form>
  )
}

// ── Direct add form ───────────────────────────────────────────────────────────

function DirectAddForm({ onClose, onDone, onError }: {
  onClose: () => void
  onDone: () => void
  onError: (msg: string) => void
}) {
  const [form, setForm] = useState({
    email: '', full_name: '', role: 'employee' as typeof ROLES[number], band: 'L1',
    department: '', cost_centre: '', send_welcome_email: true,
  })
  const [submitting, setSubmitting] = useState(false)

  function handleChange(e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) {
    const { name, value, type } = e.target
    const checked = (e.target as HTMLInputElement).checked
    setForm(prev => ({ ...prev, [name]: type === 'checkbox' ? checked : value }))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    try {
      const res = await fetch('/api/employees', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      const data = await res.json()
      if (!res.ok) { onError(data.error || 'Could not add employee.'); return }
      onDone()
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} style={s.formCard}>
      <div style={s.formHeader}>
        <h2 style={s.formTitle}>Add directly</h2>
        <button type="button" onClick={onClose} style={s.closeBtn}>✕</button>
      </div>
      <p style={s.formSub}>No invite email required — the account is active immediately.</p>
      <div style={s.fields}>
        <div style={s.field}>
          <label style={s.label}>Full name</label>
          <input name="full_name" type="text" required value={form.full_name} onChange={handleChange} placeholder="Jane Smith" style={s.input} />
        </div>
        <div style={s.field}>
          <label style={s.label}>Email</label>
          <input name="email" type="email" required value={form.email} onChange={handleChange} placeholder="jane@company.com" style={s.input} />
        </div>
        <div style={s.field}>
          <label style={s.label}>Role</label>
          <select name="role" value={form.role} onChange={handleChange} style={s.input}>
            {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>
        <div style={s.field}>
          <label style={s.label}>Band</label>
          <select name="band" value={form.band} onChange={handleChange} style={s.input}>
            {['L1', 'L2', 'L3', 'L4', 'L5'].map(b => <option key={b} value={b}>{b}</option>)}
          </select>
        </div>
        <div style={s.field}>
          <label style={s.label}>Department (optional)</label>
          <input name="department" type="text" value={form.department} onChange={handleChange} style={s.input} />
        </div>
        <div style={s.field}>
          <label style={s.label}>Cost centre (optional)</label>
          <input name="cost_centre" type="text" value={form.cost_centre} onChange={handleChange} style={s.input} />
        </div>
      </div>
      <label style={s.checkboxRow}>
        <input
          type="checkbox"
          name="send_welcome_email"
          checked={form.send_welcome_email}
          onChange={handleChange}
        />
        Send password setup email
      </label>
      <div style={s.formActions}>
        <button type="button" onClick={onClose} style={s.ghostBtn}>Cancel</button>
        <button type="submit" disabled={submitting} style={{ ...s.primaryBtn, opacity: submitting ? 0.7 : 1 }}>
          {submitting ? 'Adding…' : 'Add employee →'}
        </button>
      </div>
    </form>
  )
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  root: { fontFamily: "'Inter', -apple-system, sans-serif" },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '16px' },
  heading: { fontSize: '20px', fontWeight: 600, color: '#0A0A14', margin: '0 0 4px', letterSpacing: '-0.3px' },
  sub: { fontSize: '13px', color: '#6B7280', margin: 0 },
  headerBtns: { display: 'flex', gap: '10px' },
  primaryBtn: { height: '36px', padding: '0 14px', background: '#000835', color: '#fff', fontSize: '13px', fontWeight: 600, border: 'none', borderRadius: '7px', cursor: 'pointer' },
  ghostBtn: { height: '36px', padding: '0 14px', background: 'transparent', color: '#6B7280', fontSize: '13px', border: '1px solid #D1D5DB', borderRadius: '7px', cursor: 'pointer' },
  successBanner: { background: '#ECFDF5', border: '1px solid #A7F3D0', borderRadius: '8px', padding: '10px 14px', fontSize: '12px', color: '#065F46', marginBottom: '16px' },
  errorBanner: { background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: '8px', padding: '10px 14px', fontSize: '12px', color: '#DC2626', marginBottom: '16px' },
  formCard: { background: '#fff', border: '1px solid #E5E7EB', borderRadius: '10px', padding: '20px', marginBottom: '20px' },
  formHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' },
  formTitle: { fontSize: '15px', fontWeight: 600, color: '#111827', margin: 0 },
  closeBtn: { background: 'transparent', border: 'none', color: '#9CA3AF', fontSize: '16px', cursor: 'pointer' },
  formSub: { fontSize: '12px', color: '#6B7280', margin: '0 0 16px' },
  fields: { display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '14px', marginBottom: '14px' },
  field: { display: 'flex', flexDirection: 'column', gap: '5px' },
  label: { fontSize: '11px', fontWeight: 500, color: '#374151' },
  input: { height: '36px', padding: '0 10px', fontSize: '13px', color: '#111827', background: '#F9FAFB', border: '1px solid #E5E7EB', borderRadius: '6px', outline: 'none' },
  checkboxRow: { display: 'flex', alignItems: 'center', gap: '7px', fontSize: '12px', color: '#374151', marginBottom: '16px' },
  formActions: { display: 'flex', gap: '10px', justifyContent: 'flex-end' },
  card: { background: '#fff', border: '1px solid #E5E7EB', borderRadius: '10px', overflow: 'hidden' },
  table: { width: '100%', borderCollapse: 'collapse' as const },
  th: { padding: '10px 16px', textAlign: 'left' as const, fontSize: '11px', fontWeight: 600, color: '#9CA3AF', textTransform: 'uppercase' as const, letterSpacing: '0.4px', background: '#F9FAFB', borderBottom: '1px solid #F3F4F6' },
  td: { padding: '12px 16px', fontSize: '13px', color: '#374151', borderBottom: '1px solid #F9FAFB' },
  name: { fontWeight: 500, color: '#111827' },
  roleSelect: { fontSize: '12px', color: '#374151', padding: '4px 6px', border: '1px solid #E5E7EB', borderRadius: '5px', background: '#fff' },
  badge: { display: 'inline-block', padding: '2px 8px', borderRadius: '4px', fontSize: '11px', fontWeight: 500 },
  deactivateBtn: { fontSize: '11px', color: '#DC2626', background: 'transparent', border: '1px solid #FECACA', borderRadius: '5px', padding: '4px 8px', cursor: 'pointer' },
  reactivateBtn: { fontSize: '11px', color: '#065F46', background: 'transparent', border: '1px solid #A7F3D0', borderRadius: '5px', padding: '4px 8px', cursor: 'pointer' },
  emptyState: { padding: '48px 20px', textAlign: 'center' as const },
  emptyTitle: { fontSize: '14px', fontWeight: 600, color: '#374151', margin: '0 0 6px' },
  emptyDesc: { fontSize: '13px', color: '#9CA3AF', margin: 0 },
}