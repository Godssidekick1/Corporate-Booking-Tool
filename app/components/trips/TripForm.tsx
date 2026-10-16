'use client'

import { useEffect, useState } from 'react'
import SlideOver from '@/app/components/SlideOver'
import SearchableSelect from '@/app/components/SearchableSelect'
import { useLookup } from '@/app/hooks/useLookup'

// ── TripForm: New trip ───────────────────────────────────────────────────────
// What a trip is for, asked once when it is made: name, domestic or
// international, billable, cost centre, currency and budget, and a project
// (free text, optional). Opened from the trips page, by a company admin for a
// colleague, and by the travel desk for a traveller (`traveller` preset).
//
// Whose trip it is decides which cost centres are offered (the traveller's
// company's: GET /api/trips/options) -- and the trip is always THEIRS, in
// their trips; whoever set it up is recorded (trips.arranged_by).
// ─────────────────────────────────────────────────────────────────────────────

interface Options {
  costCentres: { id: string; code: string; name: string }[]
  currencies: string[]
  tripApprovalRequired: boolean
}

export default function TripForm({ open, onClose, onCreated, traveller, allowColleague = false }: {
  open: boolean
  onClose: () => void
  onCreated: (tripId: string) => void
  // Fixed traveller: the desk booking for someone, a colleague's trip page.
  traveller?: { id: string; name: string }
  // A company admin may make the trip a colleague's instead of their own.
  allowColleague?: boolean
}) {
  const [forWhom, setForWhom] = useState<'me' | 'colleague'>('me')
  const [colleagueId, setColleagueId] = useState('')
  const colleagues = useLookup('/api/book/travellers', colleagueId, {
    enabled: open && allowColleague && !traveller && forWhom === 'colleague',
    toOption: row => ({
      id: String(row.id),
      label: String(row.full_name),
      sublabel: [row.band_code, row.department, row.email].filter(Boolean).join(' · ') || undefined,
    }),
  })

  const travellerId = traveller?.id ?? (forWhom === 'colleague' ? colleagueId : '')
  const travellerName = traveller?.name ?? (forWhom === 'colleague' ? colleagues.selectedLabel : '')
  const waitingForColleague = !traveller && forWhom === 'colleague' && !colleagueId

  const [name, setName] = useState('')
  const [travelType, setTravelType] = useState<'domestic' | 'international' | ''>('')
  const [billable, setBillable] = useState(false)
  const [costCentreId, setCostCentreId] = useState('')
  const [currency, setCurrency] = useState('INR')
  const [budget, setBudget] = useState('')
  const [project, setProject] = useState('')
  const [options, setOptions] = useState<Options | null>(null)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  // The traveller's company's options; a different traveller, a different list.
  useEffect(() => {
    if (!open || waitingForColleague) return
    let live = true
    fetch(`/api/trips/options${travellerId ? `?travellerId=${encodeURIComponent(travellerId)}` : ''}`)
      .then(r => r.json())
      .then(d => { if (live) { setOptions(d.ok ? d : null); setCostCentreId('') } })
      .catch(() => { if (live) setOptions(null) })
    return () => { live = false }
  }, [open, travellerId, waitingForColleague])

  function reset() {
    setName(''); setTravelType(''); setBillable(false); setCostCentreId(''); setCurrency('INR')
    setBudget(''); setProject(''); setError(''); setForWhom('me'); setColleagueId('')
  }

  async function create() {
    setError('')
    if (waitingForColleague) { setError('Choose whose trip this is.'); return }
    if (!name.trim()) { setError('Give the trip a name.'); return }
    if (!travelType) { setError('Choose domestic or international.'); return }
    setSaving(true)
    try {
      const res = await fetch('/api/trips', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(), travellerId: travellerId || undefined, travelType, billable,
          costCentreId: costCentreId || null, currency, budgetAmount: budget === '' ? null : budget,
          project: project.trim() || null,
        }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error || 'Could not create the trip.'); return }
      reset()
      onCreated(data.trip.id)
    } catch {
      setError('Something went wrong creating the trip.')
    } finally {
      setSaving(false)
    }
  }

  const first = travellerName.split(' ')[0]

  return (
    <SlideOver
      open={open}
      onClose={() => { reset(); onClose() }}
      title="New trip"
      subtitle={traveller ? `For ${traveller.name}. It will be their trip, set up by you.` : 'Group a journey’s flights, with what it is for and its budget.'}
      footer={
        <div style={s.foot}>
          {error && <span style={s.error}>⚠ {error}</span>}
          <button type="button" onClick={() => { reset(); onClose() }} style={s.cancel}>Cancel</button>
          <button type="button" onClick={create} disabled={saving} style={{ ...s.create, opacity: saving ? 0.7 : 1 }}>
            {saving ? 'Creating…' : travellerId ? `Create ${first ? `${first}’s` : 'their'} trip` : 'Create trip'}
          </button>
        </div>
      }
    >
      <div style={s.body}>
        {allowColleague && !traveller && (
          <section style={s.section}>
            <p style={s.sectionTitle}>Whose trip?</p>
            <div style={s.segment} role="radiogroup" aria-label="Whose trip">
              {(['me', 'colleague'] as const).map(w => (
                <button key={w} type="button" role="radio" aria-checked={forWhom === w}
                  onClick={() => { setForWhom(w); setError('') }}
                  style={{ ...s.segBtn, ...(forWhom === w ? s.segOn : {}) }}>
                  {w === 'me' ? 'Mine' : 'A colleague’s'}
                </button>
              ))}
            </div>
            {forWhom === 'colleague' && (
              <div style={{ marginTop: 10 }}>
                <SearchableSelect
                  value={colleagueId}
                  onChange={setColleagueId}
                  options={colleagues.options}
                  onSearch={colleagues.onSearch}
                  loading={colleagues.loading}
                  selectedLabel={colleagues.selectedLabel}
                  placeholder="Search colleagues by name, email or department…"
                  emptyMessage="No colleague matches"
                />
                {colleagueId && (
                  <p style={s.note}>
                    It will be <strong>{travellerName || 'their'}</strong>’s trip: in their trips, and in yours under
                    Arranged for others.
                  </p>
                )}
              </div>
            )}
          </section>
        )}

        <section style={s.section}>
          <p style={s.sectionTitle}>Trip</p>
          <div style={s.grid}>
            <label style={{ ...s.field, gridColumn: '1 / -1' }}>
              <span style={s.label}>Trip name <span style={s.req}>*</span></span>
              <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Mumbai client visit"
                style={s.input} autoFocus />
            </label>
            <div style={s.field}>
              <span style={s.label}>Travel type <span style={s.req}>*</span></span>
              <div style={s.segment} role="radiogroup" aria-label="Travel type">
                {(['domestic', 'international'] as const).map(t => (
                  <button key={t} type="button" role="radio" aria-checked={travelType === t} onClick={() => setTravelType(t)}
                    style={{ ...s.segBtn, ...(travelType === t ? s.segOn : {}) }}>
                    {t === 'domestic' ? 'Domestic' : 'International'}
                  </button>
                ))}
              </div>
            </div>
            <label style={{ ...s.field, ...s.checkField }}>
              <input type="checkbox" checked={billable} onChange={e => setBillable(e.target.checked)} style={s.checkbox} />
              <span>
                <span style={s.checkLabel}>Billable</span>
                <span style={s.hint}>Charged on to a client or project.</span>
              </span>
            </label>
          </div>
        </section>

        <section style={s.section}>
          <p style={s.sectionTitle}>Cost and budget</p>
          <div style={s.grid}>
            <label style={s.field}>
              <span style={s.label}>Cost centre</span>
              <select value={costCentreId} onChange={e => setCostCentreId(e.target.value)} style={s.input}
                disabled={!options || options.costCentres.length === 0}>
                <option value="">{!options ? 'Loading…' : options.costCentres.length === 0 ? 'None set up for this company' : 'None'}</option>
                {options?.costCentres.map(c => <option key={c.id} value={c.id}>{c.code} · {c.name}</option>)}
              </select>
            </label>
            <label style={s.field}>
              <span style={s.label}>Currency</span>
              <select value={currency} onChange={e => setCurrency(e.target.value)} style={s.input}>
                {(options?.currencies ?? ['INR']).map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
            <label style={s.field}>
              <span style={s.label}>Budget amount</span>
              <input type="number" min={0} step="any" inputMode="decimal" value={budget}
                onChange={e => setBudget(e.target.value)} placeholder="Optional" style={s.input} />
            </label>
            <label style={s.field}>
              <span style={s.label}>Project</span>
              <input value={project} onChange={e => setProject(e.target.value)} placeholder="Optional" maxLength={120} style={s.input} />
            </label>
          </div>
        </section>

        {options?.tripApprovalRequired && (
          <p style={s.signOff}>
            This company signs trips off: when everything in the trip is booked, submit it for sign-off.
          </p>
        )}
      </div>
    </SlideOver>
  )
}

const s: Record<string, React.CSSProperties> = {
  body: { display: 'flex', flexDirection: 'column', gap: 20 },
  section: { display: 'flex', flexDirection: 'column', gap: 10 },
  sectionTitle: { fontSize: 11, fontWeight: 700, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.5px', margin: 0 },
  // Two columns where there is room, one on a phone.
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '14px 16px' },
  field: { display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 },
  label: { fontSize: 12.5, fontWeight: 600, color: '#374151' },
  req: { color: '#B91C1C' },
  hint: { display: 'block', fontSize: 11.5, color: '#9CA3AF', marginTop: 2 },
  input: {
    height: 38, padding: '0 11px', fontSize: 13.5, color: '#111827', background: '#fff',
    border: '1px solid #D1D5DB', borderRadius: 8, outline: 'none', width: '100%', boxSizing: 'border-box',
  },
  segment: { display: 'inline-flex', border: '1px solid #D1D5DB', borderRadius: 8, overflow: 'hidden', alignSelf: 'flex-start' },
  segBtn: { height: 36, padding: '0 14px', fontSize: 13, background: '#fff', color: '#374151', border: 'none', cursor: 'pointer' },
  segOn: { background: '#000835', color: '#fff', fontWeight: 600 },
  checkField: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingTop: 22, cursor: 'pointer' },
  checkbox: { width: 16, height: 16, marginTop: 2, accentColor: '#000835' },
  checkLabel: { fontSize: 13, fontWeight: 600, color: '#374151' },
  note: { fontSize: 12, color: '#4338CA', lineHeight: 1.5, margin: '8px 0 0' },
  signOff: {
    fontSize: 12.5, color: '#92400E', background: '#FFFBEB', border: '1px solid #FDE68A',
    borderRadius: 10, padding: '10px 12px', margin: 0, lineHeight: 1.5,
  },
  foot: { display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'flex-end', flexWrap: 'wrap', width: '100%' },
  error: { fontSize: 12, color: '#B91C1C', marginRight: 'auto' },
  cancel: { height: 36, padding: '0 14px', fontSize: 13, background: '#fff', color: '#374151', border: '1px solid #D1D5DB', borderRadius: 8, cursor: 'pointer' },
  create: { height: 36, padding: '0 16px', fontSize: 13, fontWeight: 600, background: '#000835', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer' },
}
