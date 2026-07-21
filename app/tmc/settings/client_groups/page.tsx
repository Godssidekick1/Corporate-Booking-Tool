'use client'

import { useEffect, useState } from 'react'
import CityDropdown from '@/app/components/CityDropdown'
import CountryDropdown from '@/app/components/CountryDropdown'


interface client_group {
  id: string
  name: string
  city: string | null
  country: string | null
  created_at: string
}

export default function Tmcclient_groupsPage() {
  const [client_groups, setclient_groups] = useState<client_group[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState({ name: '', city: '', country: '' })
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  useEffect(() => {
    loadclient_groups()
  }, [])

  async function loadclient_groups() {
    setLoading(true)
    try {
      const res = await fetch('/api/tmc/client_groups')
      const data = await res.json()
      if (data.ok) setclient_groups(data.client_groups)
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

  function openEdit(client_group: client_group) {
    setForm({ name: client_group.name, city: client_group.city ?? '', country: client_group.country ?? '' })
    setEditingId(client_group.id)
    setShowForm(true)
    setError(''); setSuccess('')
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    setError('')
    try {
      const url = editingId ? `/api/tmc/client_groups/${editingId}` : '/api/tmc/client_groups'
      const method = editingId ? 'PATCH' : 'POST'
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error || 'Could not save client_group.'); return }
      setShowForm(false)
      setSuccess(editingId ? 'client_group updated.' : 'client_group created.')
      loadclient_groups()
    } finally {
      setSubmitting(false)
    }
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this client_group? Companies assigned to it will become unassigned, not deleted.')) return
    setError(''); setSuccess('')
    const res = await fetch(`/api/tmc/client_groups/${id}`, { method: 'DELETE' })
    const data = await res.json()
    if (!res.ok) { setError(data.error || 'Could not delete client_group.'); return }
    setSuccess('client_group deleted.')
    loadclient_groups()
  }

  return (
    <div style={s.root}>
      <div style={s.header}>
        <div>
          <h1 style={s.heading}>client_groups</h1>
          <p style={s.sub}>Group your client companies by client_group, region, or office.</p>
        </div>
        <button onClick={openCreate} style={s.primaryBtn}>+ Add client_group</button>
      </div>

      {success && <div style={s.successBanner}>✓ {success}</div>}
      {error && <div style={s.errorBanner}>✕ {error}</div>}

      {showForm && (
        <form onSubmit={handleSubmit} style={s.formCard}>
          <div style={s.formHeader}>
            <h2 style={s.formTitle}>{editingId ? 'Edit client_group' : 'Add a client_group'}</h2>
            <button type="button" onClick={() => setShowForm(false)} style={s.closeBtn}>✕</button>
          </div>
          <div style={s.fields}>
            <div style={s.field}>
              <label style={s.label}>client_group name</label>
              <input
                type="text" required
                value={form.name} onChange={e => setForm(prev => ({ ...prev, name: e.target.value }))}
                placeholder="e.g. Delhi" style={s.input}
              />
            </div>
            <div style={s.field}>
              <label style={s.label}>City</label>
              <CityDropdown
                value={form.city} onChange={city => setForm(prev => ({ ...prev, city}))}
              />
            </div>
            <div style={s.field}>
              <label style={s.label}>Country</label>
              <CountryDropdown
                value={form.country} onChange={country => setForm(prev => ({ ...prev, country}))}
              />
            </div>
          </div>
          <div style={s.formActions}>
            <button type="button" onClick={() => setShowForm(false)} style={s.ghostBtn}>Cancel</button>
            <button type="submit" disabled={submitting} style={{ ...s.primaryBtn, opacity: submitting ? 0.7 : 1 }}>
              {submitting ? 'Saving…' : editingId ? 'Save changes →' : 'Create client_group →'}
            </button>
          </div>
        </form>
      )}

      <div style={s.card}>
        {loading ? (
          <div style={s.emptyState}><p style={s.emptyTitle}>Loading…</p></div>
        ) : client_groups.length === 0 ? (
          <div style={s.emptyState}>
            <p style={s.emptyTitle}>No client_groups yet</p>
            <p style={s.emptyDesc}>Create your first client_group to start grouping client companies.</p>
          </div>
        ) : (
          <table style={s.table}>
            <thead>
              <tr>
                {['Name', 'City', 'Country', ''].map(h => <th key={h} style={s.th}>{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {client_groups.map((b, i) => (
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