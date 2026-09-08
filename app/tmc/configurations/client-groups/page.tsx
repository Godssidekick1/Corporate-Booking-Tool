'use client'

import { useState } from 'react'
import CityDropdown from '@/app/components/CityDropdown'
import CountryDropdown from '@/app/components/CountryDropdown'
import StateDropdown from '@/app/components/StateDropdown'
import Pagination from '@/app/components/Pagination'
import { SkeletonTable } from '@/app/components/Skeleton'
import { usePagedList } from '@/app/hooks/usePagedList'

interface ClientGroup {
  id: string
  name: string
  group_code: string | null
  city: string | null
  country: string | null
  contact_first_name: string | null
  contact_last_name: string | null
  contact_email: string | null
  contact_mobile: string | null
  bill_to_address_1: string | null
  bill_to_address_2: string | null
  bill_to_state: string | null
  bill_to_pincode: string | null
  created_at: string
}

// Every editable field, as strings. The form works in '' and the route turns
// blanks into NULL, so nothing here has to carry a second empty value.
const EMPTY_FORM = {
  name: '', group_code: '',
  contact_first_name: '', contact_last_name: '', contact_email: '', contact_mobile: '',
  bill_to_address_1: '', bill_to_address_2: '',
  country: '', bill_to_state: '', city: '', bill_to_pincode: '',
}

function formFor(group: ClientGroup): typeof EMPTY_FORM {
  const filled = { ...EMPTY_FORM }
  for (const key of Object.keys(EMPTY_FORM) as (keyof typeof EMPTY_FORM)[]) {
    filled[key] = (group[key as keyof ClientGroup] as string | null) ?? ''
  }
  return filled
}

function contactName(g: ClientGroup): string {
  return [g.contact_first_name, g.contact_last_name].filter(Boolean).join(' ')
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
  const [form, setForm] = useState(EMPTY_FORM)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  function set<K extends keyof typeof EMPTY_FORM>(key: K, value: string) {
    setForm(prev => ({ ...prev, [key]: value }))
  }

  function loadClientGroups() {
    list.refetch()
  }

  function openCreate() {
    setForm(EMPTY_FORM)
    setEditingId(null)
    setShowForm(true)
    setError(''); setSuccess('')
  }

  function openEdit(group: ClientGroup) {
    setForm(formFor(group))
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
          <h1 style={s.heading}>Client groups</h1>
          <p style={s.sub}>
            A client&rsquo;s own org structure — Acme Group above Acme India and Acme UK. A client
            belongs to at most one, and the address here is where their invoice goes.
          </p>
        </div>
        <button onClick={openCreate} style={s.primaryBtn}>+ Add client group</button>
      </div>

      {/* The group/bucket distinction lived only in commit messages, which is to
          say nowhere a new reader would find it. Also written into `comment on
          table` for both, for anyone reading the schema instead. */}
      <p style={s.conceptNote}>
        <strong>Not the same as a bucket.</strong> A group is a hierarchical fact about who a client
        is. A <a href="/tmc/configurations/buckets" style={s.inlineLink}>bucket</a> is an arbitrary
        curated set made for distribution — a client can be in several, and the same bucket serves
        deal codes and forms of payment at once. Branches are different again: those are your own
        offices.
      </p>

      {success && <div style={s.successBanner}>✓ {success}</div>}
      {error && <div style={s.errorBanner}>✕ {error}</div>}

      {showForm && (
        <form onSubmit={handleSubmit} style={s.formCard}>
          <div style={s.formHeader}>
            <h2 style={s.formTitle}>{editingId ? 'Edit client group' : 'Add a client group'}</h2>
            <button type="button" onClick={() => setShowForm(false)} style={s.closeBtn}>✕</button>
          </div>
          <p style={s.sectionLabel}>Identity</p>
          <div style={s.fields}>
            <div style={{ ...s.field, gridColumn: 'span 2' }}>
              <label style={s.label}>Client group name</label>
              <input
                type="text" required
                value={form.name} onChange={e => set('name', e.target.value)}
                placeholder="e.g. Acme Group" style={s.input}
              />
            </div>
            <div style={s.field}>
              <label style={s.label}>Group code</label>
              <input
                type="text"
                value={form.group_code} onChange={e => set('group_code', e.target.value.toUpperCase())}
                placeholder="ACME" style={{ ...s.input, fontFamily: 'var(--font-mono)' }}
              />
            </div>
          </div>

          <p style={s.sectionLabel}>Contact</p>
          <div style={s.fields}>
            <div style={s.field}>
              <label style={s.label}>First name</label>
              <input
                type="text"
                value={form.contact_first_name} onChange={e => set('contact_first_name', e.target.value)}
                style={s.input}
              />
            </div>
            <div style={s.field}>
              <label style={s.label}>Last name</label>
              <input
                type="text"
                value={form.contact_last_name} onChange={e => set('contact_last_name', e.target.value)}
                style={s.input}
              />
            </div>
            <div style={s.field}>
              <label style={s.label}>Mobile</label>
              <input
                type="tel"
                value={form.contact_mobile} onChange={e => set('contact_mobile', e.target.value)}
                style={s.input}
              />
            </div>
            <div style={{ ...s.field, gridColumn: 'span 2' }}>
              <label style={s.label}>Email</label>
              <input
                type="email"
                value={form.contact_email} onChange={e => set('contact_email', e.target.value)}
                style={s.input}
              />
            </div>
          </div>
          <p style={s.hint}>
            Who to reach about this group commercially. This is not a login — it grants no access
            and nothing signs in with it.
          </p>

          <p style={s.sectionLabel}>Bill-to address</p>
          <div style={s.fields}>
            <div style={{ ...s.field, gridColumn: 'span 3' }}>
              <label style={s.label}>Address line 1</label>
              <input
                type="text"
                value={form.bill_to_address_1} onChange={e => set('bill_to_address_1', e.target.value)}
                style={s.input}
              />
            </div>
            <div style={{ ...s.field, gridColumn: 'span 3' }}>
              <label style={s.label}>Address line 2</label>
              <input
                type="text"
                value={form.bill_to_address_2} onChange={e => set('bill_to_address_2', e.target.value)}
                style={s.input}
              />
            </div>
            <div style={s.field}>
              <label style={s.label}>Country</label>
              <CountryDropdown value={form.country} onChange={v => set('country', v)} />
            </div>
            <div style={s.field}>
              <label style={s.label}>State</label>
              <StateDropdown value={form.bill_to_state} onChange={v => set('bill_to_state', v)} />
            </div>
            <div style={s.field}>
              <label style={s.label}>City</label>
              {/* Narrows to the chosen state, same as the branch form. */}
              <CityDropdown
                value={form.city}
                onChange={v => set('city', v)}
                state={form.bill_to_state || undefined}
              />
            </div>
            <div style={s.field}>
              <label style={s.label}>Pincode</label>
              <input
                type="text"
                value={form.bill_to_pincode}
                onChange={e => set('bill_to_pincode', e.target.value)}
                style={s.input}
              />
            </div>
          </div>
          <p style={s.hint}>
            Where this group&rsquo;s invoice goes. Your own registered address — the one you raise
            invoices from — lives on branches instead. No GST number here: the client&rsquo;s GSTIN
            is on the client record, which is the entity that contracts.
          </p>
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
          placeholder="Search name, code or city"
          style={s.searchInput}
        />
      </div>

      <div style={{ ...s.card, ...(list.refreshing ? s.dimmed : {}) }}>
        {list.loading ? (
          <SkeletonTable rows={8} cols={6} />
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
                {['Code', 'Name', 'Contact', 'City', 'Country', ''].map(h => <th key={h} style={s.th}>{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {clientGroups.map((g, i) => (
                <tr key={g.id} style={{ background: i % 2 === 0 ? '#fff' : '#FAFAFA' }}>
                  <td style={{ ...s.td, fontFamily: 'var(--font-mono)' }}>
                    {g.group_code ?? <span style={{ color: '#9CA3AF' }}>—</span>}
                  </td>
                  <td style={s.td}><span style={s.name}>{g.name}</span></td>
                  <td style={s.td}>
                    {contactName(g)
                      ? <>
                          <div>{contactName(g)}</div>
                          {g.contact_email && <div style={s.subCell}>{g.contact_email}</div>}
                        </>
                      : <span style={{ color: '#9CA3AF' }}>—</span>}
                  </td>
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
  fields: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '14px', marginBottom: '4px' },
  sectionLabel: { fontSize: '11px', fontWeight: 700, color: '#9CA3AF', textTransform: 'uppercase' as const, letterSpacing: '0.5px', margin: '16px 0 8px' },
  hint: { fontSize: '11.5px', color: '#9CA3AF', lineHeight: 1.55, margin: '2px 0 0' },
  conceptNote: { fontSize: '12px', color: '#6B7280', lineHeight: 1.6, background: '#F9FAFB', border: '1px solid #E5E7EB', borderRadius: '8px', padding: '10px 14px', margin: '0 0 16px', maxWidth: 760 },
  inlineLink: { color: '#3730A3', textDecoration: 'underline', textUnderlineOffset: '2px' },
  subCell: { fontSize: '11px', color: '#9CA3AF', marginTop: '1px' },
  field: { display: 'flex', flexDirection: 'column', gap: '5px' },
  label: { fontSize: '11px', fontWeight: 500, color: '#374151' },
  input: { height: '36px', padding: '0 10px', fontSize: '13px', color: '#111827', background: '#F9FAFB', border: '1px solid #E5E7EB', borderRadius: '6px', outline: 'none' },
  formActions: { display: 'flex', gap: '10px', justifyContent: 'flex-end' },
  filters: { display: 'flex', gap: '10px', marginBottom: '12px' },
  searchInput: { height: '36px', padding: '0 10px', fontSize: '13px', color: '#111827', background: '#fff', border: '1px solid #E5E7EB', borderRadius: '6px', outline: 'none', flex: 1, maxWidth: 340 },
  dimmed: { opacity: 0.55, transition: 'opacity 120ms ease' },
  card: { background: '#fff', border: '1px solid #E5E7EB', borderRadius: '10px', overflowX: 'auto' },
  table: { width: '100%', minWidth: 820, borderCollapse: 'collapse' as const },
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