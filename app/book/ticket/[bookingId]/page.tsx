'use client'

import { useEffect, useState, useRef } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { formatTime, formatDayLabel } from '@/app/lib/book/types'

// ── /book/ticket/[bookingId] ──────────────────────────────────────────────────
// Displayed once a ticket is issued. Styled as an e-ticket / boarding-pass
// stub rather than a generic confirmation card — that's the standard shape
// people recognize from airline confirmations.
//
// One shared flight header (route, times, cabin, baggage — genuinely common
// to everyone on this PNR), then one stub per traveler underneath with their
// own seat(s) and ticket number. Gate is still deliberately omitted — that's
// only known at check-in and fabricating a value would be misleading on a
// real travel document.
//
// Ticket numbers: paired with each traveler by array index, matching the
// order they were submitted to AddPassengerDetails (see /api/book/ticket —
// it now reads the full PassengerDetails array from Amadeus's response,
// not just index 0). If Amadeus returns fewer ticket numbers than
// passengers for any reason, the extra travelers simply show no ticket
// number rather than a wrong one.
// ─────────────────────────────────────────────────────────────────────────────

interface StopInfo {
  code: string
  city: string
  arrivalDateTime: string
  departureDateTime: string | undefined
}

interface FlightItinerary {
  airline?: { code: string; name: string }
  origin?: { code: string; name: string; city: string; dateTime: string }
  destination?: { code: string; name: string; city: string; dateTime: string }
  duration?: string
  stopCount?: number
  stops?: StopInfo[]
  cabin?: string
  checkInBaggageKg?: string
}

interface BookingPassenger {
  FirstName: string
  LastName: string
  Title: string
  PaxType: 'ADT' | 'CHD' | 'INF' | string
  SeatListDetails?: {
    SeatDesignator: string
    SeatFee: string
    FlightNumber: string
    FlightTime: string
  }[]
}

interface Booking {
  id: string
  status: string
  pnr: string | null
  ticket_numbers: (string | null)[] | null
  total_cost: number
  itinerary: FlightItinerary | null
  traveler_snapshot: {
    Email: string
    Mobile?: string
    PassengerDetails: BookingPassenger[]
  } | null
  fare_breakdown: { currency: string } | null
}

const PAX_TYPE_LABEL: Record<string, string> = {
  ADT: 'Adult', CHD: 'Child', INF: 'Infant',
}

// Legs aren't stored with their own flight numbers on the itinerary — only
// the overall origin/stops/destination sequence. Seats carry FlightTime but
// not which leg they belong to (that association is dropped before
// AddPassengerDetails, since Amadeus's request shape has no field for it).
// Chronological order is reliable for any real itinerary though — legs
// always happen in time order — so seats are sorted by FlightTime and
// paired positionally with the leg sequence built from the itinerary.
interface LegLabel {
  origin: string
  destination: string
}

function buildLegLabels(it: FlightItinerary | null): LegLabel[] {
  if (!it?.origin?.code || !it?.destination?.code) return []
  const points = [it.origin.code, ...(it.stops ?? []).map(s => s.code), it.destination.code]
  return points.slice(0, -1).map((origin, i) => ({ origin, destination: points[i + 1] }))
}

function seatsInLegOrder(seats: BookingPassenger['SeatListDetails']) {
  if (!seats) return []
  return [...seats].sort((a, b) => (a.FlightTime || '').localeCompare(b.FlightTime || ''))
}
// code), seeded off the PNR so the pattern is stable per booking rather
// than reshuffling on every render.
function BarcodeStrip({ seed }: { seed: string }) {
  const bars: number[] = []
  let hash = 0
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0
  for (let i = 0; i < 34; i++) {
    hash = (hash * 1103515245 + 12345) >>> 0
    bars.push(1 + (hash % 3))
  }
  return (
    <div style={{ display: 'flex', alignItems: 'stretch', gap: '2px', height: '36px' }}>
      {bars.map((w, i) => (
        <div key={i} style={{ width: `${w}px`, background: '#0A0A14', opacity: i % 7 === 0 ? 0.4 : 0.85 }} />
      ))}
    </div>
  )
}

export default function TicketPage() {
  const params = useParams<{ bookingId: string }>()
  const bookingId = params.bookingId

  const [booking, setBooking] = useState<Booking | null>(null)
  const [loading, setLoading] = useState(true)
  const [ticketing, setTicketing] = useState(false)
  const [error, setError] = useState('')
  const ticketingRef = useRef(false) // guards against duplicate concurrent issueTicket() calls

  useEffect(() => {
    loadAndMaybeTicket()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookingId])

  async function loadAndMaybeTicket() {
    setLoading(true)
    setError('')
    try {
      const res = await fetch(`/api/book/${bookingId}`)
      const data = await res.json()
      if (!res.ok) {
        setError(data.error || 'Could not load this booking.')
        return
      }
      setBooking(data.booking)
      setLoading(false)

      // A booking that reached this page at status 'held' hasn't been
      // ticketed yet — issue the ticket automatically rather than making
      // the user click a second button right after "Confirm booking".
      // If it's already 'ticketed' (e.g. a refresh), there's nothing to do.
      if (data.booking.status === 'held') {
        await issueTicket()
      }
    } catch {
      setError('Something went wrong loading this booking.')
      setLoading(false)
    }
  }

  async function issueTicket() {
    if (ticketingRef.current) return // already in flight — don't double-fire
    ticketingRef.current = true
    setTicketing(true)
    setError('')
    try {
      const res = await fetch('/api/book/ticket', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bookingId }),
      })
      const data = await res.json()

      if (!data.ok) {
        setError(data.error || 'Could not issue the ticket. You can try again below.')
        return
      }

      setBooking(prev => prev ? {
        ...prev,
        status: 'ticketed',
        pnr: data.pnr ?? prev.pnr,
        ticket_numbers: data.ticketNumbers ?? prev.ticket_numbers,
      } : prev)
    } catch {
      setError('Something went wrong issuing the ticket. You can try again below.')
    } finally {
      setTicketing(false)
      ticketingRef.current = false
    }
  }

  if (loading) {
    return (
      <div style={s.page}>
        <div style={s.root}>
          <div style={s.loadingCard}>
            <div style={s.spinner} />
          </div>
        </div>
      </div>
    )
  }

  if (!booking) {
    return (
      <div style={s.page}>
        <div style={s.root}>
          <div style={s.errorCard}>
            <p style={s.errorTitle}>⚠ {error || 'Booking not found.'}</p>
            <Link href="/book" style={s.errorLink}>← Start a new search</Link>
          </div>
        </div>
      </div>
    )
  }

  const travelers = booking.traveler_snapshot?.PassengerDetails ?? []
  const ticketNumbers = booking.ticket_numbers ?? []
  const isTicketed = booking.status === 'ticketed'
  const it = booking.itinerary
  const currency = booking.fare_breakdown?.currency ?? ''
  const legLabels = buildLegLabels(it)

  return (
    <div style={s.page}>
      <div style={s.root}>
        {ticketing && (
          <div style={s.loadingCard}>
            <div style={s.spinner} />
            <p style={s.loadingText}>Issuing your ticket…</p>
          </div>
        )}

        {!ticketing && isTicketed && (
          <>
            <div style={s.successHero}>
              <div style={s.successIcon}>✓</div>
              <h1 style={s.successHeading}>You're booked!</h1>
              <p style={s.successSub}>Your e-ticket is below — a copy has also been sent to your email.</p>
            </div>

            {/* ── E-ticket / boarding-pass style card ─────────────────── */}
            <div style={s.ticketCard}>
              <div style={s.ticketHeaderBand}>
                <span style={s.airlineName}>{it?.airline?.name ?? 'Airline'}</span>
                <span style={s.eTicketTag}>E-TICKET</span>
              </div>

              <div style={s.ticketBody}>
                {/* Main coupon: route */}
                <div style={s.coupon}>
                  <div style={s.routeRow}>
                    <div style={s.routePoint}>
                      <span style={s.routeTime}>{formatTime(it?.origin?.dateTime)}</span>
                      <span style={s.routeCode}>{it?.origin?.code}</span>
                      <span style={s.routeCity}>{it?.origin?.city}</span>
                    </div>

                    <div style={s.routeMiddle}>
                      <span style={s.routeDate}>{formatDayLabel(it?.origin?.dateTime)}</span>
                      <div style={s.routeLineWrap}>
                        <div style={s.routeDot} />
                        <div style={s.routeLine} />
                        <span style={s.routePlane}>✈</span>
                        <div style={s.routeLine} />
                        <div style={s.routeDot} />
                      </div>
                      <span style={s.routeStops}>
                        {it?.duration ? `${it.duration} · ` : ''}
                        {(it?.stopCount ?? 0) === 0 ? 'Non-stop' : `${it?.stopCount} stop(s)`}
                      </span>
                    </div>

                    <div style={{ ...s.routePoint, alignItems: 'flex-end' as const }}>
                      <span style={s.routeTime}>{formatTime(it?.destination?.dateTime)}</span>
                      <span style={s.routeCode}>{it?.destination?.code}</span>
                      <span style={s.routeCity}>{it?.destination?.city}</span>
                    </div>
                  </div>

                  {(it?.cabin || it?.checkInBaggageKg) && (
                    <div style={s.metaRow}>
                      {it?.cabin && (
                        <div style={s.metaItem}>
                          <span style={s.metaLabel}>Class</span>
                          <span style={s.metaValue}>{it.cabin}</span>
                        </div>
                      )}
                      {it?.checkInBaggageKg && (
                        <div style={s.metaItem}>
                          <span style={s.metaLabel}>Baggage</span>
                          <span style={s.metaValue}>{it.checkInBaggageKg} kg</span>
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* Perforated divider with cutout notches */}
                <div style={s.perforationWrap}>
                  <div style={s.notchLeft} />
                  <div style={s.perforationLine} />
                  <div style={s.notchRight} />
                </div>

                {/* One stub per traveler: their own seat(s), ticket number,
                    and barcode — a shared flight header above covers what's
                    genuinely common to everyone on this PNR. */}
                {travelers.map((t, i) => {
                  const orderedSeats = seatsInLegOrder(t.SeatListDetails)
                  const isLast = i === travelers.length - 1
                  return (
                    <div key={i} style={s.stub}>
                      <div style={s.stubRow}>
                        <span style={s.stubLabel}>Passenger</span>
                        <span style={s.stubValue}>{t.Title} {t.FirstName} {t.LastName}</span>
                      </div>
                      <div style={s.stubRow}>
                        <span style={s.stubLabel}>PNR</span>
                        <span style={s.stubValue}>{booking.pnr || '—'}</span>
                      </div>
                      {ticketNumbers[i] && (
                        <div style={s.stubRow}>
                          <span style={s.stubLabel}>Ticket no.</span>
                          <span style={s.stubValue}>{ticketNumbers[i]}</span>
                        </div>
                      )}
                      {orderedSeats.length > 0 && (
                        <div style={s.seatsByLeg}>
                          {orderedSeats.map((seat, si) => {
                            // legLabels[si] assumes seats sort into the same
                            // order as the itinerary's leg sequence — true
                            // whenever both are chronological, which holds
                            // for any real itinerary (legs happen in order).
                            const leg = legLabels[si]
                            return (
                              <div key={si} style={s.stubRow}>
                                <span style={s.stubLabel}>
                                  {leg ? `${leg.origin} → ${leg.destination}` : `Seat ${si + 1}`}
                                </span>
                                <span style={s.stubValue}>{seat.SeatDesignator}</span>
                              </div>
                            )
                          })}
                        </div>
                      )}
                      <div style={s.barcodeWrap}>
                        <BarcodeStrip seed={(booking.pnr || bookingId) + ticketNumbers[i] + i} />
                      </div>
                      {!isLast && <div style={s.stubDivider} />}
                    </div>
                  )
                })}
              </div>
            </div>

            {/* ── Travelers ────────────────────────────────────────────── */}
            {travelers.length > 0 && (
              <div style={s.card}>
                <h2 style={s.cardTitle}>
                  Travelers <span style={s.travelerCount}>({travelers.length})</span>
                </h2>
                <div style={s.travelerList}>
                  {travelers.map((t, i) => {
                    const orderedSeats = seatsInLegOrder(t.SeatListDetails)
                    return (
                      <div key={i} style={s.travelerRow}>
                        <div style={s.travelerNameCol}>
                          <span style={s.travelerName}>{t.Title} {t.FirstName} {t.LastName}</span>
                          {ticketNumbers[i] && <span style={s.travelerTicketNo}>{ticketNumbers[i]}</span>}
                        </div>
                        <div style={s.travelerRightCol}>
                          {orderedSeats.map((seat, si) => (
                            <span key={si} style={s.travelerSeat}>
                              {legLabels[si] ? `${legLabels[si].origin} ${seat.SeatDesignator}` : seat.SeatDesignator}
                            </span>
                          ))}
                          <span style={s.travelerType}>{PAX_TYPE_LABEL[t.PaxType] ?? t.PaxType}</span>
                        </div>
                      </div>
                    )
                  })}
                </div>
                {booking.traveler_snapshot?.Email && (
                  <p style={s.mutedLine}>{booking.traveler_snapshot.Email}</p>
                )}
              </div>
            )}

            {/* ── Fare (kept minimal — this is a ticket, not an invoice) ── */}
            <div style={s.fareFooter}>
              <span>Total paid</span>
              <span style={s.fareFooterValue}>{currency} {booking.total_cost?.toLocaleString('en-IN')}</span>
            </div>

            <Link href="/book" style={s.doneLink}>Book another flight →</Link>
          </>
        )}

        {!ticketing && !isTicketed && (
          <div style={s.errorCard}>
            <p style={s.errorTitle}>⚠ {error || 'Ticketing did not complete.'}</p>
            <p style={s.errorNote}>
              Your booking is confirmed with the airline — only ticket issuance needs to be retried.
            </p>
            <button type="button" onClick={issueTicket} style={s.retryBtn}>Retry ticketing →</button>
          </div>
        )}
      </div>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  page: { background: '#F9FAFB', minHeight: '100vh' },
  root: { fontFamily: "'Inter', -apple-system, sans-serif", maxWidth: '560px', margin: '0 auto', padding: '32px 24px 64px' },

  loadingCard: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '14px', padding: '80px 0' },
  spinner: { width: '22px', height: '22px', border: '2.5px solid #E5E7EB', borderTopColor: '#000835', borderRadius: '50%' },
  loadingText: { fontSize: '13px', color: '#6B7280', margin: 0 },

  errorCard: { padding: '20px', background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: '14px' },
  errorTitle: { fontSize: '13px', color: '#DC2626', margin: '0 0 8px', lineHeight: 1.5 },
  errorNote: { fontSize: '12px', color: '#7F1D1D', margin: '0 0 14px', lineHeight: 1.5 },
  errorLink: { fontSize: '13px', color: '#DC2626', fontWeight: 600, textDecoration: 'underline' },
  retryBtn: { height: '38px', padding: '0 18px', background: '#DC2626', color: '#fff', fontSize: '13px', fontWeight: 600, border: 'none', borderRadius: '8px', cursor: 'pointer' },

  successHero: { textAlign: 'center' as const, padding: '20px 0 28px' },
  successIcon: { width: '52px', height: '52px', borderRadius: '50%', background: '#ECFDF5', color: '#065F46', fontSize: '24px', fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 14px' },
  successHeading: { fontSize: '22px', fontWeight: 700, color: '#0A0A14', margin: '0 0 4px' },
  successSub: { fontSize: '13px', color: '#6B7280', margin: 0 },

  // ── E-ticket card ──────────────────────────────────────────────────────
  ticketCard: {
    background: '#fff', borderRadius: '18px', marginBottom: '16px', overflow: 'hidden',
    boxShadow: '0 1px 3px rgba(0,0,0,0.06), 0 8px 24px rgba(0,8,53,0.08)', border: '1px solid #E5E7EB',
  },
  ticketHeaderBand: {
    background: '#000835', padding: '13px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
  },
  airlineName: { color: '#fff', fontSize: '13px', fontWeight: 700, letterSpacing: '0.2px' },
  eTicketTag: { color: '#A5B4E8', fontSize: '10px', fontWeight: 700, letterSpacing: '1.2px' },

  ticketBody: { position: 'relative' as const },
  coupon: { padding: '22px 20px 18px' },

  routeRow: { display: 'flex', alignItems: 'flex-start', gap: '10px' },
  routePoint: { display: 'flex', flexDirection: 'column', gap: '2px', flex: '0 0 auto', minWidth: '70px' },
  routeTime: { fontSize: '20px', fontWeight: 700, color: '#0A0A14', letterSpacing: '-0.3px' },
  routeCode: { fontSize: '13px', fontWeight: 700, color: '#374151' },
  routeCity: { fontSize: '10.5px', color: '#9CA3AF' },

  routeMiddle: { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px', paddingTop: '2px' },
  routeDate: { fontSize: '10px', color: '#9CA3AF', fontWeight: 600, letterSpacing: '0.3px' },
  routeLineWrap: { display: 'flex', alignItems: 'center', width: '100%', gap: '2px' },
  routeDot: { width: '4px', height: '4px', borderRadius: '50%', background: '#000835', flexShrink: 0 },
  routeLine: { flex: 1, height: '1px', background: '#D1D5DB' },
  routePlane: { fontSize: '11px', color: '#000835', transform: 'rotate(90deg)', flexShrink: 0 },
  routeStops: { fontSize: '10px', color: '#9CA3AF' },

  metaRow: { display: 'flex', gap: '24px', marginTop: '18px', paddingTop: '14px', borderTop: '1px solid #F3F4F6' },
  metaItem: { display: 'flex', flexDirection: 'column', gap: '2px' },
  metaLabel: { fontSize: '9.5px', color: '#9CA3AF', fontWeight: 600, letterSpacing: '0.4px', textTransform: 'uppercase' as const },
  metaValue: { fontSize: '12.5px', color: '#111827', fontWeight: 600 },

  perforationWrap: { position: 'relative' as const, height: '0px' },
  notchLeft: { position: 'absolute' as const, left: '-10px', top: '-10px', width: '20px', height: '20px', borderRadius: '50%', background: '#F9FAFB' },
  notchRight: { position: 'absolute' as const, right: '-10px', top: '-10px', width: '20px', height: '20px', borderRadius: '50%', background: '#F9FAFB' },
  perforationLine: { borderTop: '1.5px dashed #D1D5DB', margin: '0 14px' },

  stub: { padding: '18px 20px 20px', background: '#FAFAFB' },
  seatsByLeg: { display: 'flex', flexDirection: 'column' as const, gap: '2px' },
  stubRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 0' },
  stubLabel: { fontSize: '11px', color: '#6B7280', fontWeight: 500 },
  stubValue: { fontSize: '13px', color: '#0A0A14', fontWeight: 700, letterSpacing: '0.4px' },
  stubDivider: { height: '1px', background: '#E5E7EB', margin: '14px 0 -2px' },
  barcodeWrap: { marginTop: '12px', display: 'flex', justifyContent: 'center' },

  // ── Traveler / fare cards ────────────────────────────────────────────
  card: { background: '#fff', border: '1px solid #E5E7EB', borderRadius: '14px', padding: '20px', marginBottom: '16px' },
  cardTitle: { fontSize: '14px', fontWeight: 600, color: '#111827', margin: '0 0 14px', display: 'flex', alignItems: 'center', gap: '6px' },
  travelerCount: { fontSize: '12px', fontWeight: 500, color: '#9CA3AF' },

  travelerList: { display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '10px' },
  travelerRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingBottom: '8px', borderBottom: '1px solid #F3F4F6' },
  travelerNameCol: { display: 'flex', flexDirection: 'column', gap: '2px' },
  travelerName: { fontSize: '13px', fontWeight: 600, color: '#111827' },
  travelerTicketNo: { fontSize: '10.5px', color: '#9CA3AF', letterSpacing: '0.2px' },
  travelerRightCol: { display: 'flex', alignItems: 'center', gap: '6px' },
  travelerSeat: { fontSize: '10.5px', fontWeight: 600, color: '#000835', background: '#EEF2FF', padding: '2px 8px', borderRadius: '5px' },
  travelerType: { fontSize: '10.5px', color: '#6B7280', background: '#F3F4F6', padding: '2px 8px', borderRadius: '5px', fontWeight: 500 },
  mutedLine: { fontSize: '12px', color: '#9CA3AF', margin: 0 },

  fareFooter: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 4px 20px', fontSize: '12px', color: '#9CA3AF' },
  fareFooterValue: { fontSize: '13px', fontWeight: 600, color: '#6B7280' },

  doneLink: {
    display: 'block', textAlign: 'center' as const, height: '48px', lineHeight: '48px', width: '100%',
    background: '#000835', color: '#fff', fontSize: '14px', fontWeight: 700, borderRadius: '10px',
    textDecoration: 'none', letterSpacing: '0.2px',
  },
}