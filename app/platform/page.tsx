'use client'

import { useState } from 'react'
import Pagination from '@/app/components/Pagination'
import { SkeletonTable } from '@/app/components/Skeleton'
import { usePagedList } from '@/app/hooks/usePagedList'

// ── /platform ────────────────────────────────────────────────────────────────
// Onboarding TMCs without Postman.
//
// The layout above is the access gate; this file assumes it passed and never
// re-checks, because a client component cannot check anything meaningfully —
// every route it calls does the real check server-side.
//
// Deliberately plain. This is an internal tool for a handful of Amadeus staff,
// and the failure mode that matters is somebody misreading which TMC they are
// acting on, not a lack of polish.
// ─────────────────────────────────────────────────────────────────────────────

interface Tmc {
  id: string
  name: string
  status: string
  created_at: string
  clientCount: number
  staffCount: number
  adminCount: number
}

interface Staff {
  id: string
  full_name: string
  email: string
  role: string
  status: string
}

interface ImportError { row: number; email: string; error: string }

const STATUS_STYLE: Record<string, React.CSSProperties> = {
  active: { background: '#ECFDF5', color: '#065F46', borderColor: '#A7F3D0' },
  inactive: { background: '#F3F4F6', color: '#6B7280', borderColor: '#E5E7EB' },
  invited: { background: '#FEF3C7', color: '#92400E', borderColor: '#FDE68A' },
  deactivated: { background: '#F3F4F6', color: '#6B7280', borderColor: '#E5E7EB' },
}

// Minimal CSV reader: quoted cells, doubled quotes, embedded newlines. Written
// here rather than pulled in as a dependency because it reads one internal file
// format we also generate.
function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false

  for (let i = 0; i < text.length; i++) {
    const char = text[i]

    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++ }
        else quoted = false
      } else cell += char
      continue
    }

    if (char === '"') { quoted = true; continue }
    if (char === ',') { row.push(cell); cell = ''; continue }
    if (char === '\r') continue
    if (char === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; continue }
    cell += char
  }

  if (cell !== '' || row.length > 0) { row.push(cell); rows.push(row) }
  if (rows.length < 2) return []

  const header = rows[0].map(h => h.trim())
  return rows.slice(1)
    // A trailing newline produces one empty row; so does a blank line someone
    // left in the middle of the file.
    .filter(r => r.some(c => c.trim() !== ''))
    .map(r => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').trim()])))
}

export default function PlatformPage() {
  const list = usePagedList<Tmc>('/api/platform/tmcs')

  const [creating, setCreating] = useState(false)
  const [form, setForm] = useState({ tmcName: '', adminName: '', adminEmail: '' })
  const [selected, setSelected] = useState<Tmc | null>(null)
  const [staff, setStaff] = useState<Staff[]>([])
  const [adminForm, setAdminForm] = useState({ fullName: '', email: '' })
  const [importResult, setImportResult] = useState<{ created: number; skipped: number; errors: ImportError[] } | null>(null)

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  async function createTmc(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true); setError(''); setSuccess('')
    try {
      const d = await fetch('/api/platform/tmcs', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      }).then(r => r.json())
      if (!d.ok) { setError(d.error || 'Could not create the TMC.'); return }
      setForm({ tmcName: '', adminName: '', adminEmail: '' })
      setCreating(false)
      setSuccess(d.message)
      list.refetch()
    } finally { setBusy(false) }
  }

  async function openTmc(tmc: Tmc) {
    setSelected(tmc); setStaff([]); setImportResult(null)
    setAdminForm({ fullName: '', email: '' })
    setError(''); setSuccess('')
    const d = await fetch(`/api/platform/tmcs/${tmc.id}`).then(r => r.json())
    if (!d.ok) { setError(d.error || 'Could not load that TMC.'); return }
    setStaff(d.staff)
  }

  async function reloadStaff(tmcId: string) {
    const d = await fetch(`/api/platform/tmcs/${tmcId}`).then(r => r.json())
    if (d.ok) setStaff(d.staff)
  }

  async function addAdmin(e: React.FormEvent) {
    e.preventDefault()
    if (!selected) return
    setBusy(true); setError(''); setSuccess('')
    try {
      const d = await fetch(`/api/platform/tmcs/${selected.id}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(adminForm),
      }).then(r => r.json())
      if (!d.ok) { setError(d.error || 'Could not invite that admin.'); return }
      setAdminForm({ fullName: '', email: '' })
      setSuccess(d.message)
      await reloadStaff(selected.id)
      list.refetch()
    } finally { setBusy(false) }
  }

  async function toggleStatus(tmc: Tmc) {
    const next = tmc.status === 'active' ? 'inactive' : 'active'
    if (next === 'inactive' && !confirm(
      `Mark "${tmc.name}" inactive? Their data is kept — this is how a TMC is retired, since deleting one would take its clients and bookings with it.`
    )) return

    setBusy(true); setError('')
    try {
      const d = await fetch(`/api/platform/tmcs/${tmc.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: next }),
      }).then(r => r.json())
      if (!d.ok) { setError(d.error || 'Could not update the status.'); return }
      setSuccess(`"${tmc.name}" is now ${next}.`)
      if (selected?.id === tmc.id) setSelected({ ...selected, status: next })
      list.refetch()
    } finally { setBusy(false) }
  }

  async function importStaff(file: File) {
    if (!selected) return
    setBusy(true); setError(''); setSuccess(''); setImportResult(null)
    try {
      const rows = parseCsv(await file.text())
      if (rows.length === 0) { setError('That file has no rows.'); return }

      const d = await fetch(`/api/platform/tmcs/${selected.id}/staff-csv`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows }),
      }).then(r => r.json())

      if (!d.ok) { setError(d.error || 'Could not import that file.'); return }
      setImportResult({ created: d.created, skipped: d.skipped, errors: d.errors })
      await reloadStaff(selected.id)
      list.refetch()
    } finally { setBusy(false) }
  }

  return (
    <div>
      <div style={s.header}>
        <div>
          <h1 style={s.title}>Travel management companies</h1>
          <p style={s.sub}>
            Every tenant on the platform. Creating one here does exactly what the internal API
            does — the two share an implementation, so they cannot behave differently.
          </p>
        </div>
        <button onClick={() => { setCreating(c => !c); setError(''); setSuccess('') }} style={s.primaryBtn}>
          {creating ? 'Cancel' : 'New TMC'}
        </button>
      </div>

      {error && <div style={s.errorBanner}>{error}</div>}
      {success && <div style={s.successBanner}>{success}</div>}

      {creating && (
        <form onSubmit={createTmc} style={s.card}>
          <p style={s.sectionLabel}>New TMC</p>
          <div style={s.row}>
            <div style={s.field}>
              <label style={s.label}>TMC name</label>
              <input required value={form.tmcName}
                onChange={e => setForm(f => ({ ...f, tmcName: e.target.value }))}
                placeholder="Corporate Travel Worldwide" style={s.input} />
            </div>
            <div style={s.field}>
              <label style={s.label}>First admin&rsquo;s name</label>
              <input required value={form.adminName}
                onChange={e => setForm(f => ({ ...f, adminName: e.target.value }))}
                placeholder="Sarah Jones" style={s.input} />
            </div>
            <div style={s.field}>
              <label style={s.label}>First admin&rsquo;s email</label>
              <input required type="email" value={form.adminEmail}
                onChange={e => setForm(f => ({ ...f, adminEmail: e.target.value }))}
                placeholder="admin@ctw.com" style={s.input} />
            </div>
          </div>
          <p style={s.hint}>
            Creates the TMC and emails an invite. If any step fails the whole thing is undone —
            there is no half-created TMC to clean up.
          </p>
          <div style={s.actions}>
            <button type="submit" disabled={busy} style={{ ...s.primaryBtn, opacity: busy ? 0.5 : 1 }}>
              {busy ? 'Creating…' : 'Create and invite'}
            </button>
          </div>
        </form>
      )}

      <div style={s.filters}>
        <input value={list.search} onChange={e => list.setSearch(e.target.value)}
          placeholder="Search TMCs" style={s.searchInput} />
      </div>

      {list.loading ? (
        <SkeletonTable rows={8} cols={6} />
      ) : list.items.length === 0 ? (
        <div style={s.empty}>
          <p style={s.emptyTitle}>{list.search ? 'No TMCs match that search' : 'No TMCs yet'}</p>
          <p style={s.emptyDesc}>
            {list.search ? 'Search covers every TMC, not just this page.' : 'Create the first one above.'}
          </p>
        </div>
      ) : (
        <>
          <div style={{ ...s.tableWrap, ...(list.refreshing ? s.dimmed : {}) }}>
            <table style={s.table}>
              <thead>
                <tr>
                  {['TMC', 'Status', 'Clients', 'Staff', 'Admins', 'Created', ''].map(h => (
                    <th key={h} style={s.th}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {list.items.map((t, i) => (
                  <tr key={t.id} style={{ background: i % 2 === 0 ? '#fff' : '#FAFAFA' }}>
                    <td style={s.td}>
                      <button onClick={() => openTmc(t)} style={s.linkBtn}>{t.name}</button>
                    </td>
                    <td style={s.td}>
                      <span style={{ ...s.pill, ...(STATUS_STYLE[t.status] ?? {}) }}>{t.status}</span>
                    </td>
                    <td style={s.num}>{t.clientCount}</td>
                    <td style={s.num}>{t.staffCount}</td>
                    <td style={s.num}>{t.adminCount}</td>
                    <td style={s.dates}>{new Date(t.created_at).toLocaleDateString()}</td>
                    <td style={{ ...s.td, textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <button onClick={() => toggleStatus(t)} disabled={busy} style={s.ghostBtn}>
                        {t.status === 'active' ? 'Deactivate' : 'Reactivate'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <Pagination
            page={list.page} pageSize={10} total={list.total}
            onPageChange={list.setPage} busy={list.refreshing} noun="TMCs"
          />
        </>
      )}

      {/* ── One TMC ───────────────────────────────────────────────────────── */}
      {selected && (
        <div style={{ ...s.card, marginTop: 22 }}>
          <div style={s.detailHead}>
            <h2 style={s.detailTitle}>{selected.name}</h2>
            <button onClick={() => setSelected(null)} style={s.ghostBtn}>Close</button>
          </div>

          <p style={s.sectionLabel}>Staff</p>
          {staff.length === 0 ? (
            <p style={s.hint}>Nobody yet.</p>
          ) : (
            <div style={s.tableWrap}>
              <table style={s.table}>
                <thead>
                  <tr>{['Name', 'Email', 'Role', 'Status'].map(h => <th key={h} style={s.th}>{h}</th>)}</tr>
                </thead>
                <tbody>
                  {staff.map((m, i) => (
                    <tr key={m.id} style={{ background: i % 2 === 0 ? '#fff' : '#FAFAFA' }}>
                      <td style={s.td}>{m.full_name}</td>
                      <td style={{ ...s.td, color: '#6B7280' }}>{m.email}</td>
                      <td style={s.td}>{m.role === 'tmc_admin' ? 'Admin' : 'Counsellor'}</td>
                      <td style={s.td}>
                        <span style={{ ...s.pill, ...(STATUS_STYLE[m.status] ?? {}) }}>{m.status}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <p style={s.sectionLabel}>Invite another admin</p>
          <form onSubmit={addAdmin} style={s.row}>
            <div style={s.field}>
              <label style={s.label}>Name</label>
              <input required value={adminForm.fullName}
                onChange={e => setAdminForm(f => ({ ...f, fullName: e.target.value }))}
                style={s.input} />
            </div>
            <div style={s.field}>
              <label style={s.label}>Email</label>
              <input required type="email" value={adminForm.email}
                onChange={e => setAdminForm(f => ({ ...f, email: e.target.value }))}
                style={s.input} />
            </div>
            <button type="submit" disabled={busy} style={{ ...s.primaryBtn, opacity: busy ? 0.5 : 1, alignSelf: 'flex-end' }}>
              Invite
            </button>
          </form>

          <p style={s.sectionLabel}>Counsellors by CSV</p>
          <p style={s.hint}>
            Download the current list, edit it, upload it back — the export is the template, so the
            columns always match. New emails are invited as counsellors; emails already here are
            skipped rather than updated, so re-uploading a file cannot rewrite somebody&rsquo;s
            permissions. Put permissions in one column, semicolon-separated.
          </p>
          <div style={{ ...s.actions, marginTop: 10 }}>
            {/* A real link, not a scripted download, so right-click and
                open-in-new-tab behave the way people expect. */}
            <a href={`/api/platform/tmcs/${selected.id}/staff-csv`} style={s.ghostLink}>
              Download CSV
            </a>
            <label style={{ ...s.ghostLink, cursor: busy ? 'not-allowed' : 'pointer' }}>
              Upload CSV
              <input
                type="file" accept=".csv,text/csv" disabled={busy}
                onChange={e => {
                  const file = e.target.files?.[0]
                  // Cleared so choosing the same file twice still fires a change
                  // event — otherwise a failed import cannot be retried.
                  e.target.value = ''
                  if (file) importStaff(file)
                }}
                style={{ display: 'none' }}
              />
            </label>
          </div>

          {importResult && (
            <div style={importResult.errors.length > 0 ? s.warnBanner : s.successBanner}>
              <strong>{importResult.created} created</strong>
              {importResult.skipped > 0 && `, ${importResult.skipped} already here`}
              {importResult.errors.length > 0 && (
                <ul style={s.errorList}>
                  {importResult.errors.map(err => (
                    <li key={`${err.row}-${err.email}`}>
                      Row {err.row}{err.email && ` (${err.email})`}: {err.error}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap', marginBottom: 18 },
  title: { fontSize: 20, fontWeight: 600, color: '#0A0A14', margin: '0 0 4px', letterSpacing: '-0.3px' },
  sub: { fontSize: 13, color: '#6B7280', margin: 0, lineHeight: 1.6, maxWidth: 620 },

  card: { background: '#fff', border: '1px solid #E5E7EB', borderRadius: 12, padding: 20, marginBottom: 18 },
  detailHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 },
  detailTitle: { fontSize: 16, fontWeight: 600, color: '#111827', margin: 0 },
  sectionLabel: { fontSize: 11, fontWeight: 700, color: '#9CA3AF', textTransform: 'uppercase', letterSpacing: '0.5px', margin: '18px 0 10px' },

  row: { display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-start' },
  field: { display: 'flex', flexDirection: 'column', gap: 5, flex: 1, minWidth: 200 },
  label: { fontSize: 11, fontWeight: 500, color: '#374151' },
  input: { height: 38, padding: '0 10px', fontSize: 13, color: '#111827', background: '#fff', border: '1px solid #D1D5DB', borderRadius: 7, outline: 'none' },
  hint: { fontSize: 12, color: '#6B7280', lineHeight: 1.6, margin: '8px 0 0', maxWidth: 680 },
  actions: { display: 'flex', gap: 10, alignItems: 'center', marginTop: 14, flexWrap: 'wrap' },

  filters: { display: 'flex', gap: 10, marginBottom: 12 },
  searchInput: { height: 36, padding: '0 10px', fontSize: 13, color: '#111827', background: '#fff', border: '1px solid #E5E7EB', borderRadius: 6, outline: 'none', flex: 1, maxWidth: 340 },

  tableWrap: { background: '#fff', border: '1px solid #E5E7EB', borderRadius: 10, overflowX: 'auto' },
  table: { borderCollapse: 'collapse', width: '100%', minWidth: 760 },
  th: { padding: '10px 14px', textAlign: 'left', background: '#F9FAFB', borderBottom: '1px solid #E5E7EB', fontSize: 11, fontWeight: 600, color: '#374151', whiteSpace: 'nowrap' },
  td: { padding: '10px 14px', fontSize: 13, color: '#374151', borderBottom: '1px solid #F3F4F6', verticalAlign: 'middle' },
  num: { padding: '10px 14px', fontSize: 13, color: '#374151', borderBottom: '1px solid #F3F4F6', fontVariantNumeric: 'tabular-nums' },
  dates: { padding: '10px 14px', fontSize: 12, color: '#6B7280', borderBottom: '1px solid #F3F4F6', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' },
  dimmed: { opacity: 0.55, transition: 'opacity 120ms ease' },

  pill: { display: 'inline-block', fontSize: 11, fontWeight: 600, borderRadius: 999, padding: '2px 9px', border: '1px solid transparent' },
  linkBtn: { background: 'none', border: 'none', padding: 0, fontSize: 13, fontWeight: 600, color: '#000835', cursor: 'pointer', textDecoration: 'underline', textUnderlineOffset: 2 },

  primaryBtn: { height: 36, padding: '0 16px', background: '#000835', color: '#fff', fontSize: 13, fontWeight: 600, border: 'none', borderRadius: 7, cursor: 'pointer' },
  ghostBtn: { height: 30, padding: '0 12px', background: '#fff', color: '#374151', fontSize: 12, border: '1px solid #D1D5DB', borderRadius: 6, cursor: 'pointer' },
  ghostLink: { display: 'inline-flex', alignItems: 'center', height: 30, padding: '0 12px', background: '#fff', color: '#374151', fontSize: 12, border: '1px solid #D1D5DB', borderRadius: 6, textDecoration: 'none' },

  empty: { background: '#fff', border: '1px dashed #D1D5DB', borderRadius: 10, padding: '28px 22px', textAlign: 'center' },
  emptyTitle: { fontSize: 14, fontWeight: 600, color: '#111827', margin: '0 0 5px' },
  emptyDesc: { fontSize: 12, color: '#6B7280', margin: 0 },

  errorBanner: { background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8, padding: '10px 14px', fontSize: 12, color: '#DC2626', marginBottom: 14 },
  successBanner: { background: '#ECFDF5', border: '1px solid #A7F3D0', borderRadius: 8, padding: '10px 14px', fontSize: 12, color: '#065F46', marginTop: 14 },
  warnBanner: { background: '#FEF3C7', border: '1px solid #FDE68A', borderRadius: 8, padding: '10px 14px', fontSize: 12, color: '#92400E', marginTop: 14, lineHeight: 1.6 },
  errorList: { margin: '8px 0 0', paddingLeft: 18 },
}
