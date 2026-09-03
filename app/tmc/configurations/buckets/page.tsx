'use client'

import { useCallback, useEffect, useState } from 'react'
import SearchableSelect from '@/app/components/SearchableSelect'

// ── /tmc/configurations/buckets ──────────────────────────────────────────────
// A bucket is a curated set of CLIENTS.
//
// Not the same thing as a client group, and the difference matters: a client
// group is the org hierarchy a client belongs to — a fact about them — while a
// bucket is a distribution decision someone made on purpose ("Tier 1
// corporates", "North India desk") and cuts across groups freely.
//
// Deliberately generic. Deal codes target buckets today; forms of payment and
// markup will target the same ones, which is why this is its own master rather
// than a tab inside deal codes.
// ─────────────────────────────────────────────────────────────────────────────

interface Bucket {
  id: string
  name: string
  code: string | null
  description: string | null
  clientCount: number
  dealCodeCount: number
}
interface Client { id: string; name: string }
interface DealCodeRef { id: string; code: string; code_type: string; airline_code: string }

export default function BucketsPage() {
  const [buckets, setBuckets] = useState<Bucket[]>([])
  const [clients, setClients] = useState<Client[]>([])

  const [selectedId, setSelectedId] = useState('')
  const [members, setMembers] = useState<Client[]>([])
  const [dealCodes, setDealCodes] = useState<DealCodeRef[]>([])
  const [detail, setDetail] = useState({ name: '', code: '', description: '' })

  const [addClientId, setAddClientId] = useState('')
  const [creating, setCreating] = useState(false)
  const [newBucket, setNewBucket] = useState({ name: '', code: '', description: '' })

  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  // Declared above the effect that calls it: a function hoisted below its own
  // useEffect reads as available but does not update when its closure changes.
  const loadBuckets = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const d = await fetch('/api/tmc/buckets').then(r => r.json())
      if (!d.ok) { setError(d.error || 'Could not load buckets.'); return }
      setBuckets(d.buckets)
    } finally { setLoading(false) }
  }, [])

  useEffect(() => {
    // Fetch-on-mount, the pattern every screen here uses. The alternative is a
    // server component, which this cannot be — it is entirely interactive.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadBuckets()
    fetch('/api/tmc/clients').then(r => r.json())
      .then(d => { if (d.ok) setClients(d.clients ?? []) })
  }, [loadBuckets])

  async function openBucket(id: string) {
    setSelectedId(id)
    setError(''); setSuccess('')
    const d = await fetch(`/api/tmc/buckets/${id}`).then(r => r.json())
    if (!d.ok) { setError(d.error || 'Could not load that bucket.'); return }
    setDetail({
      name: d.bucket.name,
      code: d.bucket.code ?? '',
      description: d.bucket.description ?? '',
    })
    setMembers(d.clients)
    setDealCodes(d.dealCodes)
  }

  async function createBucket() {
    if (!newBucket.name.trim()) return
    setBusy(true); setError('')
    try {
      const d = await fetch('/api/tmc/buckets', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newBucket),
      }).then(r => r.json())
      if (!d.ok) { setError(d.error || 'Could not create bucket.'); return }
      setCreating(false)
      setNewBucket({ name: '', code: '', description: '' })
      await loadBuckets()
      await openBucket(d.bucket.id)
    } finally { setBusy(false) }
  }

  // Membership is sent whole rather than as a delta: the panel already holds
  // the complete list, and a whole-list write cannot half-apply if two admins
  // edit the same bucket at once.
  async function saveMembers(next: Client[]) {
    setBusy(true); setError('')
    try {
      const d = await fetch(`/api/tmc/buckets/${selectedId}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientIds: next.map(c => c.id) }),
      }).then(r => r.json())
      if (!d.ok) { setError(d.error || 'Could not update members.'); return }
      setMembers(next)
      await loadBuckets()
    } finally { setBusy(false) }
  }

  async function saveDetail() {
    setBusy(true); setError('')
    try {
      const d = await fetch(`/api/tmc/buckets/${selectedId}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(detail),
      }).then(r => r.json())
      if (!d.ok) { setError(d.error || 'Could not save.'); return }
      setSuccess('Bucket saved.')
      await loadBuckets()
    } finally { setBusy(false) }
  }

  async function removeBucket() {
    if (!confirm(`Delete "${detail.name}"?`)) return
    setBusy(true); setError('')
    try {
      const d = await fetch(`/api/tmc/buckets/${selectedId}`, { method: 'DELETE' }).then(r => r.json())
      if (!d.ok) { setError(d.error || 'Could not delete.'); return }
      setSelectedId('')
      await loadBuckets()
    } finally { setBusy(false) }
  }

  function addMember() {
    const client = clients.find(c => c.id === addClientId)
    if (!client || members.some(m => m.id === client.id)) return
    setAddClientId('')
    saveMembers([...members, client].sort((a, b) => a.name.localeCompare(b.name)))
  }

  const unassigned = clients.filter(c => !members.some(m => m.id === c.id))

  return (
    <div style={s.root}>
      <div style={s.header}>
        <div>
          <h1 style={s.title}>Buckets</h1>
          <p style={s.sub}>
            Curated sets of clients that masters can target. A bucket cuts across client groups —
            it is a distribution decision, not the org chart.
          </p>
        </div>
        <button onClick={() => { setCreating(true); setSelectedId('') }} style={s.primaryBtn}>New bucket</button>
      </div>

      {error && <div style={s.errorBanner}>{error}</div>}
      {success && <div style={s.successBanner}>{success}</div>}

      <div style={s.split}>
        <div style={s.list}>
          {loading ? (
            <p style={s.muted}>Loading…</p>
          ) : buckets.length === 0 ? (
            <div style={s.empty}>
              <p style={s.emptyTitle}>No buckets yet</p>
              <p style={s.emptyDesc}>Create one, then assign deal codes to it instead of client by client.</p>
            </div>
          ) : (
            buckets.map(b => (
              <button
                key={b.id}
                onClick={() => { setCreating(false); openBucket(b.id) }}
                style={{ ...s.card, ...(b.id === selectedId ? s.cardOn : {}) }}
              >
                <span style={s.cardName}>{b.name}</span>
                <span style={s.cardMeta}>
                  {b.clientCount} client{b.clientCount === 1 ? '' : 's'}
                  {b.dealCodeCount > 0 && ` · ${b.dealCodeCount} deal code${b.dealCodeCount === 1 ? '' : 's'}`}
                </span>
              </button>
            ))
          )}
        </div>

        <div style={s.detail}>
          {creating ? (
            <>
              <h2 style={s.panelTitle}>New bucket</h2>
              <div style={s.field}>
                <label style={s.label}>Name</label>
                <input value={newBucket.name} onChange={e => setNewBucket(b => ({ ...b, name: e.target.value }))}
                  placeholder="Tier 1 corporates" style={s.input} />
              </div>
              <div style={s.field}>
                <label style={s.label}>Code</label>
                <input value={newBucket.code} onChange={e => setNewBucket(b => ({ ...b, code: e.target.value.toUpperCase() }))}
                  placeholder="Optional short reference" style={{ ...s.input, fontFamily: 'var(--font-mono)' }} />
              </div>
              <div style={s.field}>
                <label style={s.label}>Description</label>
                <input value={newBucket.description} onChange={e => setNewBucket(b => ({ ...b, description: e.target.value }))}
                  placeholder="What this bucket is for" style={s.input} />
              </div>
              <div style={s.btnRow}>
                <button onClick={createBucket} disabled={busy || !newBucket.name.trim()}
                  style={{ ...s.primaryBtn, opacity: busy || !newBucket.name.trim() ? 0.5 : 1 }}>
                  Create
                </button>
                <button onClick={() => setCreating(false)} style={s.ghostBtn}>Cancel</button>
              </div>
            </>
          ) : !selectedId ? (
            <p style={s.muted}>Select a bucket to edit it, or create one.</p>
          ) : (
            <>
              <div style={s.detailHead}>
                <h2 style={s.panelTitle}>{detail.name}</h2>
                <span style={s.cardMeta}>
                  {members.length} client{members.length === 1 ? '' : 's'}
                </span>
              </div>

              <div style={s.row}>
                <div style={{ ...s.field, flex: 2 }}>
                  <label style={s.label}>Name</label>
                  <input value={detail.name} onChange={e => setDetail(d => ({ ...d, name: e.target.value }))} style={s.input} />
                </div>
                <div style={{ ...s.field, flex: 1 }}>
                  <label style={s.label}>Code</label>
                  <input value={detail.code} onChange={e => setDetail(d => ({ ...d, code: e.target.value.toUpperCase() }))}
                    style={{ ...s.input, fontFamily: 'var(--font-mono)' }} />
                </div>
              </div>
              <div style={s.field}>
                <label style={s.label}>Description</label>
                <input value={detail.description} onChange={e => setDetail(d => ({ ...d, description: e.target.value }))} style={s.input} />
              </div>
              <div style={s.btnRow}>
                <button onClick={saveDetail} disabled={busy} style={{ ...s.primaryBtn, opacity: busy ? 0.5 : 1 }}>Save</button>
                <button onClick={removeBucket} disabled={busy} style={s.dangerBtn}>Delete</button>
              </div>

              <div style={s.sectionLabel}>Clients in this bucket</div>
              {members.length === 0 ? (
                <p style={s.hint}>Empty — anything assigned to this bucket currently reaches nobody.</p>
              ) : (
                <div style={s.chipRow}>
                  {members.map(m => (
                    <span key={m.id} style={s.chip}>
                      {m.name}
                      <button
                        onClick={() => saveMembers(members.filter(x => x.id !== m.id))}
                        style={s.chipX} title={`Remove ${m.name}`}
                      >×</button>
                    </span>
                  ))}
                </div>
              )}

              <div style={{ ...s.row, marginTop: 12 }}>
                <div style={{ flex: 1 }}>
                  <SearchableSelect
                    value={addClientId}
                    onChange={setAddClientId}
                    options={unassigned.map(c => ({ id: c.id, label: c.name }))}
                    placeholder="Add a client…"
                    emptyMessage="Every client is already in this bucket"
                  />
                </div>
                <button onClick={addMember} disabled={!addClientId || busy}
                  style={{ ...s.primaryBtn, opacity: !addClientId || busy ? 0.5 : 1 }}>
                  Add
                </button>
              </div>

              <div style={s.sectionLabel}>Deal codes targeting this bucket</div>
              {dealCodes.length === 0 ? (
                <p style={s.hint}>None yet. Deal codes are pointed at a bucket from the deal itself.</p>
              ) : (
                <div style={s.chipRow}>
                  {dealCodes.map(d => (
                    <span key={d.id} style={s.readonlyChip}>
                      <span style={s.mono}>{d.code}</span>
                      <span style={{ color: '#6B7280' }}>{d.airline_code} · {d.code_type}</span>
                    </span>
                  ))}
                </div>
              )}
              <p style={s.hint}>
                Edited on the deal code, not here — one place decides reach, so the two cannot
                disagree.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  root: { paddingBottom: 60 },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap', marginBottom: 18 },
  title: { fontSize: 20, fontWeight: 600, color: 'var(--color-ink)', margin: '0 0 4px', letterSpacing: '-0.3px' },
  sub: { fontSize: 13, color: 'var(--color-secondary)', margin: 0, lineHeight: 1.6, maxWidth: 620 },

  split: { display: 'flex', gap: 20, alignItems: 'flex-start', flexWrap: 'wrap' },
  list: { width: 260, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 6 },
  card: { textAlign: 'left', background: '#fff', border: '1px solid var(--color-line)', borderLeft: '3px solid transparent', borderRadius: 8, padding: '10px 12px', cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 3 },
  cardOn: { borderLeftColor: 'var(--color-rail)', background: '#F5F6FF' },
  cardName: { fontSize: 13, fontWeight: 600, color: 'var(--color-ink)' },
  cardMeta: { fontSize: 11, color: 'var(--color-secondary)' },

  detail: { flex: 1, minWidth: 320, background: '#fff', border: '1px solid var(--color-line)', borderRadius: 10, padding: '18px 20px' },
  detailHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 14 },
  panelTitle: { fontSize: 16, fontWeight: 600, color: 'var(--color-ink)', margin: 0 },

  field: { display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 14 },
  row: { display: 'flex', gap: 10, alignItems: 'flex-end' },
  label: { fontSize: 11, fontWeight: 600, color: 'var(--color-secondary)', textTransform: 'uppercase', letterSpacing: '0.5px' },
  input: { height: 36, padding: '0 10px', fontSize: 13, color: '#111827', background: '#fff', border: '1px solid var(--color-line-strong)', borderRadius: 7, outline: 'none' },
  mono: { fontFamily: 'var(--font-mono)', fontWeight: 600, color: '#111827' },

  sectionLabel: { fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.11em', textTransform: 'uppercase', color: 'var(--color-secondary)', margin: '20px 0 10px', paddingBottom: 5, borderBottom: '1px solid var(--color-line)' },

  chipRow: { display: 'flex', gap: 6, flexWrap: 'wrap' },
  chip: { display: 'inline-flex', alignItems: 'center', gap: 7, background: '#fff', border: '1px solid var(--color-line-strong)', borderRadius: 6, padding: '4px 9px', fontSize: 12, color: 'var(--color-body)' },
  readonlyChip: { display: 'inline-flex', alignItems: 'center', gap: 7, background: '#F9FAFB', border: '1px solid var(--color-line)', borderRadius: 6, padding: '4px 9px', fontSize: 12 },
  chipX: { background: 'none', border: 'none', color: '#9CA3AF', fontSize: 15, lineHeight: 1, cursor: 'pointer', padding: 0 },

  btnRow: { display: 'flex', gap: 8 },
  muted: { fontSize: 13, color: 'var(--color-secondary)' },
  hint: { fontSize: 12, color: 'var(--color-secondary)', lineHeight: 1.55, margin: '4px 0 0' },

  empty: { background: '#fff', border: '1px dashed var(--color-line-strong)', borderRadius: 10, padding: '22px 18px', textAlign: 'center' },
  emptyTitle: { fontSize: 13, fontWeight: 600, color: 'var(--color-ink)', margin: '0 0 5px' },
  emptyDesc: { fontSize: 12, color: 'var(--color-secondary)', margin: 0, lineHeight: 1.6 },

  errorBanner: { background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8, padding: '10px 14px', fontSize: 12, color: '#DC2626', marginBottom: 14 },
  successBanner: { background: '#ECFDF5', border: '1px solid #A7F3D0', borderRadius: 8, padding: '10px 14px', fontSize: 12, color: '#065F46', marginBottom: 14 },

  primaryBtn: { height: 32, padding: '0 14px', background: 'var(--color-rail)', color: '#fff', fontSize: 12, fontWeight: 600, border: 'none', borderRadius: 6, cursor: 'pointer' },
  ghostBtn: { height: 32, padding: '0 12px', background: '#fff', color: '#374151', fontSize: 12, border: '1px solid var(--color-line-strong)', borderRadius: 6, cursor: 'pointer' },
  dangerBtn: { height: 32, padding: '0 12px', background: '#fff', color: '#DC2626', fontSize: 12, border: '1px solid #FECACA', borderRadius: 6, cursor: 'pointer' },
}
