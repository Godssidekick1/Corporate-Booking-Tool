'use client'

import { useEffect, useState } from 'react'

// ── /tmc/settings/cost-centres ───────────────────────────────────────────────
// A client's cost centres, with headcount.
//
// These were free text typed per employee, so "Sales", "sales" and "Sales "
// counted as three different things in any report and nothing could offer a
// list to pick from. Maintaining them here means the traveller-profile screen
// can offer a dropdown, and a rename carries its people along.
// ─────────────────────────────────────────────────────────────────────────────

interface Company { id: string; name: string }
interface CostCentre { id: string; code: string; name: string; employees: number }
interface Unlisted { code: string; employees: number }

export default function CostCentresPage() {
  const [companies, setCompanies] = useState<Company[]>([])
  const [companyId, setCompanyId] = useState('')

  const [centres, setCentres] = useState<CostCentre[]>([])
  const [departments, setDepartments] = useState<string[]>([])
  const [unlisted, setUnlisted] = useState<Unlisted[]>([])

  const [form, setForm] = useState({ code: '', name: '' })
  const [editing, setEditing] = useState<{ previousCode: string; code: string; name: string } | null>(null)

  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  useEffect(() => {
    fetch('/api/tmc/companies').then(r => r.json())
      .then(d => { if (d.ok) setCompanies(d.companies) })
  }, [])

  useEffect(() => {
    if (!companyId) return
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId])

  async function load() {
    setLoading(true); setError('')
    try {
      const d = await fetch(`/api/tmc/cost-centres?companyId=${companyId}`).then(r => r.json())
      if (!d.ok) { setError(d.error || 'Could not load cost centres.'); return }
      setCentres(d.costCentres)
      setDepartments(d.departments)
      setUnlisted(d.unlisted)
      setEditing(null)
    } finally { setLoading(false) }
  }

  async function add(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true); setError('')
    try {
      const d = await fetch('/api/tmc/cost-centres', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId, code: form.code, name: form.name }),
      }).then(r => r.json())
      if (!d.ok) { setError(d.error || 'Could not add that cost centre.'); return }
      setForm({ code: '', name: '' })
      await load()
      setSuccess(`"${d.costCentre.code}" added.`)
    } finally { setBusy(false) }
  }

  async function saveEdit() {
    if (!editing) return
    setBusy(true); setError('')
    try {
      const d = await fetch('/api/tmc/cost-centres', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          companyId,
          previousCode: editing.previousCode,
          code: editing.code,
          name: editing.name,
        }),
      }).then(r => r.json())
      if (!d.ok) { setError(d.error || 'Could not save that change.'); return }
      await load()
      setSuccess(
        d.moved > 0
          ? `Renamed, and ${d.moved} employee${d.moved === 1 ? '' : 's'} moved across.`
          : 'Cost centre updated.'
      )
    } finally { setBusy(false) }
  }

  async function remove(code: string, employees: number) {
    if (employees > 0) return
    if (!confirm(`Delete cost centre "${code}"?`)) return
    setBusy(true); setError('')
    try {
      const d = await fetch(`/api/tmc/cost-centres?companyId=${companyId}&code=${encodeURIComponent(code)}`, {
        method: 'DELETE',
      }).then(r => r.json())
      if (!d.ok) { setError(d.error || 'Could not delete.'); return }
      await load()
      setSuccess(`"${code}" deleted.`)
    } finally { setBusy(false) }
  }

  async function adopt(code: string) {
    setBusy(true); setError('')
    try {
      const d = await fetch('/api/tmc/cost-centres', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId, code, name: code }),
      }).then(r => r.json())
      if (!d.ok) { setError(d.error || 'Could not add that cost centre.'); return }
      await load()
      setSuccess(`"${code}" added to the list.`)
    } finally { setBusy(false) }
  }

  return (
    <div style={s.root}>
      <div style={s.header}>
        <h1 style={s.title}>Cost centres</h1>
        <p style={s.sub}>
          The list a client&apos;s people can be assigned to. Renaming one moves everyone on
          it, so reports stay whole.
        </p>
      </div>

      <div style={s.field}>
        <label style={s.label}>Client</label>
        <select value={companyId} onChange={e => setCompanyId(e.target.value)} style={{ ...s.input, width: 240 }}>
          <option value="">Select a client…</option>
          {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </div>

      {error && <div style={s.errorBanner}>⚠ {error}</div>}
      {success && <div style={s.successBanner}>✓ {success}</div>}

      {!companyId ? (
        <div style={s.empty}>
          <p style={s.emptyTitle}>Pick a client</p>
          <p style={s.emptyDesc}>Their cost centres will appear here.</p>
        </div>
      ) : loading ? (
        <div style={s.loadingWrap}>
          <div style={s.spinner} />
          <p style={s.emptyDesc}>Loading cost centres…</p>
        </div>
      ) : (
        <>
          <form onSubmit={add} style={s.addForm}>
            <input
              type="text" required placeholder="Code — e.g. ENG-01"
              value={form.code}
              onChange={e => setForm(p => ({ ...p, code: e.target.value }))}
              style={{ ...s.input, width: 180 }}
            />
            <input
              type="text" placeholder="Name (defaults to the code)"
              value={form.name}
              onChange={e => setForm(p => ({ ...p, name: e.target.value }))}
              style={{ ...s.input, flex: 1, minWidth: 200 }}
            />
            <button type="submit" disabled={busy} style={s.primaryBtn}>Add</button>
          </form>

          {unlisted.length > 0 && (
            <div style={s.warnBanner}>
              <strong>
                {unlisted.length} cost centre{unlisted.length === 1 ? '' : 's'} in use but not on the list.
              </strong>{' '}
              Typed directly onto people, or imported before this list existed.
              <div style={s.chipRow}>
                {unlisted.map(u => (
                  <button key={u.code} onClick={() => adopt(u.code)} disabled={busy} style={s.chip}>
                    + {u.code} ({u.employees})
                  </button>
                ))}
              </div>
            </div>
          )}

          {centres.length === 0 ? (
            <div style={s.empty}>
              <p style={s.emptyTitle}>No cost centres yet</p>
              <p style={s.emptyDesc}>Add one above to start assigning people to it.</p>
            </div>
          ) : (
            <div style={s.tableWrap}>
              <table style={s.table}>
                <thead>
                  <tr>
                    {['Code', 'Name', 'People', ''].map(h => <th key={h} style={s.th}>{h}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {centres.map(c => {
                    const isEditing = editing?.previousCode === c.code
                    return (
                      <tr key={c.id} style={s.tr}>
                        <td style={s.td}>
                          {isEditing ? (
                            <input
                              type="text" value={editing.code}
                              onChange={e => setEditing(p => p && { ...p, code: e.target.value })}
                              style={{ ...s.input, width: 140 }}
                            />
                          ) : <span style={s.code}>{c.code}</span>}
                        </td>
                        <td style={s.td}>
                          {isEditing ? (
                            <input
                              type="text" value={editing.name}
                              onChange={e => setEditing(p => p && { ...p, name: e.target.value })}
                              style={{ ...s.input, width: '100%' }}
                            />
                          ) : c.name}
                        </td>
                        <td style={s.td}>
                          <span style={s.count}>{c.employees}</span>
                        </td>
                        <td style={{ ...s.td, textAlign: 'right' as const }}>
                          {isEditing ? (
                            <div style={s.rowActions}>
                              <button onClick={saveEdit} disabled={busy} style={s.primaryBtn}>Save</button>
                              <button onClick={() => setEditing(null)} style={s.ghostBtn}>Cancel</button>
                            </div>
                          ) : (
                            <div style={s.rowActions}>
                              <button
                                onClick={() => setEditing({ previousCode: c.code, code: c.code, name: c.name })}
                                style={s.ghostBtn}
                              >
                                Edit
                              </button>
                              <button
                                onClick={() => remove(c.code, c.employees)}
                                disabled={c.employees > 0 || busy}
                                style={{ ...s.dangerBtn, opacity: c.employees > 0 ? 0.35 : 1 }}
                                title={c.employees > 0 ? 'Move its people elsewhere first' : 'Delete'}
                              >
                                Delete
                              </button>
                            </div>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}

          {departments.length > 0 && (
            <div style={s.deptBlock}>
              <h2 style={s.deptTitle}>Departments in use</h2>
              <p style={s.emptyDesc}>
                Free text on each person, edited on their traveller profile. Listed here so
                you can spot near-duplicates.
              </p>
              <div style={s.chipRow}>
                {departments.map(d => <span key={d} style={s.deptChip}>{d}</span>)}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  root: { fontFamily: "'Inter', -apple-system, sans-serif", paddingBottom: 60 },
  header: { marginBottom: 18 },
  title: { fontSize: 20, fontWeight: 600, color: '#0A0A14', margin: '0 0 4px', letterSpacing: '-0.3px' },
  sub: { fontSize: 13, color: '#6B7280', margin: 0, lineHeight: 1.6, maxWidth: 620 },

  field: { display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 18 },
  label: { fontSize: 11, fontWeight: 600, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.5px' },
  input: { height: 36, padding: '0 10px', fontSize: 13, color: '#111827', background: '#fff', border: '1px solid #D1D5DB', borderRadius: 7, outline: 'none' },

  errorBanner: { background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8, padding: '10px 14px', fontSize: 12, color: '#DC2626', marginBottom: 14 },
  successBanner: { background: '#ECFDF5', border: '1px solid #A7F3D0', borderRadius: 8, padding: '10px 14px', fontSize: 12, color: '#065F46', marginBottom: 14 },
  warnBanner: { background: '#FEF3C7', border: '1px solid #FDE68A', borderRadius: 8, padding: '11px 14px', fontSize: 12, color: '#92400E', marginBottom: 14, lineHeight: 1.6 },

  addForm: { display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' },
  chipRow: { display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 },
  chip: { background: '#fff', border: '1px solid #FDE68A', color: '#92400E', fontSize: 11, fontWeight: 600, borderRadius: 5, padding: '4px 9px', cursor: 'pointer' },
  deptChip: { background: '#F3F4F6', color: '#4B5563', fontSize: 11, borderRadius: 5, padding: '4px 9px' },

  tableWrap: { background: '#fff', border: '1px solid #E5E7EB', borderRadius: 10, overflowX: 'auto' },
  table: { borderCollapse: 'collapse', width: '100%' },
  th: { padding: '10px 14px', textAlign: 'left', background: '#F9FAFB', borderBottom: '1px solid #E5E7EB', fontSize: 11, fontWeight: 600, color: '#374151', whiteSpace: 'nowrap' },
  tr: { borderBottom: '1px solid #F3F4F6' },
  td: { padding: '9px 14px', fontSize: 13, color: '#374151', verticalAlign: 'middle' },
  code: { fontFamily: 'ui-monospace, monospace', fontSize: 12, fontWeight: 600, color: '#111827', background: '#F3F4F6', borderRadius: 4, padding: '2px 7px' },
  count: { fontSize: 12, fontWeight: 600, color: '#374151' },
  rowActions: { display: 'flex', gap: 6, justifyContent: 'flex-end' },

  primaryBtn: { height: 32, padding: '0 14px', background: '#000835', color: '#fff', fontSize: 12, fontWeight: 600, border: 'none', borderRadius: 6, cursor: 'pointer' },
  ghostBtn: { height: 30, padding: '0 11px', background: '#fff', color: '#374151', fontSize: 12, border: '1px solid #D1D5DB', borderRadius: 6, cursor: 'pointer' },
  dangerBtn: { height: 30, padding: '0 11px', background: '#fff', color: '#DC2626', fontSize: 12, border: '1px solid #FECACA', borderRadius: 6, cursor: 'pointer' },

  deptBlock: { marginTop: 28, paddingTop: 18, borderTop: '1px solid #E5E7EB' },
  deptTitle: { fontSize: 14, fontWeight: 600, color: '#111827', margin: '0 0 4px' },

  empty: { padding: '40px 20px', textAlign: 'center' },
  emptyTitle: { fontSize: 13, fontWeight: 600, color: '#374151', margin: '0 0 4px' },
  emptyDesc: { fontSize: 12, color: '#9CA3AF', margin: 0 },
  loadingWrap: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, padding: '60px' },
  spinner: { width: 24, height: 24, border: '2.5px solid #E5E7EB', borderTopColor: '#000835', borderRadius: '50%', animation: 'spin 0.7s linear infinite' },
}
