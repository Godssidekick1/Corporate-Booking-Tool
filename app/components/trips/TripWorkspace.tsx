'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useCanSelfBook } from '@/app/hooks/useCanSelfBook'
import { flowStorage } from '@/app/lib/book/flowStorage'
import { tripStatus, signOffStatus, money } from '@/app/lib/trips/status'
import { FlightRow, type TripCardFlight, type TripCardTrip } from './TripCard'

// ── TripWorkspace: one trip's page ───────────────────────────────────────────
// The trip itself -- what it is for (details, editable until it is sent for
// sign-off), its sign-off (status, every step and who decided it, and the
// submit button), and its flights. Rendered by the company's page
// (/trips/[id]) and the travel desk's (/tmc/trips/[id]); `home` is where a
// booking made from here returns to (the flow's exits).
//
// A trip kept for someone else -- a colleague's, or a traveller's at the desk
// -- says so at the top, and "+ Add flight" books FOR them: the search opens
// with them chosen and this trip selected, as if picked there.
// ─────────────────────────────────────────────────────────────────────────────

interface Trip extends TripCardTrip {
  cost_centre_id: string | null
  created_by: string
  client_id: string
}

interface Step {
  id: string
  tier: number
  status: string
  approver_name: string | null
  decision_note: string | null
  actioned_at: string | null
  created_at: string
}

interface Workspace {
  trip: Trip
  mine: boolean
  traveller: { id: string; name: string | null }
  arrangedByName: string | null
  bookings: (TripCardFlight & { booking_type: string })[]
  signOff: Step[]
}

interface Options { costCentres: { id: string; code: string; name: string }[]; currencies: string[] }

export default function TripWorkspace({ tripId, home, backHref, backLabel }: {
  tripId: string
  home: '/bookings' | '/tmc/book'
  backHref: string
  backLabel: string
}) {
  const router = useRouter()
  const canSelfBook = useCanSelfBook()
  const [ws, setWs] = useState<Workspace | null>(null)
  const [error, setError] = useState('')
  const [reloadKey, setReloadKey] = useState(0)
  const [busy, setBusy] = useState<'' | 'submit' | 'complete' | 'add' | 'save'>('')
  const [actionError, setActionError] = useState('')
  const [editing, setEditing] = useState(false)

  useEffect(() => {
    let live = true
    fetch(`/api/trips/${tripId}`)
      .then(async r => {
        const d = await r.json()
        if (!live) return
        if (!r.ok) { setError(d.error || 'Could not load this trip.'); return }
        setError('')
        setWs(d)
      })
      .catch(() => { if (live) setError('Something went wrong loading this trip.') })
    return () => { live = false }
  }, [tripId, reloadKey])
  const reload = useCallback(() => setReloadKey(k => k + 1), [])

  async function post(what: 'submit' | 'complete') {
    setBusy(what); setActionError('')
    try {
      const res = what === 'submit'
        ? await fetch(`/api/trips/${tripId}/submit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        : await fetch(`/api/trips/${tripId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'completed' }) })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setActionError(d.error || 'That did not work. Please try again.'); return }
      reload()
    } catch {
      setActionError('Something went wrong. Please try again.')
    } finally {
      setBusy('')
    }
  }

  // A flight for someone else's trip is booked FOR them (flowStorage), and
  // returns to `home` -- the desk, or the admin's trips.
  async function addFlight() {
    if (!ws) return
    if (ws.mine) { router.push(`/book/flights?tripId=${tripId}`); return }
    setBusy('add'); setActionError('')
    try {
      const [me, d] = await Promise.all([
        fetch('/api/me').then(r => r.json()),
        fetch(`/api/book/travellers/${ws.traveller.id}`).then(r => r.json()),
      ])
      if (!d?.ok || !me?.employee?.id) { setActionError(d?.error || 'Could not start a booking for them.'); setBusy(''); return }
      flowStorage.claim(me.employee.id)
      flowStorage.clearFlow()
      flowStorage.setOnBehalf({
        bookerId: me.employee.id, travellerId: d.traveller.id, name: d.traveller.full_name,
        clientName: d.traveller.client_name, bandCode: d.traveller.band_code, policy: d.policy, home,
      })
      flowStorage.setTripId(tripId, d.traveller.id)
      router.push('/book/flights')
    } catch {
      setActionError('Could not start a booking for them.')
      setBusy('')
    }
  }

  if (error) {
    return (
      <div style={s.errorCard}>
        <p style={s.errorTitle}>⚠ {error}</p>
        <Link href={backHref} style={s.errorLink}>← {backLabel}</Link>
      </div>
    )
  }
  if (!ws) return <div style={s.loading}><div style={s.spinner} /></div>

  const { trip, mine, traveller, arrangedByName } = ws
  const status = tripStatus(trip.status)
  const signOff = signOffStatus(trip.approval_status ?? 'none')
  const live = trip.status === 'open' || trip.status === 'active'
  const flights = ws.bookings.filter(b => b.booking_type === 'flight')
  const locked = trip.approval_status === 'pending' || trip.approval_status === 'approved'
  const canSubmit = Boolean(trip.sign_off_required) && live && (trip.flight_count ?? 0) > 0 && !locked
  const canComplete = live && (!trip.sign_off_required || trip.approval_status === 'approved')
  const canAdd = live && (!mine || canSelfBook) && trip.approval_status !== 'approved'
  const first = (traveller.name ?? '').split(' ')[0] || 'them'

  return (
    <div style={s.stack}>
      <Link href={backHref} style={s.back}>← {backLabel}</Link>

      {!mine && (
        <div style={s.forBanner} role="status">
          <span><strong>{traveller.name ?? 'A traveller'}</strong>&apos;s trip</span>
          <span style={s.forNote}>
            {arrangedByName ? `Set up by ${arrangedByName}.` : 'Their own trip.'} Flights added here are booked for them,
            under their policy and approvals, and appear in their trips.
          </span>
        </div>
      )}

      <header style={s.head}>
        <div style={s.titleBlock}>
          <div style={s.titleRow}>
            <h1 style={s.title}>{trip.name || 'Untitled trip'}</h1>
            <span style={{ ...s.pill, color: status.color, background: status.bg }}>{status.label}</span>
            {signOff && <span style={{ ...s.pill, color: signOff.color, background: signOff.bg }}>{signOff.label}</span>}
          </div>
          {mine && arrangedByName && <p style={s.sub}>Set up for you by {arrangedByName}.</p>}
        </div>
        <div style={s.headActions}>
          {canComplete && (
            <button type="button" onClick={() => post('complete')} disabled={busy === 'complete'} style={s.ghostBtn}>
              {busy === 'complete' ? 'Marking complete…' : '✓ Mark trip complete'}
            </button>
          )}
        </div>
      </header>
      {actionError && <p style={s.actionError}>⚠ {actionError}</p>}

      {editing
        ? <DetailsEditor trip={trip} travellerId={mine ? null : traveller.id} onDone={changed => { setEditing(false); if (changed) reload() }} />
        : <Details trip={trip} onEdit={!locked && live ? () => setEditing(true) : undefined} />}

      {(trip.sign_off_required || trip.approval_status !== 'none') && (
        <section style={s.card}>
          <div style={s.cardHead}>
            <h2 style={s.cardTitle}>Sign-off</h2>
            {canSubmit && (
              <button type="button" onClick={() => post('submit')} disabled={busy === 'submit'} style={s.primaryBtn}>
                {busy === 'submit' ? 'Submitting…' : trip.approval_status === 'rejected' ? 'Resubmit for sign-off' : 'Submit for sign-off'}
              </button>
            )}
          </div>
          <p style={s.cardSub}>
            {trip.approval_status === 'pending' ? 'Waiting for the approver. The trip’s details are locked until they decide.'
              : trip.approval_status === 'approved' ? 'Signed off. The trip is complete once you mark it so.'
              : trip.approval_status === 'rejected' ? 'Not signed off. Make any changes, then submit it again.'
              : trip.approval_status === 'misconfigured' ? 'A sign-off step has nobody to ask. Ask your TMC to set the trip sign-off approvers.'
              : 'This company signs trips off. When every flight in it is booked, submit the trip — each flight was already approved, if it needed to be, when it was booked.'}
          </p>
          {ws.signOff.length > 0 && (
            <ol style={s.steps}>
              {ws.signOff.map(st => {
                const meta = signOffStatus(st.status === 'superseded' ? 'approved' : st.status === 'pending' ? 'pending' : st.status)
                return (
                  <li key={st.id} style={s.step}>
                    <span style={s.stepWho}>Step {st.tier} · {st.approver_name ?? 'Approver'}</span>
                    <span style={{ ...s.pill, color: meta?.color, background: meta?.bg }}>
                      {st.status === 'pending' ? 'Waiting' : st.status === 'approved' ? 'Approved' : st.status === 'rejected' ? 'Rejected' : st.status === 'escalated' ? 'Passed to their manager' : 'Not needed'}
                    </span>
                    <span style={s.stepWhen}>{shortDate(st.actioned_at ?? st.created_at)}</span>
                    {st.decision_note && <span style={s.stepNote}>“{st.decision_note}”</span>}
                  </li>
                )
              })}
            </ol>
          )}
        </section>
      )}

      <section style={s.card}>
        <div style={s.cardHead}>
          <h2 style={s.cardTitle}>✈ Flights</h2>
          {canAdd && (
            <button type="button" onClick={addFlight} disabled={busy === 'add'} style={s.primaryBtn}>
              {busy === 'add' ? 'Opening…' : mine ? '+ Add flight' : `+ Add flight for ${first}`}
            </button>
          )}
        </div>
        {flights.length === 0
          ? <p style={s.empty}>No flights in this trip yet.</p>
          : <ul style={s.flights}>{flights.map(f => <FlightRow key={f.id} flight={f} />)}</ul>}
      </section>

      <section style={s.cardMuted}>
        <span style={s.mutedTitle}>🏨 Hotels · 🧾 Expenses</span>
        <span style={s.soon}>Coming soon</span>
      </section>
    </div>
  )
}

// What the trip is for, read-only, with Edit while it can still change.
function Details({ trip, onEdit }: { trip: Trip; onEdit?: () => void }) {
  const currency = trip.currency ?? 'INR'
  const total = trip.total_cost ?? 0
  const budget = trip.budget_amount
  const pct = budget ? Math.min(100, Math.round((total / budget) * 100)) : 0
  const rows: [string, React.ReactNode][] = [
    ['Travel type', trip.travel_type ? (trip.travel_type === 'domestic' ? 'Domestic' : 'International') : <span style={s.unset}>Not set</span>],
    ['Billable', trip.billable ? 'Yes' : 'No'],
    ['Cost centre', trip.cost_centre_code ? `${trip.cost_centre_code} · ${trip.cost_centre_name ?? ''}` : <span style={s.unset}>None</span>],
    ['Project', trip.project || <span style={s.unset}>None</span>],
    ['Spent', `${money(total, currency)} · ${trip.flight_count ?? 0} flight${trip.flight_count === 1 ? '' : 's'}`],
    ['Created', shortDate(trip.created_at)],
  ]
  return (
    <section style={s.card}>
      <div style={s.cardHead}>
        <h2 style={s.cardTitle}>Details</h2>
        {onEdit && <button type="button" onClick={onEdit} style={s.linkBtn}>Edit</button>}
      </div>
      <dl style={s.facts}>
        {rows.map(([k, v]) => (
          <div key={k} style={s.fact}><dt style={s.factKey}>{k}</dt><dd style={s.factVal}>{v}</dd></div>
        ))}
      </dl>
      {budget != null && (
        <div style={s.budget}>
          <div style={s.budgetLine}>
            <span>Budget {money(budget, currency)}</span>
            <span style={total > budget ? s.over : undefined}>{total > budget ? `${money(total - budget, currency)} over` : `${money(budget - total, currency)} left`}</span>
          </div>
          <div style={s.bar}><div style={{ ...s.barFill, width: `${pct}%`, background: total > budget ? '#DC2626' : '#000835' }} /></div>
        </div>
      )}
    </section>
  )
}

// Editing the details in place: the same fields as New trip.
function DetailsEditor({ trip, travellerId, onDone }: { trip: Trip; travellerId: string | null; onDone: (changed: boolean) => void }) {
  const [name, setName] = useState(trip.name ?? '')
  const [travelType, setTravelType] = useState(trip.travel_type ?? '')
  const [billable, setBillable] = useState(Boolean(trip.billable))
  const [costCentreId, setCostCentreId] = useState(trip.cost_centre_id ?? '')
  const [currency, setCurrency] = useState(trip.currency ?? 'INR')
  const [budget, setBudget] = useState(trip.budget_amount != null ? String(trip.budget_amount) : '')
  const [project, setProject] = useState(trip.project ?? '')
  const [options, setOptions] = useState<Options | null>(null)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let live = true
    fetch(`/api/trips/options${travellerId ? `?travellerId=${encodeURIComponent(travellerId)}` : ''}`)
      .then(r => r.json())
      .then(d => { if (live && d.ok) setOptions(d) })
      .catch(() => {})
    return () => { live = false }
  }, [travellerId])

  async function save() {
    setError('')
    if (!name.trim()) { setError('Give the trip a name.'); return }
    setSaving(true)
    try {
      const res = await fetch(`/api/trips/${trip.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(), travelType: travelType || null, billable, costCentreId: costCentreId || null,
          currency, budgetAmount: budget === '' ? null : budget, project: project.trim() || null,
        }),
      })
      const d = await res.json()
      if (!res.ok) { setError(d.error || 'Could not save.'); return }
      onDone(true)
    } catch {
      setError('Something went wrong saving.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <section style={s.card}>
      <div style={s.cardHead}><h2 style={s.cardTitle}>Details</h2></div>
      <div style={s.grid}>
        <label style={{ ...s.field, gridColumn: '1 / -1' }}>
          <span style={s.label}>Trip name</span>
          <input value={name} onChange={e => setName(e.target.value)} style={s.input} />
        </label>
        <label style={s.field}>
          <span style={s.label}>Travel type</span>
          <select value={travelType} onChange={e => setTravelType(e.target.value as typeof travelType)} style={s.input}>
            <option value="">Not set</option>
            <option value="domestic">Domestic</option>
            <option value="international">International</option>
          </select>
        </label>
        <label style={{ ...s.field, flexDirection: 'row', alignItems: 'center', gap: 8, paddingTop: 22 }}>
          <input type="checkbox" checked={billable} onChange={e => setBillable(e.target.checked)} style={{ accentColor: '#000835' }} />
          <span style={s.label}>Billable</span>
        </label>
        <label style={s.field}>
          <span style={s.label}>Cost centre</span>
          <select value={costCentreId} onChange={e => setCostCentreId(e.target.value)} style={s.input} disabled={!options}>
            <option value="">None</option>
            {options?.costCentres.map(c => <option key={c.id} value={c.id}>{c.code} · {c.name}</option>)}
          </select>
        </label>
        <label style={s.field}>
          <span style={s.label}>Currency</span>
          <select value={currency} onChange={e => setCurrency(e.target.value)} style={s.input}>
            {(options?.currencies ?? [currency]).map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        <label style={s.field}>
          <span style={s.label}>Budget amount</span>
          <input type="number" min={0} step="any" value={budget} onChange={e => setBudget(e.target.value)} placeholder="Optional" style={s.input} />
        </label>
        <label style={s.field}>
          <span style={s.label}>Project</span>
          <input value={project} onChange={e => setProject(e.target.value)} maxLength={120} placeholder="Optional" style={s.input} />
        </label>
      </div>
      <div style={s.editFoot}>
        {error && <span style={s.actionError}>⚠ {error}</span>}
        <button type="button" onClick={() => onDone(false)} style={s.cancelBtn}>Cancel</button>
        <button type="button" onClick={save} disabled={saving} style={s.primaryBtn}>{saving ? 'Saving…' : 'Save'}</button>
      </div>
    </section>
  )
}

function shortDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
  } catch { return '' }
}

const s: Record<string, React.CSSProperties> = {
  stack: { display: 'flex', flexDirection: 'column', gap: 14 },
  back: { fontSize: 13, color: '#6B7280', textDecoration: 'none', alignSelf: 'flex-start' },
  forBanner: {
    display: 'flex', flexDirection: 'column', gap: 3, padding: '11px 14px', background: '#EEF2FF',
    border: '1px solid #C7D2FE', borderRadius: 10, fontSize: 14, color: '#1E1B4B',
  },
  forNote: { fontSize: 12, color: '#4338CA', lineHeight: 1.5 },
  head: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' },
  titleBlock: { display: 'flex', flexDirection: 'column', gap: 4 },
  titleRow: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  title: { fontSize: 22, fontWeight: 700, color: '#0A0A14', margin: 0, letterSpacing: '-0.4px' },
  sub: { fontSize: 12.5, color: '#6B7280', margin: 0 },
  headActions: { display: 'flex', gap: 8 },
  pill: { fontSize: 11, fontWeight: 700, padding: '3px 9px', borderRadius: 7, whiteSpace: 'nowrap' },
  actionError: { fontSize: 12.5, color: '#B91C1C', margin: 0 },
  card: { background: '#fff', border: '1px solid #E5E7EB', borderRadius: 14, padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 10 },
  cardMuted: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 18px', background: '#fff', border: '1px dashed #E5E7EB', borderRadius: 14 },
  mutedTitle: { fontSize: 13, color: '#6B7280' },
  soon: { fontSize: 11, fontWeight: 600, color: '#6B7280', background: '#F3F4F6', borderRadius: 10, padding: '2px 8px' },
  cardHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  cardTitle: { fontSize: 15, fontWeight: 700, color: '#111827', margin: 0 },
  cardSub: { fontSize: 12.5, color: '#6B7280', margin: 0, lineHeight: 1.6 },
  facts: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '10px 16px', margin: 0 },
  fact: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 },
  factKey: { fontSize: 11, fontWeight: 600, color: '#9CA3AF', textTransform: 'uppercase', letterSpacing: '0.4px' },
  factVal: { fontSize: 13.5, color: '#111827', margin: 0 },
  unset: { color: '#9CA3AF' },
  budget: { display: 'flex', flexDirection: 'column', gap: 6, paddingTop: 4 },
  budgetLine: { display: 'flex', justifyContent: 'space-between', fontSize: 12.5, color: '#374151' },
  over: { color: '#B91C1C', fontWeight: 600 },
  bar: { height: 6, background: '#F3F4F6', borderRadius: 3, overflow: 'hidden' },
  barFill: { height: '100%', borderRadius: 3 },
  steps: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 },
  step: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 12.5, padding: '8px 10px', background: '#F9FAFB', borderRadius: 8 },
  stepWho: { fontWeight: 600, color: '#374151' },
  stepWhen: { color: '#9CA3AF' },
  stepNote: { color: '#4B5563', fontStyle: 'italic', flexBasis: '100%' },
  flights: { listStyle: 'none', margin: 0, padding: 0, borderTop: '1px solid #F3F4F6' },
  empty: { fontSize: 12.5, color: '#9CA3AF', margin: 0 },
  primaryBtn: { height: 32, padding: '0 14px', background: '#000835', color: '#fff', fontSize: 12.5, fontWeight: 600, border: 'none', borderRadius: 8, cursor: 'pointer' },
  ghostBtn: { height: 32, padding: '0 12px', background: '#fff', color: '#166534', fontSize: 12.5, fontWeight: 600, border: '1px solid #BBF7D0', borderRadius: 8, cursor: 'pointer' },
  cancelBtn: { height: 32, padding: '0 12px', background: '#fff', color: '#374151', fontSize: 12.5, border: '1px solid #D1D5DB', borderRadius: 8, cursor: 'pointer' },
  linkBtn: { background: 'none', border: 'none', color: '#000835', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', padding: 0 },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '12px 16px' },
  field: { display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 },
  label: { fontSize: 12.5, fontWeight: 600, color: '#374151' },
  input: { height: 36, padding: '0 10px', fontSize: 13, color: '#111827', background: '#fff', border: '1px solid #D1D5DB', borderRadius: 8, width: '100%', boxSizing: 'border-box' },
  editFoot: { display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' },
  errorCard: { padding: 20, background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 12 },
  errorTitle: { fontSize: 14, color: '#DC2626', margin: '0 0 8px' },
  errorLink: { fontSize: 13, color: '#000835' },
  loading: { display: 'flex', justifyContent: 'center', padding: '60px 0' },
  spinner: { width: 22, height: 22, border: '2.5px solid #E5E7EB', borderTopColor: '#000835', borderRadius: '50%', animation: 'spin 0.7s linear infinite' },
}
