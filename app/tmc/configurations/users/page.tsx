'use client'

import { useEffect, useRef, useState } from 'react'
import Pagination from '@/app/components/Pagination'
import { SkeletonTable } from '@/app/components/Skeleton'
import { usePagedList } from '@/app/hooks/usePagedList'
import { useLookup, clientOption } from '@/app/hooks/useLookup'
import SearchableSelect from '@/app/components/SearchableSelect'
import { PERMISSIONS } from '@/app/lib/permissions/permissionKeys'

interface Tc {
  id: string
  full_name: string
  email: string
  status: string
  created_at: string
  permissions: string[]
  clientIds: string[]
  branch_id: string | null
  branchName: string | null
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
  const [mode, setMode] = useState<Mode>('list')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  // Counsellors are server-paged and server-searched.
  const list = usePagedList<Tc>('/api/tmc/tcs')
  const tcs = list.items

  function loadAll() {
    list.refetch()
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
    list.refetch()
    setSuccess(newStatus === 'deactivated' ? 'TC deactivated.' : 'TC reactivated.')
  }

  const editingTc = tcs.find(t => t.id === editingId) ?? null

  return (
    <div style={s.root}>
      <div style={s.header}>
        <div>
          <h1 style={s.heading}>TMC users</h1>
          <p style={s.sub}>{list.total} travel counsellor{list.total === 1 ? '' : 's'} with access to your account.</p>
        </div>
        <button onClick={() => { setMode('create'); setError(''); setSuccess('') }} style={s.primaryBtn}>
          + Add TC
        </button>
      </div>

      {success && <div style={s.successBanner}>✓ {success}</div>}
      {error && <div style={s.errorBanner}>✕ {error}</div>}

      {mode === 'create' && (
        <TcForm
          onClose={() => setMode('list')}
          onDone={() => { setMode('list'); loadAll(); setSuccess('TC added.') }}
          onError={setError}
        />
      )}

      {editingTc && (
        <TcPermissionsEditor
          tc={editingTc}
          onClose={() => setEditingId(null)}
          onDone={() => { setEditingId(null); loadAll(); setSuccess('Permissions updated.') }}
          onError={setError}
        />
      )}

      <div style={s.filters}>
        <input
          value={list.search}
          onChange={e => list.setSearch(e.target.value)}
          placeholder="Search name or email"
          style={s.searchInput}
        />
      </div>

      <div style={{ ...s.card, ...(list.refreshing ? s.dimmed : {}) }}>
        {list.loading ? (
          <SkeletonTable rows={8} cols={6} />
        ) : tcs.length === 0 ? (
          <div style={s.emptyState}>
            <p style={s.emptyTitle}>{list.search ? 'No TCs match that search' : 'No TCs yet'}</p>
            <p style={s.emptyDesc}>
              {list.search
                ? 'Search covers every counsellor, not just this page.'
                : 'Add a travel counsellor using the button above.'}
            </p>
          </div>
        ) : (
          <table style={s.table}>
            <thead>
              <tr>
                {['Name', 'Email', 'Branch', 'Status', 'Permissions', 'Clients', ''].map(h => (
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
                    <td style={s.td}>{tc.branchName ?? <span style={{ color: '#9CA3AF' }}>—</span>}</td>
                    <td style={s.td}>
                      <span style={{ ...s.badge, background: colors.bg, color: colors.fg }}>{tc.status}</span>
                    </td>
                    <td style={s.td}>{tc.permissions.length} function{tc.permissions.length === 1 ? '' : 's'}</td>
                    <td style={s.td}>{tc.clientIds.length} client{tc.clientIds.length === 1 ? '' : 's'}</td>
                    {/* The flex row lives in a div, not on the <td>. A cell with
                        display:flex leaves the table layout algorithm, so the
                        browser can no longer size it against the other columns —
                        which is how Deactivate got squeezed out of view whenever
                        the rail was expanded. */}
                    <td style={{ ...s.td, ...s.actionsCell }}>
                      <div style={s.actions}>
                        {tc.status !== 'invited' && (
                          <button onClick={() => setEditingId(tc.id)} style={s.editBtn}>Edit access</button>
                        )}
                        <button
                          onClick={() => handleStatusToggle(tc)}
                          style={tc.status === 'active' ? s.deactivateBtn : s.reactivateBtn}
                        >
                          {tc.status === 'active' ? 'Deactivate' : 'Reactivate'}
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      <Pagination
        page={list.page} pageSize={10} total={list.total}
        onPageChange={list.setPage} busy={list.refreshing} noun="counsellors"
      />
    </div>
  )
}

// ── Create form ───────────────────────────────────────────────────────────────

function TcForm({ onClose, onDone, onError }: {
  onClose: () => void
  onDone: () => void
  onError: (msg: string) => void
}) {
  const [email, setEmail] = useState('')
  const [fullName, setFullName] = useState('')
  const [sendInvite, setSendInvite] = useState(true)
  const [permissions, setPermissions] = useState<string[]>([])
  const [clientIds, setClientIds] = useState<string[]>([])
  const [submitting, setSubmitting] = useState(false)

  function togglePermission(key: string) {
    setPermissions(prev => prev.includes(key) ? prev.filter(p => p !== key) : [...prev, key])
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    try {
      const res = await fetch('/api/tmc/tcs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, full_name: fullName, send_invite: sendInvite, permissions, clientIds }),
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

      <p style={s.sectionLabel}>Clients this TC can access · {clientIds.length}</p>
      <ClientAccess value={clientIds} onChange={setClientIds} />

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

function TcPermissionsEditor({ tc, onClose, onDone, onError }: {
  tc: Tc
  onClose: () => void
  onDone: () => void
  onError: (msg: string) => void
}) {
  const [permissions, setPermissions] = useState<string[]>(tc.permissions)
  const [clientIds, setClientIds] = useState<string[]>(tc.clientIds)
  const [branchId, setBranchId] = useState<string>(tc.branch_id ?? '')
  const [submitting, setSubmitting] = useState(false)

  // Server-searched: a TMC's branch list is small, but this is the same picker
  // pattern as everywhere else and costs nothing to keep consistent.
  const branchLookup = useLookup('/api/tmc/branches', branchId)

  function togglePermission(key: string) {
    setPermissions(prev => prev.includes(key) ? prev.filter(p => p !== key) : [...prev, key])
  }

  async function handleSave() {
    setSubmitting(true)
    try {
      const res = await fetch(`/api/tmc/tcs/${tc.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ permissions, clientIds, branchId: branchId || null }),
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

      <p style={s.sectionLabel}>Branch</p>
      <div style={{ maxWidth: 320 }}>
        <SearchableSelect
          value={branchId}
          onChange={setBranchId}
          options={branchLookup.options}
          onSearch={branchLookup.onSearch}
          loading={branchLookup.loading}
          selectedLabel={branchLookup.selectedLabel}
          placeholder="Search branches…"
          emptyMessage="No branches match"
        />
        <p style={s.permDesc}>
          Which office they work out of. Organisational only — it grants no access on its own.
        </p>
      </div>

      <p style={s.sectionLabel}>Clients · {clientIds.length}</p>
      <ClientAccess value={clientIds} onChange={setClientIds} />

      <div style={s.formActions}>
        <button type="button" onClick={onClose} style={s.ghostBtn}>Cancel</button>
        <button onClick={handleSave} disabled={submitting} style={{ ...s.primaryBtn, opacity: submitting ? 0.7 : 1 }}>
          {submitting ? 'Saving…' : 'Save access →'}
        </button>
      </div>
    </div>
  )
}

// ── Client access ─────────────────────────────────────────────────────────────
// Search to add, × to remove. This was a checkbox per client over ONE fetch of
// /api/tmc/clients, which is paged: only the first ten clients ever had a box,
// so nobody could grant a counsellor the rest, and clients they already held
// beyond those ten were invisible.

function ClientAccess({ value, onChange }: { value: string[]; onChange: (ids: string[]) => void }) {
  const [addId, setAddId] = useState('')
  const lookup = useLookup('/api/tmc/clients', addId, { toOption: clientOption })
  const [names, setNames] = useState<Map<string, string>>(new Map())
  // Ids already asked for, so one that never resolves is not asked for forever.
  const asked = useRef(new Set<string>())

  // Name the clients already held. By id, since most are on no page of search
  // results; in chunks, since a counsellor can hold hundreds and each id is 37
  // characters of URL.
  useEffect(() => {
    const missing = value.filter(id => !asked.current.has(id))
    if (missing.length === 0) return
    for (const id of missing) asked.current.add(id)
    const chunks: string[][] = []
    for (let i = 0; i < missing.length; i += 100) chunks.push(missing.slice(i, i + 100))
    Promise.all(chunks.map(ids => fetch(`/api/tmc/clients?ids=${ids.join(',')}`).then(r => r.json())))
      .then(results => setNames(prev => {
        const next = new Map(prev)
        for (const d of results) for (const row of d.ok ? d.items : []) next.set(String(row.id), String(row.name))
        return next
      }))
      .catch(() => {})
  }, [value])

  function add(id: string) {
    setAddId('')
    const picked = lookup.options.find(o => o.id === id)
    if (!picked || value.includes(id)) return
    asked.current.add(id)
    setNames(prev => new Map(prev).set(id, picked.label))
    onChange([...value, id])
  }

  const held = [...value].sort((a, b) => (names.get(a) ?? '').localeCompare(names.get(b) ?? ''))

  return (
    <>
      <div style={{ maxWidth: 360, marginBottom: 10 }}>
        <SearchableSelect
          value={addId}
          onChange={add}
          options={lookup.options.filter(o => !value.includes(o.id))}
          onSearch={lookup.onSearch}
          loading={lookup.loading}
          selectedLabel={lookup.selectedLabel}
          placeholder="Search clients to add…"
          emptyMessage="No more clients match"
        />
      </div>
      {held.length === 0 ? (
        <p style={s.emptyDesc}>No clients yet. Search above to add them.</p>
      ) : (
        <div style={s.clientGrid}>
          {held.map(id => {
            const name = names.get(id) ?? '…'
            return (
              <span key={id} style={s.clientRow}>
                {name}
                <button type="button" onClick={() => onChange(value.filter(x => x !== id))}
                  aria-label={`Remove ${name}`} title={`Remove ${name}`} style={s.removeBtn}>×</button>
              </span>
            )
          })}
        </div>
      )}
    </>
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
  clientGrid: { display: 'flex', flexWrap: 'wrap' as const, gap: '8px', maxHeight: 260, overflowY: 'auto' as const },
  clientRow: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: '#374151', background: '#F9FAFB', border: '1px solid #E5E7EB', borderRadius: '6px', padding: '6px 10px' },
  removeBtn: { background: 'transparent', border: 'none', color: '#9CA3AF', fontSize: '14px', lineHeight: 1, padding: 0, cursor: 'pointer' },
  formActions: { display: 'flex', gap: '10px', justifyContent: 'flex-end', marginTop: '18px' },
  filters: { display: 'flex', gap: '10px', marginBottom: '12px' },
  searchInput: { height: '36px', padding: '0 10px', fontSize: '13px', color: '#111827', background: '#fff', border: '1px solid #E5E7EB', borderRadius: '6px', outline: 'none', flex: 1, maxWidth: 340 },
  dimmed: { opacity: 0.55, transition: 'opacity 120ms ease' },
  // overflowX rather than overflow:hidden — the table has a min-width, so a
  // narrow viewport scrolls the columns instead of clipping the last one.
  card: { background: '#fff', border: '1px solid #E5E7EB', borderRadius: '10px', overflowX: 'auto' },
  table: { width: '100%', minWidth: 860, borderCollapse: 'collapse' as const },
  th: { padding: '10px 16px', textAlign: 'left' as const, fontSize: '11px', fontWeight: 600, color: '#9CA3AF', textTransform: 'uppercase' as const, letterSpacing: '0.4px', background: '#F9FAFB', borderBottom: '1px solid #F3F4F6' },
  td: { padding: '12px 16px', fontSize: '13px', color: '#374151', borderBottom: '1px solid #F9FAFB' },
  actionsCell: { textAlign: 'right' as const, whiteSpace: 'nowrap' as const, width: '1%' },
  actions: { display: 'flex', gap: '8px', justifyContent: 'flex-end' },
  name: { fontWeight: 500, color: '#111827' },
  badge: { display: 'inline-block', padding: '2px 8px', borderRadius: '4px', fontSize: '11px', fontWeight: 500 },
  editBtn: { fontSize: '11px', color: '#374151', background: 'transparent', border: '1px solid #D1D5DB', borderRadius: '5px', padding: '4px 8px', cursor: 'pointer' },
  deactivateBtn: { fontSize: '11px', color: '#DC2626', background: 'transparent', border: '1px solid #FECACA', borderRadius: '5px', padding: '4px 8px', cursor: 'pointer' },
  reactivateBtn: { fontSize: '11px', color: '#065F46', background: 'transparent', border: '1px solid #A7F3D0', borderRadius: '5px', padding: '4px 8px', cursor: 'pointer' },
  emptyState: { padding: '48px 20px', textAlign: 'center' as const },
  emptyTitle: { fontSize: '14px', fontWeight: 600, color: '#374151', margin: '0 0 6px' },
  emptyDesc: { fontSize: '13px', color: '#9CA3AF', margin: 0 },
}