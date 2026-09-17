'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { formatTime, formatDayLabel, journeyLabel } from '@/app/lib/book/types'
import { mealLabel } from '@/app/lib/book/mealCodes'

// ── /t/[token] — the public e-ticket ─────────────────────────────────────────
// Where the QR on the ticket points. Deliberately OUTSIDE the authenticated
// area: proxy.ts gates on an explicit allow-list of protected prefixes
// (/dashboard, /book, /bookings, /tmc …) and `/t` is not on it, so this renders
// for whoever holds the link.
//
// That is the entire point. A ticket is read at an airport, on a phone, often by
// someone who is not the traveller — and a page that demands a password at that
// moment is a page that failed.
//
// The projection behind it lives in /api/public/ticket/[token] and is the thing
// to read before changing anything here: the passport arrives already masked and
// the date of birth is not in the response at all, so there is nothing on this
// page that could accidentally render either.
//
// Printing: the Download button calls window.print(). The print rules live in
// globals.css keyed on .ticket-sheet and .no-print, because every other page in
// this app styles with inline objects and @media has nothing to hook onto there.
// ─────────────────────────────────────────────────────────────────────────────

interface Journey {
  journeyNo: number
  origin?: { code: string; name: string; city: string; dateTime: string; terminal?: string }
  destination?: { code: string; name: string; city: string; dateTime: string; terminal?: string }
  airline?: { code: string; name: string }
  stops: { code: string; city: string; arrivalDateTime: string; departureDateTime?: string }[]
  stopCount: number
  duration?: string
  totalDuration?: string
  legs: { airlineCode?: string; flightNumber?: string; bookingCode?: string; cabin?: string }[]
  checkInBaggageKg?: string
  cabinBaggageKg?: string
}

interface PublicTicket {
  pnr: string | null
  reference: string | null
  itinerary: {
    airline?: { code: string; name: string }
    origin?: { code: string; city: string; dateTime: string }
    destination?: { code: string; city: string; dateTime: string }
    cabin?: string
    journeys?: Journey[]
  } | null
  passengers: {
    title?: string
    firstName?: string
    middleName?: string
    lastName?: string
    paxType?: string
    mealCode?: string
    passport: string | null
    ticketNumber: string | null
    seats: { SeatDesignator: string; SeatFee: string }[]
  }[]
  contact: { email: string | null; mobile: string | null }
  fare: {
    currency: string
    base: number | null
    taxTotal: number | null
    taxLines: { code: string; amount: number }[]
    fare: number | null
    lines: { label: string; sign: -1 | 1; amount: number }[]
    seatFees: number
    total: number | null
  }
}

const PAX_TYPE_LABEL: Record<string, string> = { ADT: 'Adult', CHD: 'Child', INF: 'Infant' }

// Layover between two legs of the same journey, from the arrival of one and the
// departure of the next. Both are on the stop already; only the subtraction was
// missing, which is why a connection read as "1 stop" and nothing else.
function layover(arrival: string | undefined, departure: string | undefined): string | null {
  if (!arrival || !departure) return null
  const minutes = Math.round((new Date(departure).getTime() - new Date(arrival).getTime()) / 60000)
  if (!Number.isFinite(minutes) || minutes <= 0) return null
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

export default function PublicTicketPage() {
  const params = useParams<{ token: string }>()
  const [ticket, setTicket] = useState<PublicTicket | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch(`/api/public/ticket/${params.token}`)
        const data = await res.json()
        if (!res.ok || !data.ok) {
          setError('This ticket link is not valid. It may have been revoked, or the booking may not have been ticketed.')
          return
        }
        setTicket(data.ticket)
      } catch {
        setError('Could not load this ticket. Please check your connection.')
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [params.token])

  if (loading) {
    return <div style={s.page}><div style={s.centre}><div style={s.spinner} /></div></div>
  }

  if (error || !ticket) {
    return (
      <div style={s.page}>
        <div style={s.centre}>
          <p style={s.errorTitle}>Ticket not found</p>
          <p style={s.errorBody}>{error}</p>
        </div>
      </div>
    )
  }

  const journeys = ticket.itinerary?.journeys ?? []
  const { fare } = ticket

  return (
    <div style={s.page}>
      <div className="ticket-sheet" style={s.sheet}>
        <div style={s.header}>
          <div>
            <p style={s.eyebrow}>E-ticket</p>
            <h1 style={s.airline}>{ticket.itinerary?.airline?.name ?? 'Your flight'}</h1>
          </div>
          <div style={s.headerRight}>
            <p style={s.pnrLabel}>PNR</p>
            <p style={s.pnrValue}>{ticket.pnr ?? '—'}</p>
          </div>
        </div>

        {/* ── Journeys ───────────────────────────────────────────────── */}
        {journeys.map(journey => (
          <section key={journey.journeyNo} style={s.journey}>
            {journeys.length > 1 && (
              <p style={s.journeyLabel}>{journeyLabel(journey.journeyNo)}</p>
            )}

            <div style={s.route}>
              <div style={s.routeEnd}>
                <p style={s.routeTime}>{formatTime(journey.origin?.dateTime)}</p>
                <p style={s.routeCode}>{journey.origin?.code}</p>
                <p style={s.routeName}>{journey.origin?.name ?? journey.origin?.city}</p>
                {journey.origin?.terminal && <p style={s.routeTerminal}>Terminal {journey.origin.terminal}</p>}
                <p style={s.routeDate}>{formatDayLabel(journey.origin?.dateTime)}</p>
              </div>

              <div style={s.routeMid}>
                <p style={s.routeDuration}>{journey.totalDuration ?? journey.duration ?? ''}</p>
                <div style={s.routeLine} />
                <p style={s.routeStops}>
                  {journey.stopCount === 0 ? 'Non-stop' : `${journey.stopCount} stop${journey.stopCount > 1 ? 's' : ''}`}
                </p>
              </div>

              <div style={{ ...s.routeEnd, textAlign: 'right' as const }}>
                <p style={s.routeTime}>{formatTime(journey.destination?.dateTime)}</p>
                <p style={s.routeCode}>{journey.destination?.code}</p>
                <p style={s.routeName}>{journey.destination?.name ?? journey.destination?.city}</p>
                {journey.destination?.terminal && <p style={s.routeTerminal}>Terminal {journey.destination.terminal}</p>}
                <p style={s.routeDate}>{formatDayLabel(journey.destination?.dateTime)}</p>
              </div>
            </div>

            {/* Stops, itemised. A connection used to read as "1 stop" and
                nothing else — where, for how long and what the onward flight
                is were all in the data and none of it was shown. */}
            {journey.stops.length > 0 && (
              <div style={s.stopList}>
                {journey.stops.map((stop, i) => {
                  const wait = layover(stop.arrivalDateTime, stop.departureDateTime)
                  return (
                    <p key={i} style={s.stopLine}>
                      Connection at <strong>{stop.city} ({stop.code})</strong>
                      {' · arrives '}{formatTime(stop.arrivalDateTime)}
                      {stop.departureDateTime && <>{', departs '}{formatTime(stop.departureDateTime)}</>}
                      {wait && <>{' · '}{wait} layover</>}
                    </p>
                  )
                })}
              </div>
            )}

            <div style={s.legList}>
              {journey.legs.map((leg, i) => (
                <span key={i} style={s.legChip}>
                  {leg.airlineCode} {leg.flightNumber}
                  {leg.bookingCode && <span style={s.legClass}> · class {leg.bookingCode}</span>}
                </span>
              ))}
              {journey.checkInBaggageKg && (
                <span style={s.legChip}>{journey.checkInBaggageKg}kg check-in</span>
              )}
              {journey.cabinBaggageKg && (
                <span style={s.legChip}>{journey.cabinBaggageKg}kg cabin</span>
              )}
            </div>
          </section>
        ))}

        {/* ── Passengers ─────────────────────────────────────────────── */}
        <section style={s.section}>
          <p style={s.sectionTitle}>Passengers</p>
          {ticket.passengers.map((p, i) => (
            <div key={i} style={s.pax}>
              <div style={s.paxTop}>
                <span style={s.paxName}>
                  {[p.title, p.firstName, p.middleName, p.lastName].filter(Boolean).join(' ')}
                </span>
                <span style={s.paxType}>{PAX_TYPE_LABEL[p.paxType ?? ''] ?? p.paxType}</span>
              </div>
              <div style={s.paxDetails}>
                {p.ticketNumber && <span style={s.paxDetail}>Ticket {p.ticketNumber}</span>}
                {/* Already masked by the API — the full number never reaches
                    this page, so there is nothing here to reveal. */}
                {p.passport && <span style={s.paxDetail}>Passport {p.passport}</span>}
                {mealLabel(p.mealCode) && <span style={s.paxDetail}>Meal: {mealLabel(p.mealCode)}</span>}
                {p.seats.map((seat, si) => (
                  <span key={si} style={s.paxDetail}>Seat {seat.SeatDesignator}</span>
                ))}
              </div>
            </div>
          ))}
        </section>

        {/* ── Fare ───────────────────────────────────────────────────── */}
        <section style={s.section}>
          <p style={s.sectionTitle}>Fare</p>
          {fare.base !== null && (
            <div style={s.fareRow}>
              <span style={s.fareLabel}>Base fare</span>
              <span style={s.fareValue}>{fare.currency} {fare.base.toLocaleString('en-IN')}</span>
            </div>
          )}
          {fare.taxTotal !== null && (
            <div style={s.fareRow}>
              <span style={s.fareLabel}>Taxes &amp; surcharges</span>
              <span style={s.fareValue}>{fare.currency} {fare.taxTotal.toLocaleString('en-IN')}</span>
            </div>
          )}
          {fare.lines.map(line => (
            <div key={line.label} style={s.fareRow}>
              <span style={s.fareLabel}>{line.label}</span>
              <span style={{ ...s.fareValue, ...(line.sign === -1 ? s.fareCredit : {}) }}>
                {line.sign === -1 ? '− ' : '+ '}{fare.currency} {line.amount.toLocaleString('en-IN')}
              </span>
            </div>
          ))}
          {fare.seatFees > 0 && (
            <div style={s.fareRow}>
              <span style={s.fareLabel}>Seat selection</span>
              <span style={s.fareValue}>{fare.currency} {fare.seatFees.toLocaleString('en-IN')}</span>
            </div>
          )}
          {fare.total !== null && (
            <div style={s.fareTotalRow}>
              <span style={s.fareTotalLabel}>Total paid</span>
              <span style={s.fareTotalValue}>{fare.currency} {fare.total.toLocaleString('en-IN')}</span>
            </div>
          )}
        </section>

        <section style={s.section}>
          <p style={s.sectionTitle}>Contact</p>
          <p style={s.contactLine}>{ticket.contact.email}</p>
          {ticket.contact.mobile && <p style={s.contactLine}>{ticket.contact.mobile}</p>}
          {ticket.reference && <p style={s.reference}>Booking reference {ticket.reference}</p>}
        </section>

        <button type="button" className="no-print" onClick={() => window.print()} style={s.printBtn}>
          Download / print
        </button>
      </div>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  page: { minHeight: '100vh', background: '#F3F4F6', padding: '24px 16px', fontFamily: "'Inter', -apple-system, sans-serif" },
  sheet: {
    maxWidth: '640px', margin: '0 auto', background: '#fff',
    border: '1px solid #E5E7EB', borderRadius: '16px', padding: '26px 24px 24px',
  },
  centre: { maxWidth: '420px', margin: '80px auto', textAlign: 'center' as const },
  spinner: {
    width: '28px', height: '28px', margin: '0 auto', borderRadius: '50%',
    border: '3px solid #E5E7EB', borderTopColor: '#000835', animation: 'spin 0.8s linear infinite',
  },
  errorTitle: { fontSize: '18px', fontWeight: 700, color: '#111827', margin: '0 0 8px' },
  errorBody: { fontSize: '13.5px', color: '#6B7280', lineHeight: 1.6, margin: 0 },

  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '16px', paddingBottom: '18px', borderBottom: '1.5px solid #111827' },
  eyebrow: { fontSize: '10px', fontWeight: 700, letterSpacing: '1px', textTransform: 'uppercase' as const, color: '#9CA3AF', margin: '0 0 4px' },
  airline: { fontSize: '20px', fontWeight: 700, color: '#0A0A14', margin: 0 },
  headerRight: { textAlign: 'right' as const },
  pnrLabel: { fontSize: '10px', fontWeight: 700, letterSpacing: '1px', textTransform: 'uppercase' as const, color: '#9CA3AF', margin: '0 0 4px' },
  pnrValue: { fontSize: '18px', fontWeight: 700, color: '#0A0A14', letterSpacing: '1px', margin: 0, fontVariantNumeric: 'tabular-nums' },

  journey: { padding: '18px 0', borderBottom: '1px solid #F3F4F6' },
  journeyLabel: { fontSize: '10px', fontWeight: 700, letterSpacing: '0.6px', textTransform: 'uppercase' as const, color: '#9CA3AF', margin: '0 0 10px' },
  route: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '14px' },
  routeEnd: { flex: '0 0 auto', minWidth: 0 },
  routeTime: { fontSize: '20px', fontWeight: 700, color: '#0A0A14', margin: '0 0 2px' },
  routeCode: { fontSize: '12px', fontWeight: 700, color: '#374151', margin: '0 0 2px' },
  routeName: { fontSize: '11px', color: '#6B7280', margin: '0 0 2px', lineHeight: 1.35 },
  routeTerminal: { fontSize: '10.5px', color: '#9CA3AF', margin: '0 0 2px' },
  routeDate: { fontSize: '10.5px', color: '#9CA3AF', margin: 0 },
  routeMid: { flex: 1, textAlign: 'center' as const, paddingTop: '6px' },
  routeDuration: { fontSize: '11px', color: '#6B7280', margin: '0 0 4px' },
  routeLine: { height: '1px', background: '#D1D5DB' },
  routeStops: { fontSize: '10.5px', color: '#9CA3AF', margin: '4px 0 0' },

  stopList: { marginTop: '12px', display: 'flex', flexDirection: 'column' as const, gap: '4px' },
  stopLine: { fontSize: '11.5px', color: '#6B7280', margin: 0, lineHeight: 1.5 },
  legList: { marginTop: '12px', display: 'flex', flexWrap: 'wrap' as const, gap: '6px' },
  legChip: { fontSize: '11px', color: '#374151', background: '#F9FAFB', border: '1px solid #E5E7EB', borderRadius: '6px', padding: '3px 8px' },
  legClass: { color: '#9CA3AF' },

  section: { padding: '18px 0', borderBottom: '1px solid #F3F4F6' },
  sectionTitle: { fontSize: '10px', fontWeight: 700, letterSpacing: '0.6px', textTransform: 'uppercase' as const, color: '#9CA3AF', margin: '0 0 12px' },
  pax: { marginBottom: '14px' },
  paxTop: { display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' as const },
  paxName: { fontSize: '14px', fontWeight: 600, color: '#111827' },
  paxType: { fontSize: '10.5px', color: '#9CA3AF' },
  paxDetails: { display: 'flex', flexWrap: 'wrap' as const, gap: '5px', marginTop: '6px' },
  paxDetail: { fontSize: '11px', color: '#374151', background: '#F9FAFB', border: '1px solid #E5E7EB', borderRadius: '6px', padding: '3px 8px' },

  fareRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' },
  fareLabel: { fontSize: '12.5px', color: '#6B7280' },
  fareValue: { fontSize: '13.5px', fontWeight: 600, color: '#111827', fontVariantNumeric: 'tabular-nums' },
  fareCredit: { color: '#166534' },
  fareTotalRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1.5px solid #111827', paddingTop: '10px', marginTop: '4px' },
  fareTotalLabel: { fontSize: '13px', fontWeight: 600, color: '#111827' },
  fareTotalValue: { fontSize: '17px', fontWeight: 700, color: '#0A0A14', fontVariantNumeric: 'tabular-nums' },

  contactLine: { fontSize: '12.5px', color: '#374151', margin: '0 0 4px' },
  reference: { fontSize: '11px', color: '#9CA3AF', margin: '8px 0 0' },

  printBtn: {
    width: '100%', marginTop: '20px', padding: '12px', background: '#000835', color: '#fff',
    border: 'none', borderRadius: '10px', fontSize: '13px', fontWeight: 600, cursor: 'pointer',
  },
}
