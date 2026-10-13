'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import SearchableSelect from '@/app/components/SearchableSelect'
import BookingHistory from '@/app/components/BookingHistory'
import TripPicker, { resolveTrip, type TripChoice } from '@/app/components/TripPicker'
import { useLookup, clientOption } from '@/app/hooks/useLookup'
import { flowStorage } from '@/app/lib/book/flowStorage'
import { canAccess } from '@/app/lib/permissions/canAccess'

// ── /tmc/book ────────────────────────────────────────────────────────────────
// The travel desk books for travellers. Pick who is travelling (a client to
// narrow by, then the person), check what applies to them, then the ordinary
// booking flow runs for that person: every step carries their id, and the
// flow shows whom it is for on every screen (BookingFlowChrome).
//
// Who the desk may book for, and what governs it, is decided on the server
// (app/lib/book/bookingActor.ts): a TMC admin reaches every client of the TMC,
// a counsellor with "Book for travellers" their own portfolio. At a CBT-only
// client policy is guidance and an amber or red fare needs a reason; at any
// other client the traveller's own approval chain decides.
// ─────────────────────────────────────────────────────────────────────────────

interface TravellerDetail {
  traveller: {
    id: string; full_name: string; email: string | null; band_code: string | null
    department: string | null; designation: string | null; client_id: string; client_name: string
    booking_mode: string; profile_ready: boolean; has_passport: boolean
  }
  policy: 'guidance' | 'approvals'
  recentBookings: { id: string; status: string; pnr: string | null; total_cost: number; created_at: string; itinerary: Itinerary | null }[]
}

interface Itinerary { origin?: { code?: string; dateTime?: string }; destination?: { code?: string } }

const MODE_LABEL: Record<string, string> = { cbt: 'CBT · desk books', sbt: 'SBT · self-booking', both: 'Hybrid' }

const route = (i: Itinerary | null) =>
  i?.origin?.code && i?.destination?.code ? `${i.origin.code} → ${i.destination.code}` : 'Flight'
const day = (iso?: string) =>
  iso ? new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : ''
const money = (n: number) => `₹${Math.round(Number(n)).toLocaleString('en-IN')}`
const statusLabel = (st: string) => st.replace(/_/g, ' ')

export default function TmcBookPage() {
  const router = useRouter()
  const [clientId, setClientId] = useState('')
  const [travellerId, setTravellerId] = useState('')
  const [detail, setDetail] = useState<TravellerDetail | null>(null)
  const [detailError, setDetailError] = useState('')
  // Which of the traveller's trips this goes under (TripPicker); reset when
  // the traveller changes, since trips are theirs.
  const [trip, setTrip] = useState<TripChoice>({ kind: 'none' })
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState('')
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTrip({ kind: 'none' }); setStartError('')
  }, [travellerId])
  const [view, setView] = useState<'mine' | 'desk'>('mine')
  // The same check as the rail (tmcNav): null until /api/me answers.
  const [allowed, setAllowed] = useState<boolean | null>(null)
  const [meId, setMeId] = useState('')

  useEffect(() => {
    fetch('/api/me').then(r => r.json())
      .then(d => {
        setMeId(d.employee?.id ?? '')
        // This tab's flow is the signed-in person's (flowStorage.claim).
        flowStorage.claim(d.employee?.id ?? '')
        setAllowed(Boolean(d.ok) && canAccess(d.employee?.role, d.permissions ?? [], 'book_on_behalf'))
      })
      .catch(() => setAllowed(false))
  }, [])

  const clientLookup = useLookup('/api/tmc/clients', clientId, { toOption: clientOption })
  const travellerLookup = useLookup('/api/book/travellers', travellerId, {
    params: { clientId: clientId || null },
    toOption: row => ({
      id: String(row.id),
      label: String(row.full_name),
      sublabel: [row.client_name, row.band_code, row.department].filter(Boolean).join(' · ') || undefined,
    }),
  })

  // Arriving from Traveller profiles or a client's page: start on that person.
  // Read off the URL on mount, as Tabs.tsx does, so the server render matches.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search)
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (q.get('client')) setClientId(q.get('client')!)
    if (q.get('traveller')) setTravellerId(q.get('traveller')!)
  }, [])

  useEffect(() => {
    if (!travellerId) return
    let live = true
    fetch(`/api/book/travellers/${travellerId}`).then(r => r.json()).then(d => {
      if (!live) return
      if (d.ok) { setDetail(d); setDetailError('') } else { setDetail(null); setDetailError(d.error || 'Could not load this traveller.') }
    }).catch(() => { if (live) setDetailError('Could not load this traveller.') })
    return () => { live = false }
  }, [travellerId])

  const shown = travellerId && detail?.traveller.id === travellerId ? detail : null

  async function start() {
    if (!shown || !meId) return
    const t = shown.traveller
    setStarting(true); setStartError('')
    try {
      // A new trip is created now, for the traveller, so nothing is left
      // behind if the desk changes its mind before this point.
      const tripId = await resolveTrip(t.id, trip)
      flowStorage.clearFlow()
      flowStorage.setOnBehalf({
        bookerId: meId, travellerId: t.id, name: t.full_name, clientName: t.client_name, bandCode: t.band_code,
        policy: shown.policy, home: '/tmc/book',
      })
      flowStorage.setTripId(tripId)
      router.push('/book/flights')
    } catch (err) {
      setStartError((err as Error).message)
      setStarting(false)
    }
  }

  if (allowed === false) {
    return (
      <div className="page-frame" style={s.root}>
        <h1 style={s.title}>Book travel</h1>
        <p style={{ ...s.sub, marginTop: 8 }}>
          Booking for travellers needs the <strong>Book for travellers</strong> permission. Your TMC admin can grant it
          under Configurations → Users (TCs).
        </p>
      </div>
    )
  }

  return (
    <div className="page-frame" style={s.root}>
      <div style={s.header}>
        <h1 style={s.title}>Book travel</h1>
        <p style={s.sub}>
          Book for a traveller at one of your clients. Their policy, their approval chain and their
          company&apos;s fares apply — the booking is theirs, recorded as made by you.
        </p>
      </div>

      <div style={s.card}>
        <p style={s.sectionLabel}>Who&apos;s travelling?</p>
        <div style={s.pickers}>
          <div style={s.field}>
            <label style={s.label}>Client</label>
            <SearchableSelect
              value={clientId}
              onChange={id => { setClientId(id); setTravellerId('') }}
              options={clientLookup.options}
              onSearch={clientLookup.onSearch}
              loading={clientLookup.loading}
              selectedLabel={clientLookup.selectedLabel}
              placeholder="Any client — or search by name, code or city…"
              emptyMessage="No clients match"
              allowClear clearLabel="Any client"
            />
          </div>
          <div style={s.field}>
            <label style={s.label}>Traveller</label>
            <SearchableSelect
              value={travellerId}
              onChange={setTravellerId}
              options={travellerLookup.options}
              onSearch={travellerLookup.onSearch}
              loading={travellerLookup.loading}
              selectedLabel={travellerLookup.selectedLabel}
              placeholder="Search people by name, email or department…"
              emptyMessage="Nobody you can book for matches"
            />
          </div>
        </div>

        {detailError && travellerId && <p style={s.errorNote}>{detailError}</p>}

        {shown && (
          <div style={s.person}>
            <div style={s.personHead}>
              <div>
                <p style={s.personName}>{shown.traveller.full_name}</p>
                <p style={s.personMeta}>
                  {[shown.traveller.designation, shown.traveller.department, shown.traveller.email].filter(Boolean).join(' · ')}
                </p>
              </div>
              <button onClick={start} disabled={starting} style={{ ...s.primaryBtn, opacity: starting ? 0.7 : 1 }}>
                {starting ? 'Starting…' : `Search flights for ${shown.traveller.full_name.split(' ')[0]} →`}
              </button>
            </div>

            <div style={s.facts}>
              <Fact label="Client" value={shown.traveller.client_name} sub={MODE_LABEL[shown.traveller.booking_mode] ?? shown.traveller.booking_mode} />
              <Fact label="Band" value={shown.traveller.band_code ?? 'No band'} sub={shown.traveller.band_code ? undefined : 'Policy cannot be checked'} warn={!shown.traveller.band_code} />
              <Fact
                label="What applies"
                value={shown.policy === 'guidance' ? 'Policy as guidance' : 'Policy + approval chain'}
                sub={shown.policy === 'guidance'
                  ? 'No approval. Amber or red needs a reason.'
                  : 'Their own chain decides, as if they booked.'}
              />
              <Fact
                label="Profile"
                value={shown.traveller.profile_ready ? 'Ready' : 'Incomplete'}
                sub={[
                  shown.traveller.profile_ready ? null : 'Date of birth or mobile missing',
                  shown.traveller.has_passport ? 'Passport on file' : 'No passport (domestic only)',
                ].filter(Boolean).join(' · ')}
                warn={!shown.traveller.profile_ready}
              />
            </div>

            <div style={{ ...s.field, marginTop: 16, maxWidth: 420 }}>
              <label style={s.label}>Trip</label>
              <TripPicker travellerId={shown.traveller.id} value={trip} onChange={setTrip} />
              {startError && <p style={s.errorNote}>{startError}</p>}
            </div>

            <p style={{ ...s.sectionLabel, marginTop: 16 }}>Their recent bookings</p>
            {shown.recentBookings.length === 0 ? (
              <p style={s.muted}>None yet.</p>
            ) : (
              <ul style={s.recent}>
                {shown.recentBookings.map(b => (
                  <li key={b.id} style={s.recentRow}>
                    <span style={s.route}>{route(b.itinerary)}</span>
                    <span style={s.muted}>{day(b.itinerary?.origin?.dateTime ?? b.created_at)}</span>
                    <span style={s.status}>{statusLabel(b.status)}</span>
                    <span style={{ marginLeft: 'auto', ...s.amount }}>{money(b.total_cost)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      <div style={s.historyHead}>
        <p style={{ ...s.sectionLabel, margin: 0 }}>Bookings by the desk</p>
        <div style={s.toggle}>
          {(['mine', 'desk'] as const).map(v => (
            <button key={v} onClick={() => setView(v)} style={{ ...s.toggleBtn, ...(view === v ? s.toggleOn : {}) }}>
              {v === 'mine' ? 'Made by me' : clientId ? 'Everyone · this client' : 'Everyone'}
            </button>
          ))}
        </div>
      </div>

      <BookingHistory
        params={view === 'mine' ? { bookedBy: 'me' } : { scope: 'desk', clientId: clientId || null }}
        columns={['traveller', 'client', 'bookedBy']}
        empty={view === 'mine' ? 'You have not booked for anyone yet.' : 'Nothing booked on anyone’s behalf yet.'}
      />

      <p style={{ ...s.muted, marginTop: 14 }}>
        Need to fix someone&apos;s details first? <Link href="/tmc/configurations/traveller-profiles" style={s.link}>Traveller profiles →</Link>
      </p>
    </div>
  )
}

function Fact({ label, value, sub, warn }: { label: string; value: string; sub?: string; warn?: boolean }) {
  return (
    <div style={s.fact}>
      <span style={s.factLabel}>{label}</span>
      <span style={{ ...s.factValue, ...(warn ? { color: '#B45309' } : {}) }}>{value}</span>
      {sub && <span style={s.factSub}>{sub}</span>}
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  root: { fontFamily: "'Inter', -apple-system, sans-serif" },
  header: { marginBottom: 18 },
  title: { fontSize: 20, fontWeight: 600, color: '#0A0A14', margin: '0 0 4px', letterSpacing: '-0.3px' },
  sub: { fontSize: 13, color: '#6B7280', margin: 0, lineHeight: 1.6, maxWidth: 680 },

  card: { background: '#fff', border: '1px solid #E5E7EB', borderRadius: 10, padding: 18, marginBottom: 24 },
  sectionLabel: { fontSize: 11, fontWeight: 700, color: '#9CA3AF', textTransform: 'uppercase', letterSpacing: '0.5px', margin: '0 0 10px' },
  pickers: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 14 },
  field: { display: 'flex', flexDirection: 'column', gap: 5 },
  label: { fontSize: 11, fontWeight: 500, color: '#374151' },

  person: { borderTop: '1px solid #F3F4F6', marginTop: 16, paddingTop: 16 },
  personHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 14, flexWrap: 'wrap' },
  personName: { fontSize: 16, fontWeight: 600, color: '#111827', margin: 0 },
  personMeta: { fontSize: 12, color: '#6B7280', margin: '3px 0 0' },
  primaryBtn: { height: 36, padding: '0 16px', background: '#000835', color: '#fff', fontSize: 13, fontWeight: 600, border: 'none', borderRadius: 7, cursor: 'pointer' },

  facts: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10, marginTop: 14 },
  fact: { display: 'flex', flexDirection: 'column', gap: 2, background: '#F9FAFB', border: '1px solid #F3F4F6', borderRadius: 8, padding: '10px 12px' },
  factLabel: { fontSize: 10.5, fontWeight: 600, color: '#9CA3AF', textTransform: 'uppercase', letterSpacing: '0.4px' },
  factValue: { fontSize: 13, fontWeight: 600, color: '#111827' },
  factSub: { fontSize: 11, color: '#6B7280', lineHeight: 1.45 },

  recent: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 },
  recentRow: { display: 'flex', alignItems: 'center', gap: 12, fontSize: 12.5, padding: '6px 0', borderBottom: '1px solid #F9FAFB' },
  route: { fontWeight: 600, color: '#111827', minWidth: 96 },
  status: { fontSize: 11, textTransform: 'capitalize', color: '#374151', background: '#F3F4F6', borderRadius: 4, padding: '1px 7px' },
  amount: { fontVariantNumeric: 'tabular-nums', color: '#111827' },
  muted: { fontSize: 12.5, color: '#9CA3AF', margin: 0 },
  errorNote: { fontSize: 12.5, color: '#DC2626', background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8, padding: '10px 14px', margin: '14px 0 0' },

  historyHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, gap: 12, flexWrap: 'wrap' },
  toggle: { display: 'flex', background: '#F3F4F6', borderRadius: 8, padding: 3 },
  toggleBtn: { border: 'none', background: 'transparent', fontSize: 12, color: '#6B7280', padding: '5px 12px', borderRadius: 6, cursor: 'pointer' },
  toggleOn: { background: '#fff', color: '#111827', fontWeight: 600, boxShadow: '0 1px 2px rgba(0,0,0,0.06)' },
  link: { color: '#3730A3', textDecoration: 'underline', textUnderlineOffset: 2 },
}
