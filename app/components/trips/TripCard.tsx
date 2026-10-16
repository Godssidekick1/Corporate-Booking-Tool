'use client'

import Link from 'next/link'
import { formatTime, formatDayLabel } from '@/app/lib/book/types'
import { tripStatus, signOffStatus, bookingStatus, bookingHref, money } from '@/app/lib/trips/status'

// ── TripCard ─────────────────────────────────────────────────────────────────
// One trip, the same everywhere a list of trips is shown: My trips, the trips
// page, the travel desk. A white card like a flight card -- a trip used to be
// loose text on the page (a bold name, a pill, grey "No flights added…") with
// its flights as the only cards.
//
//   header   name, status, sign-off; whose it is when it is someone else's;
//            on the right, what it costs and how many flights
//   details  travel type · cost centre · billable · project · dates · budget
//   flights  as rows inside the card, each to the step it is at
//   actions  submit for sign-off / mark complete / delete, as allowed
//
// `base` is where the trip's own page is: /trips on the company side,
// /tmc/trips at the desk.
// ─────────────────────────────────────────────────────────────────────────────

export interface TripCardTrip {
  id: string
  name: string | null
  status: string
  created_at: string
  travel_type?: 'domestic' | 'international' | null
  billable?: boolean
  project?: string | null
  currency?: string
  budget_amount?: number | null
  cost_centre_code?: string | null
  cost_centre_name?: string | null
  approval_status?: string
  sign_off_required?: boolean
  arranged_by_name?: string | null
  flight_count?: number
  total_cost?: number
  first_departure?: string | null
  // Someone else's trip, kept by the viewer.
  traveller_name?: string | null
  arranged_by_me?: boolean
  client_name?: string | null
}

export interface TripCardFlight {
  id: string
  status: string
  pnr: string | null
  total_cost: number | null
  itinerary: {
    origin?: { code: string; city?: string; dateTime?: string }
    destination?: { code: string; city?: string }
    stopCount?: number
  } | null
  fare_breakdown?: { currency?: string } | null
  booked_by_name?: string | null
  booked_by_me?: boolean
  traveller_name?: string | null
}

export interface TripCardActions {
  onSubmit?: () => void
  submitting?: boolean
  onComplete?: () => void
  completing?: boolean
  onDelete?: () => void
  error?: string
}

export default function TripCard({ trip, flights, base = '/trips', others = false, addFlightHref, actions }: {
  trip: TripCardTrip
  // The trip's bookings. Omitted: the card shows the count only.
  flights?: TripCardFlight[]
  base?: '/trips' | '/tmc/trips'
  // Kept for someone else (Arranged for others, the desk): say whose.
  others?: boolean
  addFlightHref?: string
  actions?: TripCardActions
}) {
  const status = tripStatus(trip.status)
  const signOff = trip.approval_status ? signOffStatus(trip.approval_status) : null
  const currency = trip.currency ?? 'INR'
  const live = trip.status === 'open' || trip.status === 'active'
  const count = trip.flight_count ?? flights?.length ?? 0
  const total = trip.total_cost ?? 0

  // What can be done now. Sign-off: the company asks for it, the trip is live
  // and has something in it, and it is not already awaiting or past it. The
  // server checks again (every booking booked) and says why if not.
  const canSubmit = Boolean(actions?.onSubmit) && trip.sign_off_required && live && count > 0
    && !['pending', 'approved'].includes(trip.approval_status ?? 'none')
  const canComplete = Boolean(actions?.onComplete) && live
    && (!trip.sign_off_required || trip.approval_status === 'approved')

  const facts: string[] = []
  if (trip.travel_type) facts.push(trip.travel_type === 'domestic' ? 'Domestic' : 'International')
  if (trip.cost_centre_code) facts.push(`Cost centre ${trip.cost_centre_code}${trip.cost_centre_name ? ` · ${trip.cost_centre_name}` : ''}`)
  if (trip.billable) facts.push('Billable')
  if (trip.project) facts.push(`Project: ${trip.project}`)
  facts.push(trip.first_departure ? `Departs ${formatDayLabel(trip.first_departure)}` : `Created ${shortDate(trip.created_at)}`)

  const budget = trip.budget_amount
  const overBudget = budget != null && total > budget

  return (
    <article style={{ ...s.card, ...(others ? s.cardOthers : {}) }}>
      <header style={s.head}>
        <div style={s.titleBlock}>
          <div style={s.titleRow}>
            <Link href={`${base}/${trip.id}`} style={s.name}>{trip.name || 'Untitled trip'}</Link>
            <span style={{ ...s.pill, color: status.color, background: status.bg }}>{status.label}</span>
            {signOff && <span style={{ ...s.pill, color: signOff.color, background: signOff.bg }}>{signOff.label}</span>}
          </div>
          {(others || trip.arranged_by_name) && (
            <div style={s.chips}>
              {others && trip.traveller_name && (
                <span style={s.forChip}>For {trip.traveller_name}{trip.client_name ? ` · ${trip.client_name}` : ''}</span>
              )}
              <span style={s.byNote}>
                {others
                  ? (trip.arranged_by_me ? 'Set up by you' : 'Their own trip — you booked into it')
                  : `Set up for you by ${trip.arranged_by_name}`}
              </span>
            </div>
          )}
        </div>
        <div style={s.totals}>
          <span style={s.total}>{money(total, currency)}</span>
          <span style={s.count}>{count === 0 ? 'No flights yet' : `${count} flight${count === 1 ? '' : 's'}`}</span>
        </div>
      </header>

      <div style={s.facts}>
        {facts.map((f, i) => <span key={i} style={s.fact}>{f}</span>)}
        {budget != null && (
          <span style={{ ...s.fact, ...(overBudget ? s.over : {}) }}>
            {money(total, currency)} of {money(budget, currency)} budget{overBudget ? ' — over' : ''}
          </span>
        )}
      </div>

      {flights && (flights.length > 0 ? (
        <ul style={s.flights}>
          {flights.map(f => <FlightRow key={f.id} flight={f} others={others} />)}
        </ul>
      ) : (
        <div style={s.empty}>
          <span>No flights in this trip yet.</span>
          {addFlightHref && live && <Link href={addFlightHref} style={s.addLink}>+ Add flight</Link>}
        </div>
      ))}

      {(canSubmit || canComplete || actions?.onDelete || actions?.error) && (
        <footer style={s.foot}>
          {actions?.error && <span style={s.error}>⚠ {actions.error}</span>}
          <div style={s.footActions}>
            {actions?.onDelete && (
              <button type="button" onClick={actions.onDelete} style={s.ghostDanger}>Delete</button>
            )}
            {canComplete && (
              <button type="button" onClick={actions!.onComplete} disabled={actions?.completing} style={s.ghostBtn}>
                {actions?.completing ? 'Marking complete…' : '✓ Mark trip complete'}
              </button>
            )}
            {canSubmit && (
              <button type="button" onClick={actions!.onSubmit} disabled={actions?.submitting} style={s.primaryBtn}>
                {actions?.submitting ? 'Submitting…' : trip.approval_status === 'rejected' ? 'Resubmit for sign-off' : 'Submit for sign-off'}
              </button>
            )}
          </div>
        </footer>
      )}
    </article>
  )
}

// A booking inside a trip card (or the "not in a trip" card): route, when,
// PNR, who booked it, status and fare -- to the step it is at.
export function FlightRow({ flight, others = false }: { flight: TripCardFlight; others?: boolean }) {
  const meta = bookingStatus(flight.status)
  const it = flight.itinerary
  const currency = flight.fare_breakdown?.currency ?? 'INR'
  const bookedBy = others
    ? (flight.booked_by_me ? 'Booked by you' : flight.booked_by_name ? `Booked by ${flight.booked_by_name}` : 'Booked by them')
    : flight.booked_by_name ? `Booked by ${flight.booked_by_name}` : null
  return (
    <li style={s.flightItem}>
      <Link href={bookingHref(flight.id, flight.status)} style={s.flight}>
        <span style={s.route}>
          {it?.origin && it?.destination ? `${it.origin.code} → ${it.destination.code}` : 'Flight'}
          {(it?.stopCount ?? 0) > 0 && <span style={s.stops}>{it!.stopCount} stop{it!.stopCount === 1 ? '' : 's'}</span>}
        </span>
        <span style={s.flightMeta}>
          {others && flight.traveller_name && <span style={s.forChip}>For {flight.traveller_name}</span>}
          {it?.origin?.dateTime && <span>{formatDayLabel(it.origin.dateTime)} · {formatTime(it.origin.dateTime)}</span>}
          {flight.pnr && <span>PNR {flight.pnr}</span>}
          {bookedBy && <span>{bookedBy}</span>}
        </span>
        <span style={{ ...s.pill, color: meta.color, background: meta.bg }}>{meta.label}</span>
        {flight.total_cost != null && <span style={s.fare}>{money(flight.total_cost, currency)}</span>}
      </Link>
    </li>
  )
}

function shortDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
  } catch { return '' }
}

const s: Record<string, React.CSSProperties> = {
  card: {
    background: '#fff', border: '1px solid #E5E7EB', borderRadius: 14, padding: '16px 18px',
    display: 'flex', flexDirection: 'column', gap: 12,
  },
  cardOthers: { borderLeft: '3px solid #A5B4FC' },
  head: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' },
  titleBlock: { display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 },
  titleRow: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  name: { fontSize: 16, fontWeight: 700, color: '#0A0A14', textDecoration: 'none' },
  pill: { fontSize: 11, fontWeight: 700, padding: '3px 9px', borderRadius: 7, whiteSpace: 'nowrap' },
  chips: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  forChip: {
    fontSize: 11, fontWeight: 600, color: '#3730A3', background: '#EEF2FF', border: '1px solid #C7D2FE',
    borderRadius: 999, padding: '2px 9px', whiteSpace: 'nowrap',
  },
  byNote: { fontSize: 11.5, color: '#6B7280' },
  totals: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 },
  total: { fontSize: 15, fontWeight: 700, color: '#111827' },
  count: { fontSize: 11.5, color: '#6B7280' },
  facts: { display: 'flex', flexWrap: 'wrap', gap: '4px 14px', fontSize: 12.5, color: '#4B5563' },
  fact: { whiteSpace: 'nowrap' },
  over: { color: '#B91C1C', fontWeight: 600 },
  flights: { listStyle: 'none', margin: 0, padding: 0, borderTop: '1px solid #F3F4F6' },
  flightItem: { borderBottom: '1px solid #F3F4F6' },
  // Wraps rather than squeezes: on a phone the details drop under the route.
  flight: {
    display: 'flex', flexWrap: 'wrap', alignItems: 'center',
    gap: '4px 14px', padding: '10px 2px', textDecoration: 'none', color: 'inherit',
  },
  route: { fontSize: 14, fontWeight: 700, color: '#0A0A14', whiteSpace: 'nowrap' },
  stops: { fontSize: 10.5, fontWeight: 500, color: '#9CA3AF', marginLeft: 6 },
  flightMeta: { display: 'flex', flexWrap: 'wrap', gap: '2px 12px', fontSize: 12, color: '#6B7280', minWidth: 0, flex: '1 1 200px' },
  fare: { fontSize: 13, fontWeight: 700, color: '#111827', textAlign: 'right', whiteSpace: 'nowrap', minWidth: 72 },
  empty: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap',
    padding: '12px 14px', background: '#F9FAFB', border: '1px dashed #E5E7EB', borderRadius: 10,
    fontSize: 12.5, color: '#6B7280',
  },
  addLink: { fontSize: 12.5, fontWeight: 600, color: '#000835' },
  foot: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' },
  footActions: { display: 'flex', gap: 8, marginLeft: 'auto', flexWrap: 'wrap' },
  error: { fontSize: 12, color: '#B91C1C' },
  primaryBtn: {
    height: 32, padding: '0 14px', background: '#000835', color: '#fff', fontSize: 12.5, fontWeight: 600,
    border: 'none', borderRadius: 8, cursor: 'pointer',
  },
  ghostBtn: {
    height: 32, padding: '0 12px', background: '#fff', color: '#166534', fontSize: 12.5, fontWeight: 600,
    border: '1px solid #BBF7D0', borderRadius: 8, cursor: 'pointer',
  },
  ghostDanger: {
    height: 32, padding: '0 12px', background: '#fff', color: '#B91C1C', fontSize: 12.5, fontWeight: 600,
    border: '1px solid #FECACA', borderRadius: 8, cursor: 'pointer',
  },
}
