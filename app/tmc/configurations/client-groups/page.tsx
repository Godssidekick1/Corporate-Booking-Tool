'use client'

import { useState } from 'react'
import CityDropdown from '@/app/components/CityDropdown'
import CountryDropdown from '@/app/components/CountryDropdown'
import Pagination from '@/app/components/Pagination'
import { SkeletonTable } from '@/app/components/Skeleton'
import { usePagedList } from '@/app/hooks/usePagedList'

interface ClientGroup {
  id: string
  name: string
  city: string | null
  country: string | null
  created_at: string
}

export default function TmcClientGroupsPage() {
  // Server-paged and server-searched. It used to be a bare fetch rendering
  // whatever came back — but the endpoint has paged at 10 since pagination
  // landed, so past the tenth group the rest were simply invisible with nothing
  // on screen saying so.
  const list = usePagedList<ClientGroup>('/api/tmc/client-groups')
  const clientGroups = list.items

  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState({ name: '', city: '', country: '' })
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  function loadClientGroups() {
    list.refetch()
  }

  function openCreate() {
    setForm({ name: '', city: '', country: '' })
    setEditingId(null)
    setShowForm(true)
    setError(''); setSuccess('')
  }

  function openEdit(group: ClientGroup) {
    setForm({ name: group.name, city: group.city ?? '', country: group.country ?? '' })
    setEditingId(group.id)
    setShowForm(true)
    setError(''); setSuccess('')
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    setError('')
    try {
      const url = editingId ? `/api/tmc/client-groups/${editingId}` : '/api/tmc/client-groups'
      const method = editingId ? 'PATCH' : 'POST'
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error || 'Could not save client group.'); return }
      setShowForm(false)
      setSuccess(editingId ? 'Client group updated.' : 'Client group created.')
      loadClientGroups()
    } finally {
      setSubmitting(false)
    }
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this client group? Clients assigned to it will become unassigned, not deleted.')) return
    setError(''); setSuccess('')
    const res = await fetch(`/api/tmc/client-groups/${id}`, { method: 'DELETE' })
    const data = await res.json()
    if (!res.ok) { setError(data.error || 'Could not delete client group.'); return }
    setSuccess('Client group deleted.')
    loadClientGroups()
  }

  return (
    <div style={s.root}>
      <div style={s.header}>
        <div>
          <h1 style={s.heading}>Client Groups</h1>
          <p style={s.sub}>Group your client clients by region, office, or however makes sense for your team.</p>
        </div>
        <button onClick={openCreate} style={s.primaryBtn}>+ Add client group</button>
      </div>

      {success && <div style={s.successBanner}>✓ {success}</div>}
      {error && <div style={s.errorBanner}>✕ {error}</div>}

      {showForm && (
        <form onSubmit={handleSubmit} style={s.formCard}>
          <div style={s.formHeader}>
            <h2 style={s.formTitle}>{editingId ? 'Edit client group' : 'Add a client group'}</h2>
            <button type="button" onClick={() => setShowForm(false)} style={s.closeBtn}>✕</button>
          </div>
          <div style={s.fields}>
            <div style={s.field}>
              <label style={s.label}>Client group name</label>
              <input
                type="text" required
                value={form.name} onChange={e => setForm(prev => ({ ...prev, name: e.target.value }))}
                placeholder="e.g. Delhi" style={s.input}
              />
            </div>
            <div style={s.field}>
              <label style={s.label}>City</label>
              <CityDropdown
                value={form.city} onChange={city => setForm(prev => ({ ...prev, city }))}
              />
            </div>
            <div style={s.field}>
              <label style={s.label}>Country</label>
              <CountryDropdown
                value={form.country} onChange={country => setForm(prev => ({ ...prev, country }))}
              />
            </div>
          </div>
          <div style={s.formActions}>
            <button type="button" onClick={() => setShowForm(false)} style={s.ghostBtn}>Cancel</button>
            <button type="submit" disabled={submitting} style={{ ...s.primaryBtn, opacity: submitting ? 0.7 : 1 }}>
              {submitting ? 'Saving…' : editingId ? 'Save changes →' : 'Create client group →'}
            </button>
          </div>
        </form>
      )}

      <div style={s.filters}>
        <input
          value={list.search}
          onChange={e => list.setSearch(e.target.value)}
          placeholder="Search name or city"
          style={s.searchInput}
        />
      </div>

      <div style={{ ...s.card, ...(list.refreshing ? s.dimmed : {}) }}>
        {list.loading ? (
          <SkeletonTable rows={8} cols={4} />
        ) : clientGroups.length === 0 ? (
          <div style={s.emptyState}>
            <p style={s.emptyTitle}>
              {list.search ? 'No client groups match that search' : 'No client groups yet'}
            </p>
            <p style={s.emptyDesc}>
              {list.search
                ? 'Search covers every client group, not just this page.'
                : 'Create your first client group to start grouping clients.'}
            </p>
          </div>
        ) : (
          <table style={s.table}>
            <thead>
              <tr>
                {['Name', 'City', 'Country', ''].map(h => <th key={h} style={s.th}>{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {clientGroups.map((g, i) => (
                <tr key={g.id} style={{ background: i % 2 === 0 ? '#fff' : '#FAFAFA' }}>
                  <td style={s.td}><span style={s.name}>{g.name}</span></td>
                  <td style={{ ...s.td, color: '#6B7280' }}>{g.city ?? '—'}</td>
                  <td style={{ ...s.td, color: '#6B7280' }}>{g.country ?? '—'}</td>
                  {/* Same fix as the TC screen: display:flex on a <td> takes the
                      cell out of the table layout algorithm, so it can no longer
                      be sized against its neighbours and the buttons get pushed
                      out of view at tight widths. */}
                  <td style={{ ...s.td, ...s.actionsCell }}>
                    <div style={s.actions}>
                      <button onClick={() => openEdit(g)} style={s.editBtn}>Edit</button>
                      <button onClick={() => handleDelete(g.id)} style={s.deleteBtn}>Delete</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <Pagination
        page={list.page} pageSize={10} total={list.total}
        onPageChange={list.setPage} busy={list.refreshing} noun="client groups"
      />
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
  filters: { display: 'flex', gap: '10px', marginBottom: '12px' },
  searchInput: { height: '36px', padding: '0 10px', fontSize: '13px', color: '#111827', background: '#fff', border: '1px solid #E5E7EB', borderRadius: '6px', outline: 'none', flex: 1, maxWidth: 340 },
  dimmed: { opacity: 0.55, transition: 'opacity 120ms ease' },
  card: { background: '#fff', border: '1px solid #E5E7EB', borderRadius: '10px', overflowX: 'auto' },
  table: { width: '100%', minWidth: 640, borderCollapse: 'collapse' as const },
  actionsCell: { textAlign: 'right' as const, whiteSpace: 'nowrap' as const, width: '1%' },
  actions: { display: 'flex', gap: '8px', justifyContent: 'flex-end' },
  th: { padding: '10px 16px', textAlign: 'left' as const, fontSize: '11px', fontWeight: 600, color: '#9CA3AF', textTransform: 'uppercase' as const, letterSpacing: '0.4px', background: '#F9FAFB', borderBottom: '1px solid #F3F4F6' },
  td: { padding: '12px 16px', fontSize: '13px', color: '#374151', borderBottom: '1px solid #F9FAFB' },
  name: { fontWeight: 500, color: '#111827' },
  editBtn: { fontSize: '11px', color: '#374151', background: 'transparent', border: '1px solid #D1D5DB', borderRadius: '5px', padding: '4px 8px', cursor: 'pointer' },
  deleteBtn: { fontSize: '11px', color: '#DC2626', background: 'transparent', border: '1px solid #FECACA', borderRadius: '5px', padding: '4px 8px', cursor: 'pointer' },
  emptyState: { padding: '48px 20px', textAlign: 'center' as const },
  emptyTitle: { fontSize: '14px', fontWeight: 600, color: '#374151', margin: '0 0 6px' },
  emptyDesc: { fontSize: '13px', color: '#9CA3AF', margin: 0 },
}