'use client'

import { useEffect, useState } from 'react'

interface Branch {
  id: string
  name: string
  city: string | null
  country: string | null
  created_at: string
}

export default function TmcBranchesPage() {
  const [branches, setBranches] = useState<Branch[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState({ name: '', city: '', country: '' })
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  useEffect(() => {
    loadBranches()
  }, [])

  async function loadBranches() {
    setLoading(true)
    try {
      const res = await fetch('/api/tmc/branches')
      const data = await res.json()
      if (data.ok) setBranches(data.branches)
    } finally {
      setLoading(false)
    }
  }

  function openCreate() {
    setForm({ name: '', city: '', country: '' })
    setEditingId(null)
    setShowForm(true)
    setError(''); setSuccess('')
  }

  function openEdit(branch: Branch) {
    setForm({ name: branch.name, city: branch.city ?? '', country: branch.country ?? '' })
    setEditingId(branch.id)
    setShowForm(true)
    setError(''); setSuccess('')
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    setError('')
    try {
      const url = editingId ? `/api/tmc/branches/${editingId}` : '/api/tmc/branches'
      const method = editingId ? 'PATCH' : 'POST'
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error || 'Could not save branch.'); return }
      setShowForm(false)
      setSuccess(editingId ? 'Branch updated.' : 'Branch created.')
      loadBranches()
    } finally {
      setSubmitting(false)
    }
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this branch? Companies assigned to it will become unassigned, not deleted.')) return
    setError(''); setSuccess('')
    const res = await fetch(`/api/tmc/branches/${id}`, { method: 'DELETE' })
    const data = await res.json()
    if (!res.ok) { setError(data.error || 'Could not delete branch.'); return }
    setSuccess('Branch deleted.')
    loadBranches()
  }

  return (
    <div style={s.root}>
      <div style={s.header}>
        <div>
          <h1 style={s.heading}>Branches</h1>
          <p style={s.sub}>Group your client companies by branch, region, or office.</p>
        </div>
        <button onClick={openCreate} style={s.primaryBtn}>+ Add branch</button>
      </div>

      {success && <div style={s.successBanner}>✓ {success}</div>}
      {error && <div style={s.errorBanner}>✕ {error}</div>}

      {showForm && (
        <form onSubmit={handleSubmit} style={s.formCard}>
          <div style={s.formHeader}>
            <h2 style={s.formTitle}>{editingId ? 'Edit branch' : 'Add a branch'}</h2>
            <button type="button" onClick={() => setShowForm(false)} style={s.closeBtn}>✕</button>
          </div>
          <div style={s.fields}>
            <div style={s.field}>
              <label style={s.label}>Branch name</label>
              <input
                type="text" required
                value={form.name} onChange={e => setForm(prev => ({ ...prev, name: e.target.value }))}
                placeholder="e.g. Delhi" style={s.input}
              />
            </div>
            <div style={s.field}>
              <label style={s.label}>City</label>
              <input
                type="text"
                value={form.city} onChange={e => setForm(prev => ({ ...prev, city: e.target.value }))}
                placeholder="e.g. New Delhi" style={s.input}
              />
            </div>
            <div style={s.field}>
              <label style={s.label}>Country</label>
              <input
                type="text"
                value={form.country} onChange={e => setForm(prev => ({ ...prev, country: e.target.value }))}
                placeholder="e.g. India" style={s.input}
              />
            </div>
          </div>
          <div style={s.formActions}>
            <button type="button" onClick={() => setShowForm(false)} style={s.ghostBtn}>Cancel</button>
            <button type="submit" disabled={submitting} style={{ ...s.primaryBtn, opacity: submitting ? 0.7 : 1 }}>
              {submitting ? 'Saving…' : editingId ? 'Save changes →' : 'Create branch →'}
            </button>
          </div>
        </form>
      )}

      <div style={s.card}>
        {loading ? (
          <div style={s.emptyState}><p style={s.emptyTitle}>Loading…</p></div>
        ) : branches.length === 0 ? (
          <div style={s.emptyState}>
            <p style={s.emptyTitle}>No branches yet</p>
            <p style={s.emptyDesc}>Create your first branch to start grouping client companies.</p>
          </div>
        ) : (
          <table style={s.table}>
            <thead>
              <tr>
                {['Name', 'City', 'Country', ''].map(h => <th key={h} style={s.th}>{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {branches.map((b, i) => (
                <tr key={b.id} style={{ background: i % 2 === 0 ? '#fff' : '#FAFAFA' }}>
                  <td style={s.td}><span style={s.name}>{b.name}</span></td>
                  <td style={{ ...s.td, color: '#6B7280' }}>{b.city ?? '—'}</td>
                  <td style={{ ...s.td, color: '#6B7280' }}>{b.country ?? '—'}</td>
                  <td style={{ ...s.td, textAlign: 'right' as const, display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
                    <button onClick={() => openEdit(b)} style={s.editBtn}>Edit</button>
                    <button onClick={() => handleDelete(b.id)} style={s.deleteBtn}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

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
  fields: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '14px', marginBottom: '14px' },
  field: { display: 'flex', flexDirection: 'column', gap: '5px' },
  label: { fontSize: '11px', fontWeight: 500, color: '#374151' },
  input: { height: '36px', padding: '0 10px', fontSize: '13px', color: '#111827', background: '#F9FAFB', border: '1px solid #E5E7EB', borderRadius: '6px', outline: 'none' },
  formActions: { display: 'flex', gap: '10px', justifyContent: 'flex-end' },
  card: { background: '#fff', border: '1px solid #E5E7EB', borderRadius: '10px', overflow: 'hidden' },
  table: { width: '100%', borderCollapse: 'collapse' as const },
  th: { padding: '10px 16px', textAlign: 'left' as const, fontSize: '11px', fontWeight: 600, color: '#9CA3AF', textTransform: 'uppercase' as const, letterSpacing: '0.4px', background: '#F9FAFB', borderBottom: '1px solid #F3F4F6' },
  td: { padding: '12px 16px', fontSize: '13px', color: '#374151', borderBottom: '1px solid #F9FAFB' },
  name: { fontWeight: 500, color: '#111827' },
  editBtn: { fontSize: '11px', color: '#374151', background: 'transparent', border: '1px solid #D1D5DB', borderRadius: '5px', padding: '4px 8px', cursor: 'pointer' },
  deleteBtn: { fontSize: '11px', color: '#DC2626', background: 'transparent', border: '1px solid #FECACA', borderRadius: '5px', padding: '4px 8px', cursor: 'pointer' },
  emptyState: { padding: '48px 20px', textAlign: 'center' as const },
  emptyTitle: { fontSize: '14px', fontWeight: 600, color: '#374151', margin: '0 0 6px' },
  emptyDesc: { fontSize: '13px', color: '#9CA3AF', margin: 0 },
}