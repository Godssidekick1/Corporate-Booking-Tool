'use client'

import { useEffect, useState } from 'react'
import PasswordInput from '@/app/components/PasswordInput'

// ── The flight provider account, on the platform console ─────────────────────
// Base URL, client code, user name and password of the Amadeus API, kept in
// the database (user, 2026-11-26), set here by a platform admin. The password
// is write-only: it is shown as "saved", never as text, and leaving it blank
// keeps the saved one. "Test the connection" signs in with what is typed
// before anything is saved.
// ─────────────────────────────────────────────────────────────────────────────

interface Provider {
  source: 'database' | 'environment' | 'none'
  baseUrl: string | null; clientCode: string | null; username: string | null
  passwordSet: boolean; updatedAt: string | null; updatedBy: string | null
}

export default function ProviderCard() {
  const [provider, setProvider] = useState<Provider | null>(null)
  const [keySet, setKeySet] = useState(true)
  const [editing, setEditing] = useState(false)
  const [form, setForm] = useState({ baseUrl: '', clientCode: '', username: '', password: '' })
  const [busy, setBusy] = useState<'test' | 'save' | null>(null)
  const [note, setNote] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)

  useEffect(() => {
    let live = true
    fetch('/api/platform/provider').then(r => r.json()).then(d => {
      if (!live || !d.ok) return
      setProvider(d.provider); setKeySet(d.keySet)
    }).catch(() => {})
    return () => { live = false }
  }, [])

  function startEdit() {
    setForm({ baseUrl: provider?.baseUrl ?? '', clientCode: provider?.clientCode ?? '', username: provider?.username ?? '', password: '' })
    setNote(null); setEditing(true)
  }

  async function send(kind: 'test' | 'save') {
    setBusy(kind); setNote(null)
    try {
      const res = await fetch(kind === 'test' ? '/api/platform/provider/test' : '/api/platform/provider', {
        method: kind === 'test' ? 'POST' : 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form),
      })
      const d = await res.json().catch(() => ({}))
      if (kind === 'test') {
        setNote(d.ok ? { kind: 'ok', text: d.message } : { kind: 'error', text: d.message || d.error || 'The test did not run.' })
        return
      }
      if (!res.ok) { setNote({ kind: 'error', text: d.error || 'Could not save.' }); return }
      setProvider(d.provider); setEditing(false)
      setNote({ kind: 'ok', text: 'Saved. New bookings use this account from now on.' })
    } catch {
      setNote({ kind: 'error', text: 'Could not reach the server. Check your connection and try again.' })
    } finally { setBusy(null) }
  }

  const chip = !provider ? null
    : provider.source === 'database' ? { text: 'Saved in the database', bg: 'var(--color-success-bg)', fg: 'var(--color-success-fg)' }
    : provider.source === 'environment' ? { text: 'From .env.local: save it here', bg: 'var(--color-warn-bg)', fg: 'var(--color-warn-fg)' }
    : { text: 'Not set up', bg: 'var(--color-danger-bg)', fg: 'var(--color-danger-fg)' }

  return (
    <section style={s.card} aria-labelledby="provider-title">
      <div style={s.head}>
        <div>
          <h2 id="provider-title" style={s.title}>Flight provider</h2>
          <p style={s.sub}>The Amadeus account every search, booking and ticket goes through.</p>
        </div>
        {chip && <span style={{ ...s.chip, background: chip.bg, color: chip.fg }}>{chip.text}</span>}
      </div>

      {!keySet && (
        <p style={s.warn}>
          <b>PROVIDER_CREDENTIALS_KEY is not set on this server.</b> The password is stored encrypted with it, so it must be in
          .env.local before anything can be saved. Generate one with{' '}
          <code style={s.code}>node -e &quot;console.log(require(&apos;crypto&apos;).randomBytes(32).toString(&apos;base64&apos;))&quot;</code>, add it, and restart.
        </p>
      )}
      {provider?.source === 'environment' && !editing && (
        <p style={s.warn}>The app is still reading these from .env.local. Save them here (Edit, then Save), then delete the AMADEUS_* lines from that file.</p>
      )}

      {!editing && provider && (
        <dl style={s.rows}>
          <Row k="Base URL" v={provider.baseUrl} mono />
          <Row k="Client code" v={provider.clientCode} mono />
          <Row k="User name" v={provider.username} mono />
          <Row k="Password" v={provider.passwordSet ? (provider.source === 'database' ? 'Saved, encrypted' : 'Set in .env.local') : null} />
          {provider.updatedAt && (
            <Row k="Last changed" v={`${new Date(provider.updatedAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}${provider.updatedBy ? ` by ${provider.updatedBy}` : ''}`} />
          )}
        </dl>
      )}

      {editing && (
        <div style={s.form}>
          <Field label="Base URL" hint="Starts with https://">
            <input style={s.input} value={form.baseUrl} onChange={e => setForm({ ...form, baseUrl: e.target.value })} placeholder="https://…" autoComplete="off" />
          </Field>
          <Field label="Client code">
            <input style={s.input} value={form.clientCode} onChange={e => setForm({ ...form, clientCode: e.target.value })} autoComplete="off" />
          </Field>
          <Field label="User name">
            <input style={s.input} value={form.username} onChange={e => setForm({ ...form, username: e.target.value })} autoComplete="off" />
          </Field>
          <Field label="Password" hint={provider?.source === 'database' ? 'Leave blank to keep the saved one.' : 'Required.'}>
            <PasswordInput style={s.input} value={form.password} onChange={password => setForm({ ...form, password })}
              autoComplete="new-password" placeholder={provider?.source === 'database' ? '•••••••• (saved)' : ''} />
          </Field>
        </div>
      )}

      {note && <p role="status" style={{ ...s.note, ...(note.kind === 'ok' ? s.noteOk : s.noteError) }}>{note.text}</p>}

      <div style={s.actions}>
        {!editing ? (
          <button type="button" style={s.primary} onClick={startEdit} disabled={!provider}>Edit</button>
        ) : (
          <>
            <button type="button" style={s.ghost} onClick={() => { setEditing(false); setNote(null) }} disabled={!!busy}>Cancel</button>
            <button type="button" style={s.ghost} onClick={() => send('test')} disabled={!!busy}>{busy === 'test' ? 'Testing…' : 'Test the connection'}</button>
            <button type="button" style={s.primary} onClick={() => send('save')} disabled={!!busy || !keySet}>{busy === 'save' ? 'Saving…' : 'Save'}</button>
          </>
        )}
      </div>
    </section>
  )
}

function Row({ k, v, mono }: { k: string; v: string | null; mono?: boolean }) {
  return (
    <div style={s.row}>
      <dt style={s.k}>{k}</dt>
      <dd style={{ ...s.v, ...(mono ? { fontFamily: 'var(--font-mono)' } : {}), ...(v ? {} : { color: 'var(--color-muted)' }) }}>{v ?? 'Not set'}</dd>
    </div>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <span style={s.label}>{label}</span>
      {children}
      {hint && <span style={s.hint}>{hint}</span>}
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  card: { background: '#fff', border: '1px solid #E5E7EB', borderRadius: 12, padding: 20, marginBottom: 24 },
  head: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' },
  title: { fontSize: 16, fontWeight: 700, color: '#0A0A14', margin: '0 0 2px' },
  sub: { fontSize: 13, color: '#6B7280', margin: 0 },
  chip: { fontSize: 11.5, fontWeight: 600, padding: '4px 10px', borderRadius: 999 },
  warn: { fontSize: 12.5, lineHeight: 1.5, color: 'var(--color-warn-fg)', background: 'var(--color-warn-bg)', border: '1px solid var(--color-warn-line)', borderRadius: 8, padding: '9px 12px', margin: '14px 0 0' },
  code: { fontFamily: 'var(--font-mono)', fontSize: 11.5, background: 'rgba(255,255,255,0.6)', padding: '1px 4px', borderRadius: 4 },
  rows: { margin: '16px 0 0', display: 'grid', gap: 2 },
  row: { display: 'grid', gridTemplateColumns: '140px 1fr', gap: 12, padding: '7px 0', borderBottom: '1px solid #F3F4F6' },
  k: { fontSize: 12.5, color: '#6B7280' },
  v: { margin: 0, fontSize: 13, color: '#0A0A14', wordBreak: 'break-all' },
  form: { marginTop: 16, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 14 },
  label: { fontSize: 11.5, fontWeight: 600, color: '#374151' },
  hint: { fontSize: 11.5, color: '#9CA3AF' },
  input: { height: 38, padding: '0 10px', fontSize: 13, color: '#111827', background: '#fff', border: '1px solid #D1D5DB', borderRadius: 7, outline: 'none', width: '100%', boxSizing: 'border-box' },
  note: { fontSize: 12.5, borderRadius: 8, padding: '8px 12px', margin: '14px 0 0' },
  noteOk: { background: 'var(--color-success-bg)', color: 'var(--color-success-fg)' },
  noteError: { background: 'var(--color-danger-bg)', color: 'var(--color-danger-fg)' },
  actions: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 },
  primary: { height: 36, padding: '0 16px', background: '#000835', color: '#fff', fontSize: 13, fontWeight: 600, border: 'none', borderRadius: 7, cursor: 'pointer' },
  ghost: { height: 36, padding: '0 14px', background: '#fff', color: '#374151', fontSize: 13, fontWeight: 600, border: '1px solid #D1D5DB', borderRadius: 7, cursor: 'pointer' },
}
