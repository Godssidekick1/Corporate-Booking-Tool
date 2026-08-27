'use client'

import { useEffect, useState } from 'react'

// ── DirectChain ──────────────────────────────────────────────────────────────
// The whole direct-mapping flow: company, who it covers, the approvers in
// order, a mode toggle, save.
//
// Everything is local state until Save. The earlier version wrote each step as
// you picked it and re-fetched the world afterwards, which meant the form
// reloaded under you mid-edit and a half-built chain was a state that could
// actually exist in the database.
// ─────────────────────────────────────────────────────────────────────────────

interface Company { id: string; name: string }
interface Employee { id: string; full_name: string; band_code: string | null }

type ApproverType =
  'manager' | 'any_manager_at' | 'finance_role' | 'admin' | 'self' | 'specific_user'

interface Approver {
  approver_type: ApproverType | ''
  approver_user_id?: string | null
  min_band_rank?: number | null
  min_verdict: string
}

const CATEGORIES = [
  { value: 'flights_hotels', label: 'Flights & hotels' },
  { value: 'misc', label: 'Everything else' },
]

const APPROVER_TYPES: { value: ApproverType; label: string }[] = [
  { value: 'specific_user',  label: 'A specific person…' },
  { value: 'manager',        label: "The traveller's own manager" },
  { value: 'any_manager_at', label: 'Any manager at rank…' },
  { value: 'finance_role',   label: 'Finance' },
  { value: 'admin',          label: 'Company admin' },
  { value: 'self',           label: 'No review needed (auto-approve)' },
]

const VERDICTS = [
  { value: 'amber', label: 'when out of policy' },
  { value: 'red',   label: 'only on serious breaches' },
  { value: 'green', label: 'on every booking' },
]

function blankApprover(): Approver {
  return { approver_type: '', approver_user_id: null, min_band_rank: null, min_verdict: 'amber' }
}

export default function DirectChain({ companies }: { companies: Company[] }) {
  const [companyId, setCompanyId] = useState('')
  const [category, setCategory] = useState('flights_hotels')
  const [employeeId, setEmployeeId] = useState('') // '' means everyone

  const [employees, setEmployees] = useState<Employee[]>([])
  const [approvers, setApprovers] = useState<Approver[]>([blankApprover()])
  const [mode, setMode] = useState<'sequential' | 'parallel'>('sequential')
  const [quorum, setQuorum] = useState<'any' | 'all'>('all')

  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [existing, setExisting] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  async function loadChain() {
    setLoading(true); setError(''); setSuccess('')
    try {
      const qs = new URLSearchParams({ companyId, category })
      if (employeeId) qs.set('employeeId', employeeId)
      const d = await fetch(`/api/tmc/approval-chains/direct?${qs}`).then(r => r.json())
      if (!d.ok) { setError(d.error || 'Could not load the chain.'); return }

      if (d.chain) {
        setApprovers(d.chain.approvers.length ? d.chain.approvers : [blankApprover()])
        setMode(d.chain.mode)
        setQuorum(d.chain.quorum)
        setExisting(true)
      } else {
        setApprovers([blankApprover()])
        setMode('sequential')
        setQuorum('all')
        setExisting(false)
      }
      setDirty(false)
    } finally { setLoading(false) }
  }

  // Roster is per company, so it only reloads when the company changes — not
  // when the target employee does. Clearing on an empty company happens in the
  // picker's handler instead: setting state straight from an effect body is
  // what makes these cascade.
  useEffect(() => {
    if (!companyId) return
    let cancelled = false

    fetch(`/api/tmc/employees?companyId=${companyId}`).then(r => r.json())
      .then(d => { if (!cancelled && d.ok) setEmployees(d.employees) })

    return () => { cancelled = true }
  }, [companyId])

  useEffect(() => {
    if (!companyId) return
    loadChain()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, category, employeeId])

  function update(i: number, patch: Partial<Approver>) {
    setApprovers(prev => prev.map((a, idx) => (idx === i ? { ...a, ...patch } : a)))
    setDirty(true); setSuccess('')
  }

  function add() {
    setApprovers(prev => [...prev, blankApprover()])
    setDirty(true); setSuccess('')
  }

  function remove(i: number) {
    setApprovers(prev => prev.filter((_, idx) => idx !== i))
    setDirty(true); setSuccess('')
  }

  async function save() {
    setSaving(true); setError(''); setSuccess('')
    try {
      const d = await fetch('/api/tmc/approval-chains/direct', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          companyId,
          employeeId: employeeId || null,
          category,
          mode,
          quorum,
          approvers,
        }),
      }).then(r => r.json())

      if (!d.ok) { setError(d.error || 'Could not save the chain.'); return }
      setDirty(false); setExisting(true)
      setSuccess(
        employeeId
          ? `Saved for ${employees.find(e => e.id === employeeId)?.full_name ?? 'this employee'}.`
          : 'Saved for everyone at this client.'
      )
    } finally { setSaving(false) }
  }

  async function removeChain() {
    if (!confirm('Remove this approval chain? Bookings it covered will go through with no approval.')) return
    setSaving(true); setError('')
    try {
      const qs = new URLSearchParams({ companyId, category })
      if (employeeId) qs.set('employeeId', employeeId)
      const d = await fetch(`/api/tmc/approval-assignments?${qs}`, { method: 'DELETE' }).then(r => r.json())
      if (!d.ok) { setError(d.error || 'Could not remove the chain.'); return }
      await loadChain()
      setSuccess('Approval chain removed.')
    } finally { setSaving(false) }
  }

  const canSave = companyId && approvers.length > 0 && approvers.every(a =>
    a.approver_type &&
    (a.approver_type !== 'specific_user' || a.approver_user_id) &&
    (a.approver_type !== 'any_manager_at' || a.min_band_rank !== null)
  )

  return (
    <div style={s.card}>
      {/* ── Who it covers ─────────────────────────────────────────── */}
      <div style={s.row}>
        <div style={s.field}>
          <label style={s.label}>Client</label>
          <select
            value={companyId}
            onChange={e => {
              const next = e.target.value
              setCompanyId(next)
              // Switching clients invalidates both the roster and whoever was
              // picked from it.
              setEmployeeId('')
              if (!next) setEmployees([])
            }}
            style={{ ...s.input, width: 230 }}
          >
            <option value="">Select a client…</option>
            {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>

        <div style={s.field}>
          <label style={s.label}>Applies to</label>
          <select
            value={employeeId}
            onChange={e => setEmployeeId(e.target.value)}
            disabled={!companyId}
            style={{ ...s.input, width: 230 }}
          >
            <option value="">Everyone at this client</option>
            {employees.map(e => (
              <option key={e.id} value={e.id}>
                {e.full_name}{e.band_code ? ` · ${e.band_code}` : ''}
              </option>
            ))}
          </select>
        </div>

        <div style={s.field}>
          <label style={s.label}>For</label>
          <select value={category} onChange={e => setCategory(e.target.value)} style={{ ...s.input, width: 180 }}>
            {CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
        </div>
      </div>

      {error && <div style={s.errorBanner}>⚠ {error}</div>}
      {success && <div style={s.successBanner}>✓ {success}</div>}

      {!companyId ? (
        <p style={s.muted}>Pick a client to set up their approvals.</p>
      ) : loading ? (
        <div style={s.loadingWrap}><div style={s.spinner} /></div>
      ) : (
        <>
          {/* ── Approvers ──────────────────────────────────────────── */}
          <h3 style={s.sectionTitle}>Approvers</h3>

          <div style={s.approvers}>
            {approvers.map((a, i) => (
              <div key={i} style={s.approverRow}>
                <span style={s.num}>{mode === 'sequential' ? `${i + 1}` : '•'}</span>

                <select
                  value={a.approver_type}
                  onChange={e => update(i, {
                    approver_type: e.target.value as ApproverType,
                    approver_user_id: null,
                    min_band_rank: null,
                  })}
                  style={{ ...s.input, flex: 1, minWidth: 190 }}
                >
                  <option value="" disabled>Choose an approver…</option>
                  {APPROVER_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>

                {a.approver_type === 'specific_user' && (
                  <select
                    value={a.approver_user_id ?? ''}
                    onChange={e => update(i, { approver_user_id: e.target.value || null })}
                    style={{ ...s.input, flex: 1, minWidth: 170 }}
                  >
                    <option value="">Pick a person…</option>
                    {employees.map(e => (
                      <option key={e.id} value={e.id}>
                        {e.full_name}{e.band_code ? ` · ${e.band_code}` : ''}
                      </option>
                    ))}
                  </select>
                )}

                {a.approver_type === 'any_manager_at' && (
                  <input
                    type="number" min={0} placeholder="Min rank"
                    value={a.min_band_rank ?? ''}
                    onChange={e => update(i, { min_band_rank: e.target.value === '' ? null : Number(e.target.value) })}
                    style={{ ...s.input, width: 100 }}
                  />
                )}

                <select
                  value={a.min_verdict}
                  onChange={e => update(i, { min_verdict: e.target.value })}
                  style={{ ...s.input, width: 190 }}
                >
                  {VERDICTS.map(v => <option key={v.value} value={v.value}>{v.label}</option>)}
                </select>

                <button
                  onClick={() => remove(i)}
                  disabled={approvers.length === 1}
                  style={{ ...s.removeBtn, opacity: approvers.length === 1 ? 0.3 : 1 }}
                  title={approvers.length === 1 ? 'A chain needs at least one approver' : 'Remove'}
                >✕</button>
              </div>
            ))}
          </div>

          <button onClick={add} style={s.ghostBtn}>+ Add another approver</button>

          {/* ── Mode ───────────────────────────────────────────────── */}
          {approvers.length > 1 && (
            <div style={s.modeBox}>
              <div style={s.toggle}>
                <button
                  onClick={() => { setMode('sequential'); setDirty(true) }}
                  style={{ ...s.toggleBtn, ...(mode === 'sequential' ? s.toggleActive : {}) }}
                >
                  One after another
                </button>
                <button
                  onClick={() => { setMode('parallel'); setDirty(true) }}
                  style={{ ...s.toggleBtn, ...(mode === 'parallel' ? s.toggleActive : {}) }}
                >
                  All at once
                </button>
              </div>

              {mode === 'parallel' && (
                <select
                  value={quorum}
                  onChange={e => { setQuorum(e.target.value as 'any' | 'all'); setDirty(true) }}
                  style={{ ...s.input, width: 210 }}
                >
                  <option value="all">Everyone must approve</option>
                  <option value="any">Any one of them approves</option>
                </select>
              )}

              <span style={s.hint}>
                {mode === 'sequential'
                  ? 'Each approver is asked once the previous one says yes.'
                  : 'Everyone is asked at the same time. A rejection from anyone stops the booking.'}
              </span>
            </div>
          )}

          {/* ── Save ───────────────────────────────────────────────── */}
          <div style={s.saveRow}>
            <button
              onClick={save}
              disabled={!canSave || saving || !dirty}
              style={{ ...s.primaryBtn, opacity: !canSave || saving || !dirty ? 0.5 : 1 }}
            >
              {saving ? 'Saving…' : existing ? 'Save changes' : 'Save chain'}
            </button>
            {dirty && <span style={s.unsaved}>Unsaved changes</span>}
            {existing && !dirty && (
              <button onClick={removeChain} disabled={saving} style={s.removeChainBtn}>
                Remove chain
              </button>
            )}
          </div>

          {!employeeId && (
            <p style={s.footnote}>
              This covers everyone at the client who does not have their own chain. Pick a person
              above to give them a different one.
            </p>
          )}
        </>
      )}
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  card: { background: '#fff', border: '1px solid #E5E7EB', borderRadius: 12, padding: 20 },
  row: { display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 18 },
  field: { display: 'flex', flexDirection: 'column', gap: 6 },
  label: { fontSize: 11, fontWeight: 600, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.6px' },
  input: { height: 38, padding: '0 10px', fontSize: 13, color: '#111827', background: '#fff', border: '1px solid #D1D5DB', borderRadius: 7, outline: 'none' },

  errorBanner: { background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8, padding: '10px 14px', fontSize: 12, color: '#DC2626', marginBottom: 14 },
  successBanner: { background: '#ECFDF5', border: '1px solid #A7F3D0', borderRadius: 8, padding: '10px 14px', fontSize: 12, color: '#065F46', marginBottom: 14 },

  sectionTitle: { fontSize: 13, fontWeight: 600, color: '#111827', margin: '0 0 12px' },
  approvers: { display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 12 },
  approverRow: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' },
  num: { fontSize: 11, fontWeight: 700, color: '#3730A3', background: '#EEF2FF', borderRadius: 4, padding: '5px 9px', minWidth: 26, textAlign: 'center' },
  removeBtn: { background: 'transparent', border: 'none', color: '#9CA3AF', cursor: 'pointer', fontSize: 12, padding: '0 2px' },

  modeBox: { display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginTop: 16, padding: '12px 14px', background: '#F9FAFB', border: '1px solid #E5E7EB', borderRadius: 8 },
  toggle: { display: 'inline-flex', border: '1px solid #D1D5DB', borderRadius: 8, overflow: 'hidden', background: '#fff' },
  toggleBtn: { padding: '7px 14px', background: 'transparent', border: 'none', fontSize: 12, color: '#6B7280', cursor: 'pointer' },
  toggleActive: { background: '#000835', color: '#fff', fontWeight: 600 },
  hint: { fontSize: 11, color: '#9CA3AF' },

  saveRow: { display: 'flex', gap: 12, alignItems: 'center', marginTop: 20, flexWrap: 'wrap' },
  primaryBtn: { height: 38, padding: '0 20px', background: '#000835', color: '#fff', fontSize: 13, fontWeight: 600, border: 'none', borderRadius: 7, cursor: 'pointer' },
  ghostBtn: { height: 32, padding: '0 12px', background: '#fff', color: '#374151', fontSize: 12, fontWeight: 500, border: '1px solid #D1D5DB', borderRadius: 7, cursor: 'pointer' },
  removeChainBtn: { height: 32, padding: '0 12px', background: '#fff', color: '#DC2626', fontSize: 12, border: '1px solid #FECACA', borderRadius: 6, cursor: 'pointer', marginLeft: 'auto' },
  unsaved: { fontSize: 11, fontWeight: 500, color: '#92400E', background: '#FEF3C7', border: '1px solid #FDE68A', borderRadius: 4, padding: '3px 8px' },

  footnote: { fontSize: 11, color: '#9CA3AF', margin: '14px 0 0', lineHeight: 1.6 },
  muted: { fontSize: 12, color: '#9CA3AF', margin: 0 },
  loadingWrap: { display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '40px' },
  spinner: { width: 22, height: 22, border: '2.5px solid #E5E7EB', borderTopColor: '#000835', borderRadius: '50%', animation: 'spin 0.7s linear infinite' },
}
