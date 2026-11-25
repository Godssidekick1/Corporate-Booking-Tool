'use client'

import { useEffect, useState } from 'react'
import Pagination from '@/app/components/Pagination'
import SlideOver from '@/app/components/SlideOver'
import { sealForm, SealUnavailable } from '@/app/lib/auth/sealClient'
import BookingHistory from '@/app/components/BookingHistory'
import { SkeletonTable } from '@/app/components/Skeleton'
import { usePagedList } from '@/app/hooks/usePagedList'
import { ListHeader, ListFilters, ListEmpty, list } from '@/app/components/config/ListPage'
import { CLIENT_ROLES, CLIENT_ROLE_LABEL, isClientRole, type ClientRole } from '@/app/lib/clients/roles'

// ── /settings/users ──────────────────────────────────────────────────────────
// The company's people, in the same list layout as the travel desk's screens:
// search and filters, a table that opens each person in a panel. In the panel
// an admin changes someone's role (confirmed first, and recorded), deactivates
// or reactivates them, and sees their bookings. Bands and reporting lines are
// shown but set by the travel desk, because policy and approvals follow them.
// ─────────────────────────────────────────────────────────────────────────────

interface Employee {
  id: string
  full_name: string
  email: string
  role: string
  status: string
  band_code: string | null
  department: string | null
  cost_centre: string | null
  onboarding_method: string | null
}
interface Band { id: string; code: string; label: string; rank: number }

// Mirrors MIN_INITIAL_PASSWORD in app/api/employees/route.ts.
const MIN_INITIAL_PASSWORD = 10

const STATUS_STYLE: Record<string, React.CSSProperties> = {
  active: { color: '#065F46', background: '#ECFDF5' },
  invited: { color: '#92400E', background: '#FEF3C7' },
  deactivated: { color: '#6B7280', background: '#F3F4F6' },
}
const STATUS_LABEL: Record<string, string> = { active: 'Active', invited: 'Invited', deactivated: 'Deactivated' }
const ROLE_HELP: Record<ClientRole, string> = {
  admin: 'Manages the company’s users and settings, and books for colleagues where the company books for itself.',
  finance: 'Approves where an approval chain names finance, and sees spend reports.',
  employee: 'Travels and books for themselves.',
}

type Adding = 'invite' | 'direct' | null

export default function SettingsUsersPage() {
  const [role, setRole] = useState('')
  const [status, setStatus] = useState('')
  const people = usePagedList<Employee>('/api/settings/users', { params: { role: role || undefined, status: status || undefined } })

  const [bands, setBands] = useState<Band[]>([])
  useEffect(() => {
    let live = true
    fetch('/api/settings/bands').then(r => r.json()).then(d => { if (live && d.ok) setBands(d.bands) }).catch(() => {})
    return () => { live = false }
  }, [])

  const [open, setOpen] = useState<Employee | null>(null)
  const [adding, setAdding] = useState<Adding>(null)
  const [success, setSuccess] = useState('')

  function done(message: string) {
    setSuccess(message)
    setAdding(null)
    people.refetch()
  }

  return (
    <div style={list.root}>
      <ListHeader
        title="Users"
        description={`${people.total} ${people.total === 1 ? 'person' : 'people'} in your company. Open someone to change their role, deactivate them or see their bookings.`}
        actions={<>
          <button type="button" style={list.ghostBtn} onClick={() => setAdding('direct')}>Add directly</button>
          <button type="button" style={list.primaryBtn} onClick={() => setAdding('invite')}>Invite by email</button>
        </>}
      />

      <ListFilters>
        <input type="search" value={people.search} onChange={e => people.setSearch(e.target.value)}
          placeholder="Search name, email, department or cost centre" style={list.search} aria-label="Search people" />
        <select value={role} onChange={e => { setRole(e.target.value); people.setPage(1) }} style={list.input} aria-label="Role">
          <option value="">Any role</option>
          {CLIENT_ROLES.map(r => <option key={r} value={r}>{CLIENT_ROLE_LABEL[r]}</option>)}
        </select>
        <select value={status} onChange={e => { setStatus(e.target.value); people.setPage(1) }} style={list.input} aria-label="Status">
          <option value="">Any status</option>
          {Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </ListFilters>

      {success && <div style={list.successBanner}>{success}</div>}

      {people.error ? (
        <p style={list.errorBanner}><strong>Could not load people.</strong> {people.error}</p>
      ) : people.loading ? (
        <SkeletonTable rows={8} cols={5} />
      ) : people.items.length === 0 ? (
        <ListEmpty
          title={people.search || role || status ? 'Nobody matches' : 'No people yet'}
          description={people.search || role || status ? 'Search covers everyone, not just this page.' : 'Invite your first colleague with the button above.'}
        />
      ) : (
        <div style={{ ...list.tableWrap, ...(people.refreshing ? list.dimmed : {}) }}>
          <table style={list.table}>
            <thead><tr>{['Person', 'Role', 'Department', 'Band', 'Status'].map(h => <th key={h} style={list.th}>{h}</th>)}</tr></thead>
            <tbody>
              {people.items.map(p => (
                <tr key={p.id} style={list.row} onClick={() => setOpen(p)}>
                  <td style={list.td}>
                    <span style={list.name}>{p.full_name}</span>
                    <span style={list.sublabel}>{p.email}</span>
                  </td>
                  <td style={list.td}>
                    {p.role === 'admin' || p.role === 'finance'
                      ? <span style={{ ...list.pill, ...(p.role === 'admin' ? adminTag : financeTag) }}>{CLIENT_ROLE_LABEL[p.role as ClientRole]}</span>
                      : <span style={list.muted}>Employee</span>}
                  </td>
                  <td style={list.td}>{p.department || <span style={list.muted}>—</span>}</td>
                  <td style={list.td}>{p.band_code ? <span style={{ ...list.pill, ...bandTag }}>{p.band_code}</span> : <span style={list.muted}>—</span>}</td>
                  <td style={list.td}><span style={{ ...list.pill, ...(STATUS_STYLE[p.status] ?? {}) }}>{STATUS_LABEL[p.status] ?? p.status}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Pagination page={people.page} pageSize={10} total={people.total} onPageChange={people.setPage} busy={people.refreshing} noun="people" />

      <PersonPanel
        person={open}
        bands={bands}
        onClose={() => setOpen(null)}
        onChanged={(next, message) => { setOpen(next); setSuccess(message); people.refetch() }}
      />

      <SlideOver open={adding !== null} onClose={() => setAdding(null)}
        title={adding === 'invite' ? 'Invite by email' : 'Add directly'}
        subtitle={adding === 'invite'
          ? 'They get an email invite and choose their own password.'
          : 'The account is created now with a starting password you pass on; they change it on first sign-in.'}>
        {adding && <AddForm mode={adding} bands={bands} onDone={done} />}
      </SlideOver>
    </div>
  )
}

// ── One person ───────────────────────────────────────────────────────────────

function PersonPanel({ person, bands, onClose, onChanged }: {
  person: Employee | null
  bands: Band[]
  onClose: () => void
  onChanged: (next: Employee, message: string) => void
}) {
  const [ask, setAsk] = useState<ClientRole | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [tab, setTab] = useState<'details' | 'bookings'>('details')

  // A different person: a fresh panel.
  const [shownId, setShownId] = useState<string | null>(null)
  if (person && person.id !== shownId) {
    setShownId(person.id); setAsk(null); setError(''); setTab('details')
  }

  async function patch(body: Record<string, unknown>, message: string) {
    if (!person) return
    setBusy(true); setError('')
    try {
      const res = await fetch(`/api/settings/users/${person.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setError(d.error || 'Could not save that change.'); return }
      setAsk(null)
      onChanged({ ...person, ...(body as Partial<Employee>) }, message)
    } catch {
      setError('Could not reach the server. Check your connection and try again.')
    } finally {
      setBusy(false)
    }
  }

  const band = person?.band_code ? bands.find(b => b.code === person.band_code) : null
  const currentRole: ClientRole = person && isClientRole(person.role) ? person.role : 'employee'

  return (
    <SlideOver open={person !== null} onClose={onClose}
      title={person?.full_name ?? ''}
      subtitle={person ? `${person.email} · ${STATUS_LABEL[person.status] ?? person.status}` : undefined}>
      {person && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ display: 'flex', gap: 6 }}>
            {(['details', 'bookings'] as const).map(t => (
              <button key={t} type="button" onClick={() => setTab(t)} aria-pressed={tab === t}
                style={{ ...chip, ...(tab === t ? chipOn : {}) }}>{t === 'details' ? 'Details' : 'Bookings'}</button>
            ))}
          </div>

          {tab === 'bookings' ? (
            <BookingHistory params={{ traveller: person.id }} columns={['bookedBy']} empty={`${person.full_name} has no bookings yet.`} />
          ) : (
            <>
              <section style={card}>
                <div style={cardHead}>
                  <div>
                    <div style={cardTitle}>Role</div>
                    <div style={hint}>{ROLE_HELP[currentRole]}</div>
                  </div>
                  <div style={seg} role="group" aria-label="Role">
                    {CLIENT_ROLES.map(r => (
                      <button key={r} type="button" disabled={busy || person.status === 'deactivated'} aria-pressed={currentRole === r}
                        onClick={() => setAsk(r === currentRole ? null : r)}
                        style={{ ...segBtn, ...(currentRole === r ? segBtnOn : {}) }}>{CLIENT_ROLE_LABEL[r]}</button>
                    ))}
                  </div>
                </div>
                {ask && (
                  <div style={confirm}>
                    <span>
                      {ask === 'admin'
                        ? `Make ${person.full_name} a corporate admin? They will manage the company’s users and settings.`
                        : currentRole === 'admin'
                          ? `Remove ${person.full_name} as corporate admin? They will become ${CLIENT_ROLE_LABEL[ask]}.`
                          : `Change ${person.full_name} to ${CLIENT_ROLE_LABEL[ask]}?`}
                    </span>
                    <span style={{ display: 'flex', gap: 6 }}>
                      <button type="button" style={list.primaryBtn} disabled={busy}
                        onClick={() => patch({ role: ask }, `${person.full_name} is now ${CLIENT_ROLE_LABEL[ask]}.`)}>
                        {busy ? 'Saving…' : 'Confirm'}
                      </button>
                      <button type="button" style={list.ghostBtn} onClick={() => setAsk(null)} disabled={busy}>Cancel</button>
                    </span>
                  </div>
                )}
              </section>

              <section style={card}>
                <div style={cardTitle}>Travel profile</div>
                <dl style={facts}>
                  <dt style={dt}>Band</dt>
                  <dd style={dd}>{person.band_code ? `${person.band_code}${band?.label && band.label !== person.band_code ? `: ${band.label}` : ''}` : '—'}</dd>
                  <dt style={dt}>Department</dt><dd style={dd}>{person.department || '—'}</dd>
                  <dt style={dt}>Cost centre</dt><dd style={dd}>{person.cost_centre || '—'}</dd>
                </dl>
                <p style={hint}>Bands and reporting lines are set by your travel desk: travel policy and approvals follow them.</p>
              </section>

              {person.status !== 'invited' && (
                <section style={card}>
                  <div style={cardTitle}>Access</div>
                  <p style={hint}>
                    {person.status === 'active'
                      ? 'Deactivating signs them out everywhere and stops them signing in. Their bookings stay.'
                      : 'Reactivating lets them sign in again.'}
                  </p>
                  <div>
                    <button type="button" disabled={busy}
                      style={person.status === 'active' ? list.dangerBtn : list.ghostBtn}
                      onClick={() => patch(
                        { status: person.status === 'active' ? 'deactivated' : 'active' },
                        person.status === 'active' ? `${person.full_name} is deactivated.` : `${person.full_name} is active again.`,
                      )}>
                      {person.status === 'active' ? 'Deactivate' : 'Reactivate'}
                    </button>
                  </div>
                </section>
              )}

              {error && <div style={list.errorBanner}>{error}</div>}
            </>
          )}
        </div>
      )}
    </SlideOver>
  )
}

// ── Adding someone: by invite, or directly with a starting password ─────────

function AddForm({ mode, bands, onDone }: { mode: 'invite' | 'direct'; bands: Band[]; onDone: (message: string) => void }) {
  const [form, setForm] = useState({ full_name: '', email: '', role: 'employee', band: '', department: '', cost_centre: '', password: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const set = (k: keyof typeof form, v: string) => setForm(f => ({ ...f, [k]: v }))
  // The least senior band by default: the one most new people join.
  const band = form.band || bands[bands.length - 1]?.code || ''

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    if (mode === 'direct' && form.password.length < MIN_INITIAL_PASSWORD) {
      setError(`The starting password must be at least ${MIN_INITIAL_PASSWORD} characters.`)
      return
    }
    setBusy(true)
    try {
      // The starting password is sealed, never sent as text
      // (app/lib/auth/sealClient.ts). It stays visible on this form so the
      // admin can pass it on.
      const { password, ...details } = form
      const body = mode === 'invite'
        ? { email: form.email, full_name: form.full_name, role: form.role, band }
        : { ...details, band, method: 'direct', sealed: await sealForm('starting-password', { password }) }
      const res = await fetch('/api/employees', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setError(d.error || (mode === 'invite' ? 'Could not send the invite.' : 'Could not add them.')); return }
      onDone(mode === 'invite' ? `Invite sent to ${form.email}.` : `${form.full_name} added.`)
    } catch (err) {
      setError(err instanceof SealUnavailable ? err.message : 'Could not reach the server. Check your connection and try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Field label="Full name"><input required value={form.full_name} onChange={e => set('full_name', e.target.value)} style={list.input} placeholder="Jane Smith" /></Field>
      <Field label="Work email"><input required type="email" value={form.email} onChange={e => set('email', e.target.value)} style={list.input} placeholder="jane@company.com" /></Field>
      {mode === 'direct' && (
        <Field label="Starting password" hint="Shown in plain text so you can pass it on. They must change it on first sign-in.">
          <input required minLength={MIN_INITIAL_PASSWORD} value={form.password} onChange={e => set('password', e.target.value)} style={list.input}
            placeholder={`At least ${MIN_INITIAL_PASSWORD} characters`} />
        </Field>
      )}
      <Field label="Role">
        <select value={form.role} onChange={e => set('role', e.target.value)} style={list.input}>
          {CLIENT_ROLES.map(r => <option key={r} value={r}>{CLIENT_ROLE_LABEL[r]}</option>)}
        </select>
      </Field>
      <Field label="Band" hint={bands.length === 0 ? 'Your company has no bands yet: ask your travel desk to set them up.' : undefined}>
        <select value={band} onChange={e => set('band', e.target.value)} style={list.input} required disabled={bands.length === 0}>
          {bands.map(b => <option key={b.id} value={b.code}>{b.code}{b.label && b.label !== b.code ? ` — ${b.label}` : ''}</option>)}
        </select>
      </Field>
      {mode === 'direct' && (
        <>
          <Field label="Department (optional)"><input value={form.department} onChange={e => set('department', e.target.value)} style={list.input} /></Field>
          <Field label="Cost centre (optional)"><input value={form.cost_centre} onChange={e => set('cost_centre', e.target.value)} style={list.input} /></Field>
        </>
      )}
      {error && <div style={list.errorBanner}>{error}</div>}
      <div>
        <button type="submit" style={{ ...list.primaryBtn, opacity: busy || bands.length === 0 ? 0.6 : 1 }} disabled={busy || bands.length === 0}>
          {busy ? 'Saving…' : mode === 'invite' ? 'Send invite' : 'Add person'}
        </button>
      </div>
    </form>
  )
}

function Field({ label, hint: help, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <span style={{ fontSize: 11, fontWeight: 600, color: '#374151' }}>{label}</span>
      {children}
      {help && <span style={hint}>{help}</span>}
    </label>
  )
}

const adminTag: React.CSSProperties = { color: '#fff', background: '#000835' }
const financeTag: React.CSSProperties = { color: '#065F46', background: '#ECFDF5' }
const bandTag: React.CSSProperties = { color: '#3730A3', background: '#EEF2FF' }
const card: React.CSSProperties = { border: '1px solid #E5E7EB', borderRadius: 10, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10 }
const cardHead: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }
const cardTitle: React.CSSProperties = { fontSize: 12, fontWeight: 700, color: '#111827', textTransform: 'uppercase', letterSpacing: '0.5px' }
const hint: React.CSSProperties = { fontSize: 12, color: '#6B7280', lineHeight: 1.5, margin: 0 }
const seg: React.CSSProperties = { display: 'inline-flex', background: '#F3F4F6', borderRadius: 8, padding: 3, gap: 2 }
const segBtn: React.CSSProperties = { border: 0, background: 'transparent', borderRadius: 6, padding: '6px 10px', fontSize: 12, color: '#6B7280', cursor: 'pointer' }
const segBtnOn: React.CSSProperties = { background: '#fff', color: '#111827', fontWeight: 600, boxShadow: '0 1px 2px rgba(0,0,0,0.08)' }
const confirm: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', background: '#F5F7FF', border: '1px solid #E0E7FF', borderRadius: 8, padding: '10px 12px', fontSize: 12.5, color: '#1E1B4B', lineHeight: 1.45 }
const facts: React.CSSProperties = { margin: 0, display: 'grid', gridTemplateColumns: '110px 1fr', gap: '6px 12px', fontSize: 13 }
const dt: React.CSSProperties = { color: '#6B7280' }
const dd: React.CSSProperties = { margin: 0, color: '#111827' }
const chip: React.CSSProperties = { border: '1px solid #E5E7EB', background: '#fff', borderRadius: 8, padding: '5px 12px', fontSize: 12.5, color: '#374151', cursor: 'pointer' }
const chipOn: React.CSSProperties = { background: '#000835', borderColor: '#000835', color: '#fff', fontWeight: 600 }
