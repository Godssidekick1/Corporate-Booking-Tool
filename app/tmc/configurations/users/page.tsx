'use client'

import { useEffect, useState } from 'react'
import { PERMISSIONS } from '@/app/lib/permissions/permissionKeys'

interface Company {
  id: string
  name: string
}

interface Tc {
  id: string
  full_name: string
  email: string
  status: string
  created_at: string
  permissions: string[]
  companyIds: string[]
}

// PERMISSIONS now comes from the shared list. It used to be a third copy of the
// same keys, and had already drifted — this file labelled one of them
// "Manage client_groups", the raw column name, because nothing kept the three
// copies in step.

const STATUS_COLORS: Record<string, { bg: string; fg: string }> = {
  active:      { bg: '#ECFDF5', fg: '#065F46' },
  invited:     { bg: '#FEF3C7', fg: '#92400E' },
  deactivated: { bg: '#F3F4F6', fg: '#6B7280' },
}

type Mode = 'list' | 'create'

export default function TmcUsersPage() {
  const [tcs, setTcs] = useState<Tc[]>([])
  const [companies, setCompanies] = useState<Company[]>([])
  const [loading, setLoading] = useState(true)
  const [mode, setMode] = useState<Mode>('list')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  useEffect(() => {
    loadAll()
  }, [])

  async function loadAll() {
    setLoading(true)
    try {
      const [tcsRes, companiesRes] = await Promise.all([
        fetch('/api/tmc/tcs').then(r => r.json()),
        fetch('/api/tmc/companies').then(r => r.json()),
      ])
      if (tcsRes.ok) setTcs(tcsRes.tcs)
      if (companiesRes.ok) setCompanies(companiesRes.companies)
    } finally {
      setLoading(false)
    }
  }

  async function handleStatusToggle(tc: Tc) {
    const newStatus = tc.status === 'active' ? 'deactivated' : 'active'
    setError(''); setSuccess('')
    const res = await fetch(`/api/tmc/tcs/${tc.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: newStatus }),
    })
    const data = await res.json()
    if (!res.ok) { setError(data.error || 'Could not update status.'); return }
    setTcs(prev => prev.map(t => t.id === tc.id ? { ...t, status: newStatus } : t))
    setSuccess(newStatus === 'deactivated' ? 'TC deactivated.' : 'TC reactivated.')
  }

  const editingTc = tcs.find(t => t.id === editingId) ?? null

  return (
    <div style={s.root}>
      <div style={s.header}>
        <div>
          <h1 style={s.heading}>TMC users</h1>
          <p style={s.sub}>{tcs.length} travel counsellor{tcs.length === 1 ? '' : 's'} with access to your account.</p>
        </div>
        <button onClick={() => { setMode('create'); setError(''); setSuccess('') }} style={s.primaryBtn}>
          + Add TC
        </button>
      </div>

      {success && <div style={s.successBanner}>✓ {success}</div>}
      {error && <div style={s.errorBanner}>✕ {error}</div>}

      {mode === 'create' && (
        <TcForm
          companies={companies}
          onClose={() => setMode('list')}
          onDone={() => { setMode('list'); loadAll(); setSuccess('TC added.') }}
          onError={setError}
        />
      )}

      {editingTc && (
        <TcPermissionsEditor
          tc={editingTc}
          companies={companies}
          onClose={() => setEditingId(null)}
          onDone={() => { setEditingId(null); loadAll(); setSuccess('Permissions updated.') }}
          onError={setError}
        />
      )}

      <div style={s.card}>
        {loading ? (
          <div style={s.emptyState}><p style={s.emptyTitle}>Loading…</p></div>
        ) : tcs.length === 0 ? (
          <div style={s.emptyState}>
            <p style={s.emptyTitle}>No TCs yet</p>
            <p style={s.emptyDesc}>Add a travel counsellor using the button above.</p>
          </div>
        ) : (
          <table style={s.table}>
            <thead>
              <tr>
                {['Name', 'Email', 'Status', 'Permissions', 'Companies', ''].map(h => (
                  <th key={h} style={s.th}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {tcs.map((tc, i) => {
                const colors = STATUS_COLORS[tc.status] ?? STATUS_COLORS.active
                return (
                  <tr key={tc.id} style={{ background: i % 2 === 0 ? '#fff' : '#FAFAFA' }}>
                    <td style={s.td}><span style={s.name}>{tc.full_name}</span></td>
                    <td style={{ ...s.td, color: '#6B7280' }}>{tc.email}</td>
                    <td style={s.td}>
                      <span style={{ ...s.badge, background: colors.bg, color: colors.fg }}>{tc.status}</span>
                    </td>
                    <td style={s.td}>{tc.permissions.length} function{tc.permissions.length === 1 ? '' : 's'}</td>
                    <td style={s.td}>{tc.companyIds.length} compan{tc.companyIds.length === 1 ? 'y' : 'ies'}</td>
                    <td style={{ ...s.td, textAlign: 'right' as const, display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
                      {tc.status !== 'invited' && (
                        <button onClick={() => setEditingId(tc.id)} style={s.editBtn}>Edit access</button>
                      )}
                      <button
                        onClick={() => handleStatusToggle(tc)}
                        style={tc.status === 'active' ? s.deactivateBtn : s.reactivateBtn}
                      >
                        {tc.status === 'active' ? 'Deactivate' : 'Reactivate'}
                      </button>
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

// ── Create form ───────────────────────────────────────────────────────────────

function TcForm({ companies, onClose, onDone, onError }: {
  companies: Company[]
  onClose: () => void
  onDone: () => void
  onError: (msg: string) => void
}) {
  const [email, setEmail] = useState('')
  const [fullName, setFullName] = useState('')
  const [sendInvite, setSendInvite] = useState(true)
  const [permissions, setPermissions] = useState<string[]>([])
  const [companyIds, setCompanyIds] = useState<string[]>([])
  const [submitting, setSubmitting] = useState(false)

  function togglePermission(key: string) {
    setPermissions(prev => prev.includes(key) ? prev.filter(p => p !== key) : [...prev, key])
  }

  function toggleCompany(id: string) {
    setCompanyIds(prev => prev.includes(id) ? prev.filter(c => c !== id) : [...prev, id])
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    try {
      const res = await fetch('/api/tmc/tcs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, full_name: fullName, send_invite: sendInvite, permissions, companyIds }),
      })
      const data = await res.json()
      if (!res.ok) { onError(data.error || 'Could not add TC.'); return }
      onDone()
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} style={s.formCard}>
      <div style={s.formHeader}>
        <h2 style={s.formTitle}>Add a TC</h2>
        <button type="button" onClick={onClose} style={s.closeBtn}>✕</button>
      </div>

      <div style={s.fields}>
        <div style={s.field}>
          <label style={s.label}>Full name</label>
          <input type="text" required value={fullName} onChange={e => setFullName(e.target.value)} style={s.input} />
        </div>
        <div style={s.field}>
          <label style={s.label}>Email</label>
          <input type="email" required value={email} onChange={e => setEmail(e.target.value)} style={s.input} />
        </div>
      </div>

      <label style={s.checkboxRow}>
        <input type="checkbox" checked={sendInvite} onChange={e => setSendInvite(e.target.checked)} />
        Send email invite (unchecked = direct-create, active immediately)
      </label>

      <p style={s.sectionLabel}>Functions this TC can access</p>
      <div style={s.permGrid}>
        {PERMISSIONS.map(p => (
          <label key={p.key} style={s.permRow}>
            <input type="checkbox" checked={permissions.includes(p.key)} onChange={() => togglePermission(p.key)} />
            <div>
              <span style={s.permLabel}>{p.label}</span>
              <span style={s.permDesc}>{p.desc}</span>
            </div>
          </label>
        ))}
      </div>

      <p style={s.sectionLabel}>Companies this TC can access</p>
      {companies.length === 0 ? (
        <p style={s.emptyDesc}>No companies yet.</p>
      ) : (
        <div style={s.companyGrid}>
          {companies.map(c => (
            <label key={c.id} style={s.companyRow}>
              <input type="checkbox" checked={companyIds.includes(c.id)} onChange={() => toggleCompany(c.id)} />
              {c.name}
            </label>
          ))}
        </div>
      )}

      <div style={s.formActions}>
        <button type="button" onClick={onClose} style={s.ghostBtn}>Cancel</button>
        <button type="submit" disabled={submitting} style={{ ...s.primaryBtn, opacity: submitting ? 0.7 : 1 }}>
          {submitting ? 'Adding…' : 'Add TC →'}
        </button>
      </div>
    </form>
  )
}

// ── Edit permissions (existing TC) ──────────────────────────────────────────

function TcPermissionsEditor({ tc, companies, onClose, onDone, onError }: {
  tc: Tc
  companies: Company[]
  onClose: () => void
  onDone: () => void
  onError: (msg: string) => void
}) {
  const [permissions, setPermissions] = useState<string[]>(tc.permissions)
  const [companyIds, setCompanyIds] = useState<string[]>(tc.companyIds)
  const [submitting, setSubmitting] = useState(false)

  function togglePermission(key: string) {
    setPermissions(prev => prev.includes(key) ? prev.filter(p => p !== key) : [...prev, key])
  }

  function toggleCompany(id: string) {
    setCompanyIds(prev => prev.includes(id) ? prev.filter(c => c !== id) : [...prev, id])
  }

  async function handleSave() {
    setSubmitting(true)
    try {
      const res = await fetch(`/api/tmc/tcs/${tc.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ permissions, companyIds }),
      })
      const data = await res.json()
      if (!res.ok) { onError(data.error || 'Could not update.'); return }
      onDone()
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div style={s.formCard}>
      <div style={s.formHeader}>
        <h2 style={s.formTitle}>Edit access — {tc.full_name}</h2>
        <button type="button" onClick={onClose} style={s.closeBtn}>✕</button>
      </div>

      <p style={s.sectionLabel}>Functions</p>
      <div style={s.permGrid}>
        {PERMISSIONS.map(p => (
          <label key={p.key} style={s.permRow}>
            <input type="checkbox" checked={permissions.includes(p.key)} onChange={() => togglePermission(p.key)} />
            <div>
              <span style={s.permLabel}>{p.label}</span>
              <span style={s.permDesc}>{p.desc}</span>
            </div>
          </label>
        ))}
      </div>

      <p style={s.sectionLabel}>Companies</p>
      <div style={s.companyGrid}>
        {companies.map(c => (
          <label key={c.id} style={s.companyRow}>
            <input type="checkbox" checked={companyIds.includes(c.id)} onChange={() => toggleCompany(c.id)} />
            {c.name}
          </label>
        ))}
      </div>

      <div style={s.formActions}>
        <button type="button" onClick={onClose} style={s.ghostBtn}>Cancel</button>
        <button onClick={handleSave} disabled={submitting} style={{ ...s.primaryBtn, opacity: submitting ? 0.7 : 1 }}>
          {submitting ? 'Saving…' : 'Save access →'}
        </button>
      </div>
    </div>
  )
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  root: { fontFamily: "'Inter', -apple-system, sans-serif" },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '16px' },
  heading: { fontSize: '20px', fontWeight: 600, color: '#0A0A14', margin: '0 0 4px', letterSpacing: '-0.3px' },
  sub: { fontSize: '13px', color: '#6B7280', margin: 0 },
  primaryBtn: { height: '36px', padding: '0 14px', background: '#000835', color: '#fff', fontSize: '13px', fontWeight: 600, border: 'none', borderRadius: '7px', cursor: 'pointer' },
  ghostBtn: { height: '36px', padding: '0 14px', background: 'transparent', color: '#6B7280', fontSize: '13px', border: '1px solid #D1D5DB', borderRadius: '7px', cursor: 'pointer' },
  successBanner: { background: '#ECFDF5', border: '1px solid #A7F3D0', borderRadius: '8px', padding: '10px 14px', fontSize: '12px', color: '#065F46', marginBottom: '16px' },
  errorBanner: { background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: '8px', padding: '10px 14px', fontSize: '12px', color: '#DC2626', marginBottom: '16px' },
  formCard: { background: '#fff', border: '1px solid #E5E7EB', borderRadius: '10px', padding: '20px', marginBottom: '20px' },
  formHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px' },
  formTitle: { fontSize: '15px', fontWeight: 600, color: '#111827', margin: 0 },
  closeBtn: { background: 'transparent', border: 'none', color: '#9CA3AF', fontSize: '16px', cursor: 'pointer' },
  fields: { display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '14px', marginBottom: '14px' },
  field: { display: 'flex', flexDirection: 'column', gap: '5px' },
  label: { fontSize: '11px', fontWeight: 500, color: '#374151' },
  input: { height: '36px', padding: '0 10px', fontSize: '13px', color: '#111827', background: '#F9FAFB', border: '1px solid #E5E7EB', borderRadius: '6px', outline: 'none' },
  checkboxRow: { display: 'flex', alignItems: 'center', gap: '7px', fontSize: '12px', color: '#374151', marginBottom: '16px' },
  sectionLabel: { fontSize: '11px', fontWeight: 700, color: '#9CA3AF', textTransform: 'uppercase' as const, letterSpacing: '0.5px', margin: '14px 0 8px' },
  permGrid: { display: 'flex', flexDirection: 'column', gap: '8px' },
  permRow: { display: 'flex', alignItems: 'flex-start', gap: '8px', fontSize: '12px', color: '#374151', padding: '6px 0' },
  permLabel: { display: 'block', fontWeight: 500, color: '#111827' },
  permDesc: { display: 'block', fontSize: '11px', color: '#9CA3AF' },
  companyGrid: { display: 'flex', flexWrap: 'wrap' as const, gap: '10px' },
  companyRow: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: '#374151', background: '#F9FAFB', border: '1px solid #E5E7EB', borderRadius: '6px', padding: '6px 10px' },
  formActions: { display: 'flex', gap: '10px', justifyContent: 'flex-end', marginTop: '18px' },
  card: { background: '#fff', border: '1px solid #E5E7EB', borderRadius: '10px', overflow: 'hidden' },
  table: { width: '100%', borderCollapse: 'collapse' as const },
  th: { padding: '10px 16px', textAlign: 'left' as const, fontSize: '11px', fontWeight: 600, color: '#9CA3AF', textTransform: 'uppercase' as const, letterSpacing: '0.4px', background: '#F9FAFB', borderBottom: '1px solid #F3F4F6' },
  td: { padding: '12px 16px', fontSize: '13px', color: '#374151', borderBottom: '1px solid #F9FAFB' },
  name: { fontWeight: 500, color: '#111827' },
  badge: { display: 'inline-block', padding: '2px 8px', borderRadius: '4px', fontSize: '11px', fontWeight: 500 },
  editBtn: { fontSize: '11px', color: '#374151', background: 'transparent', border: '1px solid #D1D5DB', borderRadius: '5px', padding: '4px 8px', cursor: 'pointer' },
  deactivateBtn: { fontSize: '11px', color: '#DC2626', background: 'transparent', border: '1px solid #FECACA', borderRadius: '5px', padding: '4px 8px', cursor: 'pointer' },
  reactivateBtn: { fontSize: '11px', color: '#065F46', background: 'transparent', border: '1px solid #A7F3D0', borderRadius: '5px', padding: '4px 8px', cursor: 'pointer' },
  emptyState: { padding: '48px 20px', textAlign: 'center' as const },
  emptyTitle: { fontSize: '14px', fontWeight: 600, color: '#374151', margin: '0 0 6px' },
  emptyDesc: { fontSize: '13px', color: '#9CA3AF', margin: 0 },
}