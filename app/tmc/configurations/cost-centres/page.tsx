'use client'

import { useState } from 'react'
import Pagination from '@/app/components/Pagination'
import SlideOver from '@/app/components/SlideOver'
import SearchableSelect from '@/app/components/SearchableSelect'
import { SkeletonTable } from '@/app/components/Skeleton'
import { usePagedList } from '@/app/hooks/usePagedList'
import { useLookup, clientOption } from '@/app/hooks/useLookup'
import { ListHeader, ListFilters, ListEmpty, list } from '@/app/components/config/ListPage'

// ── /tmc/configurations/cost-centres ─────────────────────────────────────────
// Every client's cost centres, with how many people sit on each, in the one
// list layout: shown straight away across all clients (a counsellor: their
// portfolio), narrowed by client or search. A row opens it to rename, recode
// (its people move with it) or delete (when nobody is on it).
//
// These were free text typed per employee, so "Sales", "sales" and "Sales "
// counted as three different things in any report. Kept here, the traveller
// profile screen offers them as a list.
// ─────────────────────────────────────────────────────────────────────────────

interface Centre { id: string; client_id: string; client_name: string | null; code: string; name: string; employees: number }
interface Unlisted { code: string; employees: number }

type Editing =
  | { mode: 'new'; clientId: string; code: string; name: string }
  | { mode: 'edit'; centre: Centre; code: string; name: string }

export default function CostCentresPage() {
  const [clientId, setClientId] = useState('')
  const clientLookup = useLookup('/api/tmc/clients', clientId, { toOption: clientOption })
  const centres = usePagedList<Centre>('/api/tmc/cost-centres', { params: { list: 1, clientId: clientId || undefined } })
  const unlisted = (centres.raw?.unlisted as Unlisted[] | undefined) ?? []

  const [editing, setEditing] = useState<Editing | null>(null)
  const formClient = editing?.mode === 'new' ? editing.clientId : ''
  const formClientLookup = useLookup('/api/tmc/clients', formClient, { toOption: clientOption })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [formError, setFormError] = useState('')
  const [success, setSuccess] = useState('')

  function done(message: string) {
    setEditing(null)
    setSuccess(message)
    centres.refetch()
  }

  async function send(method: 'POST' | 'PATCH', body: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    setBusy(true); setFormError(''); setError('')
    try {
      // Written out per method so each reads plainly as a write, not a list read.
      const init = { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      const res = method === 'POST'
        ? await fetch('/api/tmc/cost-centres', { method: 'POST', ...init })
        : await fetch('/api/tmc/cost-centres', { method: 'PATCH', ...init })
      const d = await res.json().catch(() => ({}))
      if (!res.ok || !d.ok) { setFormError(d.error || 'Could not save that cost centre.'); return null }
      return d
    } catch {
      setFormError('Could not reach the server. Check your connection and try again.')
      return null
    } finally {
      setBusy(false)
    }
  }

  async function save(e: React.FormEvent) {
    e.preventDefault()
    if (!editing) return
    if (editing.mode === 'new') {
      if (!editing.clientId) { setFormError('Choose the client this cost centre belongs to.'); return }
      const d = await send('POST', { clientId: editing.clientId, code: editing.code, name: editing.name })
      if (d) done(`"${editing.code.trim()}" added.`)
    } else {
      const d = await send('PATCH', {
        clientId: editing.centre.client_id, previousCode: editing.centre.code, code: editing.code, name: editing.name,
      })
      const moved = Number(d?.moved ?? 0)
      if (d) done(moved > 0 ? `Saved, and ${moved} ${moved === 1 ? 'person' : 'people'} moved to the new code.` : 'Cost centre saved.')
    }
  }

  async function remove(c: Centre) {
    if (c.employees > 0) return
    if (!confirm(`Delete cost centre "${c.code}" of ${c.client_name ?? 'this client'}?`)) return
    setBusy(true); setFormError('')
    try {
      const res = await fetch(`/api/tmc/cost-centres?clientId=${c.client_id}&code=${encodeURIComponent(c.code)}`, { method: 'DELETE' })
      const d = await res.json().catch(() => ({}))
      if (!res.ok || !d.ok) { setFormError(d.error || 'Could not delete it.'); return }
      done(`"${c.code}" deleted.`)
    } finally { setBusy(false) }
  }

  async function adopt(code: string) {
    if (!clientId) return
    setSuccess(''); setError(''); setBusy(true)
    try {
      const res = await fetch('/api/tmc/cost-centres', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId, code, name: code }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok || !d.ok) { setError(d.error || 'Could not add that cost centre.'); return }
      setSuccess(`"${code}" added to the list.`)
      centres.refetch()
    } catch {
      setError('Could not reach the server. Check your connection and try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={list.root}>
      <ListHeader
        title="Cost centres"
        description="Each client's cost centres and how many people sit on each. Rename one and its people move with it."
        actions={<button type="button" style={list.primaryBtn}
          onClick={() => { setFormError(''); setEditing({ mode: 'new', clientId, code: '', name: '' }) }}>New cost centre</button>}
      />

      <ListFilters>
        <div style={list.picker}>
          <SearchableSelect
            value={clientId} onChange={id => { setClientId(id); centres.setPage(1) }}
            options={clientLookup.options} onSearch={clientLookup.onSearch} loading={clientLookup.loading}
            selectedLabel={clientLookup.selectedLabel}
            placeholder="All clients" emptyMessage="No clients match" allowClear clearLabel="All clients"
          />
        </div>
        <input
          type="search" value={centres.search} onChange={e => centres.setSearch(e.target.value)}
          placeholder="Search code, name or client" style={list.search} aria-label="Search cost centres"
        />
      </ListFilters>

      {error && <div style={list.errorBanner}>{error}</div>}
      {success && <div style={list.successBanner}>{success}</div>}

      {clientId && unlisted.length > 0 && (
        <div style={list.warnBanner}>
          <strong>{unlisted.length} code{unlisted.length === 1 ? '' : 's'} in use but not on the list</strong>, from an
          import or older data:{' '}
          {unlisted.map(u => (
            <button key={u.code} type="button" onClick={() => adopt(u.code)} disabled={busy}
              style={{ ...list.ghostBtn, height: 26, margin: '0 6px 4px 0', fontSize: 12 }}>
              Add {u.code} ({u.employees})
            </button>
          ))}
        </div>
      )}

      {centres.error ? (
        <p style={list.errorBanner}><strong>Could not load cost centres.</strong> {centres.error}</p>
      ) : centres.loading ? (
        <SkeletonTable rows={8} cols={4} />
      ) : centres.items.length === 0 ? (
        <ListEmpty
          title={centres.search || clientId ? 'No cost centres match' : 'No cost centres yet'}
          description={centres.search || clientId ? 'Try another client or search.' : 'Add a client’s cost centres so their people can be put on them.'}
        />
      ) : (
        <div style={{ ...list.tableWrap, ...(centres.refreshing ? list.dimmed : {}) }}>
          <table style={list.table}>
            <thead><tr>{['Code', 'Name', 'Client', 'People'].map(h => <th key={h} style={{ ...list.th, ...(h === 'People' ? list.num : {}) }}>{h}</th>)}</tr></thead>
            <tbody>
              {centres.items.map(c => (
                <tr key={c.id} style={list.row} onClick={() => { setFormError(''); setEditing({ mode: 'edit', centre: c, code: c.code, name: c.name }) }}>
                  <td style={{ ...list.td, ...list.mono, ...list.name }}>{c.code}</td>
                  <td style={list.td}>{c.name}</td>
                  <td style={list.td}>{c.client_name ?? <span style={list.muted}>—</span>}</td>
                  <td style={{ ...list.td, ...list.num }}>{c.employees}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Pagination page={centres.page} pageSize={10} total={centres.total} onPageChange={centres.setPage} busy={centres.refreshing} noun="cost centres" />

      <SlideOver
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing?.mode === 'edit' ? editing.centre.code : 'New cost centre'}
        subtitle={editing?.mode === 'edit' ? `${editing.centre.client_name ?? ''} · ${editing.centre.employees} ${editing.centre.employees === 1 ? 'person' : 'people'}` : undefined}
        footer={editing && (
          <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between', width: '100%' }}>
            <div>
              {editing.mode === 'edit' && (
                <button type="button" style={{ ...list.dangerBtn, opacity: editing.centre.employees > 0 ? 0.5 : 1 }}
                  disabled={busy || editing.centre.employees > 0} onClick={() => remove(editing.centre)}
                  title={editing.centre.employees > 0 ? 'Move its people to another cost centre first' : undefined}>
                  Delete
                </button>
              )}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" style={list.ghostBtn} onClick={() => setEditing(null)}>Cancel</button>
              <button type="submit" form="centre-form" style={{ ...list.primaryBtn, opacity: busy ? 0.6 : 1 }} disabled={busy}>
                {busy ? 'Saving…' : editing.mode === 'new' ? 'Add cost centre' : 'Save'}
              </button>
            </div>
          </div>
        )}
      >
        {editing && (
          <form id="centre-form" onSubmit={save} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {editing.mode === 'new' && (
              <label style={field}>
                <span style={label}>Client</span>
                <SearchableSelect
                  value={editing.clientId} onChange={id => setEditing({ ...editing, clientId: id })}
                  options={formClientLookup.options} onSearch={formClientLookup.onSearch} loading={formClientLookup.loading}
                  selectedLabel={formClientLookup.selectedLabel}
                  placeholder="Choose a client" emptyMessage="No clients match"
                />
              </label>
            )}
            <label style={field}>
              <span style={label}>Code</span>
              <input required value={editing.code} onChange={e => setEditing({ ...editing, code: e.target.value.toUpperCase() })}
                style={{ ...list.input, ...list.mono }} placeholder="SALES-N" />
              {editing.mode === 'edit' && editing.code.trim() !== editing.centre.code && editing.centre.employees > 0 && (
                <span style={hint}>Its {editing.centre.employees} {editing.centre.employees === 1 ? 'person moves' : 'people move'} to the new code.</span>
              )}
            </label>
            <label style={field}>
              <span style={label}>Name</span>
              <input required value={editing.name} onChange={e => setEditing({ ...editing, name: e.target.value })}
                style={list.input} placeholder="Sales, North" />
            </label>
            {editing.mode === 'edit' && editing.centre.employees > 0 && (
              <span style={hint}>It cannot be deleted while people sit on it: move them in Traveller profiles first.</span>
            )}
            {formError && <div style={list.errorBanner}>{formError}</div>}
          </form>
        )}
      </SlideOver>
    </div>
  )
}

const field: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 5 }
const label: React.CSSProperties = { fontSize: 11, fontWeight: 600, color: '#374151' }
const hint: React.CSSProperties = { fontSize: 11.5, color: '#6B7280', lineHeight: 1.5 }
