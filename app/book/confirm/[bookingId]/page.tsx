'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { round2 } from '@/app/lib/commercials/fareComponents'
import { mealLabel } from '@/app/lib/book/mealCodes'

// Tax codes a traveller might reasonably want named. Anything not in here shows
// its raw code, which is the honest fallback — inventing a description for a
// code we do not recognise would be worse than showing the code the airline used.
const TAX_LABELS: Record<string, string> = {
  YQ: 'Fuel surcharge (YQ)',
  YR: 'Carrier-imposed fee (YR)',
  K3: 'GST (K3)',
  OT: 'Other taxes',
  IN: 'Passenger service fee (IN)',
  WO: 'User development fee (WO)',
  P2: 'Aviation security fee (P2)',
}

// The exits every terminal state needs. A booking that is rejected, failed, or
// stuck on broken approval routing is over — there is nothing to retry on this
// page — so the only useful thing left is somewhere to go.
function TerminalExits() {
  return (
    <div style={s.terminalExits}>
      <Link href="/book/flights" style={s.terminalExitPrimary}>Start a new search →</Link>
      <Link href="/bookings" style={s.terminalExit}>View my trips</Link>
      <Link href="/dashboard" style={s.terminalExit}>Dashboard</Link>
    </div>
  )
}

interface Booking {
  id: string
  status: string
  provider: string
  provider_order_id: string
  // What the AIRLINE charges. Kept for reference; the traveller is shown
  // sell_total.
  total_cost: number
  // What the corporate is invoiced. Undefined on bookings made before
  // commercial rules existed, hence the fallback at every read site.
  sell_total?: number
  // Discount and processing fee only — the server never sends a markup, so
  // there is nothing here to accidentally render.
  commercial_lines?: { source: string; label: string; sign: -1 | 1; amount: number }[]
  // The sell-side fare: base with the markup already inside it, the tax total,
  // and the airline's own tax codes. Absent on pre-commercial-rules bookings.
  fare?: {
    base: number
    taxTotal: number | null
    taxLines: { code: string; amount: number }[]
    fare: number
  } | null
  seat_fees?: number
  policy_verdict: 'green' | 'amber' | 'red' | null
  policy_verdict_detail: {
    breaches?: { limit_key: string; kind: string; policyValue: unknown; actualValue: unknown }[]
    costTier?: string
  } | null
  itinerary: {
    airline?: { code: string; name: string }
    origin?: { code: string; name: string; city: string; dateTime: string }
    destination?: { code: string; name: string; city: string; dateTime: string }
    duration?: string
    stopCount?: number
    stops?: { code: string; city: string; arrivalDateTime: string; departureDateTime: string | undefined }[]
  } | null
  traveler_snapshot: {
    Email: string
    Mobile: string
    PassengerDetails: {
      FirstName: string
      LastName: string
      Title: string
      PaxType: 'ADT' | 'CHD' | 'INF' | string
      // The IATA special-meal code sent to the airline, '' for the standard
      // tray. Optional because bookings made before meals were wired carry none.
      MealCode?: string
      SeatListDetails?: {
        SeatDesignator: string
        SeatFee: string
        FlightNumber: string
        FlightTime: string
      }[]
    }[]
  } | null
  fare_breakdown: {
    currency: string
    isRefundable: boolean
    fareType: string
    passengerBreakup?: { PaxType: string; BaseFare: number; Tax: number; TotalFare: number }[]
    seatFees?: number
  } | null
}

interface LatestApproval {
  id: string
  tier: number
  status: 'pending' | 'approved' | 'rejected'
  reason: string | null
  decision_note: string | null
  approverName: string | null
}

const PAX_TYPE_LABEL: Record<string, string> = {
  ADT: 'Adult', CHD: 'Child', INF: 'Infant',
}

const VERDICT_META: Record<string, { label: string; color: string; bg: string; border: string }> = {
  green: { label: 'Within policy',       color: '#166534', bg: '#F0FDF4', border: '#BBF7D0' },
  amber: { label: 'Minor policy breach', color: '#92400E', bg: '#FFFBEB', border: '#FDE68A' },
  red:   { label: 'Policy breach',       color: '#991B1B', bg: '#FEF2F2', border: '#FECACA' },
}

const LIMIT_LABELS: Record<string, string> = {
  max_fare_domestic: 'domestic fare limit',
  max_fare_intl: 'international fare limit',
  advance_booking_days: 'minimum advance booking window',
  cabin_class_short_haul: 'cabin class entitlement (short-haul)',
  cabin_class_long_haul: 'cabin class entitlement (long-haul)',
  connecting_flights_allowed: 'connecting flights entitlement',
  max_seat_selection_fee: 'seat selection spend limit',
}

function breachLine(b: { limit_key: string; kind: string; policyValue: unknown; actualValue: unknown }): string {
  const label = LIMIT_LABELS[b.limit_key] ?? b.limit_key
  if (b.kind === 'boolean') return `${label} is not permitted for this employee`
  return `${label} exceeded (policy: ${b.policyValue}, actual: ${b.actualValue})`
}

// Legs aren't stored with their own flight numbers on the itinerary — only
// the overall origin/stops/destination sequence. Seats carry FlightTime but
// not which leg they belong to (that association is dropped before
// AddPassengerDetails, since Amadeus's request shape has no field for it).
// Chronological order is reliable for any real itinerary though — legs
// always happen in time order — so seats are sorted by FlightTime and
// paired positionally with the leg sequence built from the itinerary.
function buildLegLabels(it: Booking['itinerary']): { origin: string; destination: string }[] {
  if (!it?.origin?.code || !it?.destination?.code) return []
  const points = [it.origin.code, ...(it.stops ?? []).map(s => s.code), it.destination.code]
  return points.slice(0, -1).map((origin, i) => ({ origin, destination: points[i + 1] }))
}

function seatsInLegOrder(seats: { SeatDesignator: string; SeatFee: string; FlightNumber: string; FlightTime: string }[] | undefined) {
  if (!seats) return []
  return [...seats].sort((a, b) => (a.FlightTime || '').localeCompare(b.FlightTime || ''))
}

function formatTime(iso: string | undefined) {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })
  } catch {
    return '—'
  }
}

export default function ConfirmBookingPage() {
  const router = useRouter()
  const params = useParams<{ bookingId: string }>()
  const bookingId = params.bookingId

  const [booking, setBooking] = useState<Booking | null>(null)
  const [latestApproval, setLatestApproval] = useState<LatestApproval | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState('')
  const [errorCode, setErrorCode] = useState<string | null>(null)
  // Collapsed by default: one tax number is what a traveller wants, the codes
  // are what a finance team asks for afterwards.
  const [taxesOpen, setTaxesOpen] = useState(false)

  useEffect(() => {
    loadBooking()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookingId])

  // Reaching this page means passenger details are already submitted
  // (add-passenger already ran) — there's no valid "go back and redo
  // seatmap/pricing" state past this point, that would desync from the
  // booking row that already exists server-side.
  //
  // So back does not go back. It goes to the dashboard, which is a reasonable
  // destination — but it used to REPLACE, which destroyed forward history, and
  // it happened with no warning on a page that offered no other exit. Silently
  // doing something a traveller did not ask for is only tolerable while it is
  // the single way out; now that the flow chrome carries a Dashboard link and
  // a Start a new search link, this can push instead, leaving their history
  // intact so forward still works.
  useEffect(() => {
    function handlePopState() {
      router.push('/dashboard')
    }
    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [router])

  // While waiting on a human approval, poll every 8s so the employee sees
  // the moment an approver acts without needing to refresh manually. Stops
  // itself once status leaves 'pending_approval'.
  useEffect(() => {
    if (booking?.status !== 'pending_approval') return
    const interval = setInterval(() => {
      loadBooking({ silent: true })
    }, 8000)
    return () => clearInterval(interval)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [booking?.status])

  async function loadBooking(opts?: { silent?: boolean }) {
    if (!opts?.silent) setLoading(true)
    setLoadError('')
    try {
      const res = await fetch(`/api/book/${bookingId}`)
      const data = await res.json()
      if (!res.ok) {
        setLoadError(data.error || 'Could not load this booking.')
        return
      }
      setBooking(data.booking)
      setLatestApproval(data.latestApproval ?? null)

      // If this booking has already moved past the pre-Book stage (e.g. the
      // user hit back after confirming, or refreshed after clicking Book),
      // send them forward to wherever they actually are instead of letting
      // them try to re-book an already-booked reservation.
      if (data.booking.status === 'held' || data.booking.status === 'ticketed') {
        router.replace(`/book/ticket/${bookingId}`)
      }
    } catch {
      setLoadError('Something went wrong loading this booking.')
    } finally {
      if (!opts?.silent) setLoading(false)
    }
  }

  async function handleConfirmBooking() {
    setConfirming(true)
    setError('')
    setErrorCode(null)
    try {
      const res = await fetch('/api/book/booking', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bookingId }),
      })
      const data = await res.json()

      if (!data.ok) {
        setError(data.error || 'Could not complete the booking. Please try again.')
        setErrorCode(data.code ?? null)
        if (data.code === 'SEARCH_EXPIRED') {
          // Server already marked this booking 'failed' — refetch so the
          // page stops showing the now-stale 'approved' action buttons
          // alongside the Search again prompt.
          loadBooking({ silent: true })
        }
        return
      }

      router.replace(`/book/ticket/${bookingId}`)
    } catch {
      setError('Something went wrong completing the booking. Please try again.')
    } finally {
      setConfirming(false)
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

  if (loadError || !booking) {
    return (
      <div style={s.page}>
        <div style={s.root}>
          <div style={s.errorCard}>
            <p style={s.errorTitle}>⚠ {loadError || 'Booking not found.'}</p>
            {/* /book/flights, not /book — /book is the trips list and has no
                search form on it. */}
            <Link href="/book/flights" style={s.errorLink}>← Start a new search</Link>
          </div>
        </div>
      </div>
    )
  }

  const travelers = booking.traveler_snapshot?.PassengerDetails ?? []
  const legLabels = buildLegLabels(booking.itinerary)
  const adultCount = travelers.filter(t => t.PaxType === 'ADT').length
  const childCount = travelers.filter(t => t.PaxType === 'CHD').length
  const infantCount = travelers.filter(t => t.PaxType === 'INF').length
  const travelerCountParts = [
    adultCount > 0 && `${adultCount} adult${adultCount > 1 ? 's' : ''}`,
    childCount > 0 && `${childCount} child${childCount > 1 ? 'ren' : ''}`,
    infantCount > 0 && `${infantCount} infant${infantCount > 1 ? 's' : ''}`,
  ].filter(Boolean)

  // editableStatuses lived here to gate an "Edit travelers" link. The link
  // pointed at a route that was never built, so the list gated nothing.

  // ── The fare card's numbers, derived once ────────────────────────────────
  const currency = booking.fare_breakdown?.currency ?? ''
  const sellTotal = booking.sell_total ?? 0
  const seatFees = booking.seat_fees ?? booking.fare_breakdown?.seatFees ?? 0
  const commercialDelta = (booking.commercial_lines ?? []).reduce((sum, l) => sum + l.sign * l.amount, 0)

  // Prefer the server's displayedFare. Falls back to deriving it by subtraction
  // for pre-commercials bookings, where there are no frozen components — on
  // those the fallback is exact, because nothing was added to derive around.
  const fareLine = booking.fare?.fare ?? round2(sellTotal - seatFees - commercialDelta)

  // How many seats were actually chosen, so a free selection still shows a row.
  const seatCount = (booking.traveler_snapshot?.PassengerDetails ?? [])
    .reduce((n, p) => n + (p.SeatListDetails?.length ?? 0), 0)

  // Base + taxes − discount + fee + seats must equal the total. Tolerance of a
  // paisa absorbs the per-line rounding; anything larger is a real disagreement.
  const reconciles = Math.abs((fareLine + commercialDelta + seatFees) - sellTotal) < 0.01

  return (
    <div style={s.page}>
      <div style={s.root}>
        <div style={s.header}>
          <h1 style={s.heading}>Review & confirm</h1>
          <p style={s.sub}>This is the final step before booking with the airline — check the details below carefully.</p>
        </div>

        {/* ── Policy verdict ───────────────────────────────────────── */}
        {booking.policy_verdict && (
          <div style={{
            ...s.verdictCard,
            background: VERDICT_META[booking.policy_verdict].bg,
            borderColor: VERDICT_META[booking.policy_verdict].border,
          }}>
            <div style={s.verdictHeader}>
              <span style={{ ...s.verdictDot, background: VERDICT_META[booking.policy_verdict].color }} />
              <span style={{ ...s.verdictLabel, color: VERDICT_META[booking.policy_verdict].color }}>
                {VERDICT_META[booking.policy_verdict].label}
              </span>
            </div>
            {(booking.policy_verdict_detail?.breaches?.length ?? 0) > 0 && (
              <ul style={s.verdictList}>
                {booking.policy_verdict_detail!.breaches!.map((b, i) => (
                  <li key={i} style={{ ...s.verdictListItem, color: VERDICT_META[booking.policy_verdict!].color }}>
                    {breachLine(b)}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* ── Flight ───────────────────────────────────────────────── */}
        {booking.itinerary && (
          <div style={s.card}>
            <h2 style={s.cardTitle}>Flight</h2>
            <div style={s.routeRow}>
              <div style={s.routePoint}>
                <span style={s.routeTime}>{formatTime(booking.itinerary.origin?.dateTime)}</span>
                <span style={s.routeCode}>{booking.itinerary.origin?.code}</span>
              </div>
              <div style={s.routeMiddle}>
                <span style={s.routeDuration}>{booking.itinerary.duration ?? ''}</span>
                <div style={s.routeLine} />
                <span style={s.routeStops}>
                  {(booking.itinerary.stopCount ?? 0) === 0 ? 'Non-stop' : `${booking.itinerary.stopCount} stop(s)`}
                </span>
              </div>
              <div style={{ ...s.routePoint, alignItems: 'flex-end' as const }}>
                <span style={s.routeTime}>{formatTime(booking.itinerary.destination?.dateTime)}</span>
                <span style={s.routeCode}>{booking.itinerary.destination?.code}</span>
              </div>
            </div>
            <p style={s.mutedLine}>{booking.itinerary.airline?.name ?? 'Airline'}</p>
          </div>
        )}

        {/* ── Travelers ────────────────────────────────────────────── */}
        {travelers.length > 0 && (
          <div style={s.card}>
            <div style={s.cardTitleRow}>
              <h2 style={s.cardTitle}>
                Travelers {travelerCountParts.length > 0 && (
                  <span style={s.travelerCount}>({travelerCountParts.join(', ')})</span>
                )}
              </h2>
              {/* The Edit link pointed at /book/passengers/edit/[bookingId] —
                  a route that has never existed. With no not-found.tsx under
                  /book it 404'd into the bare root layout, which has no
                  navigation at all, so clicking Edit on a booking awaiting
                  approval stranded the traveller completely.
                  Removed rather than stubbed: editing passenger details after
                  add-passenger has run means changing data the airline already
                  holds, which needs a provider call nobody has specified. A
                  link that does nothing is better than one that breaks, and a
                  link that is absent is better than both. */}
            </div>

            <div style={s.travelerList}>
              {travelers.map((t, i) => {
                const orderedSeats = seatsInLegOrder(t.SeatListDetails)
                return (
                  <div key={i} style={s.travelerRow}>
                    <div>
                      <p style={s.travelerName}>{t.Title} {t.FirstName} {t.LastName}</p>
                      <p style={s.mutedLine}>
                        {PAX_TYPE_LABEL[t.PaxType] ?? t.PaxType}
                        {/* The meal they asked for, checkable before the
                            booking is confirmed rather than discovered in the
                            air. */}
                        {mealLabel(t.MealCode) && <> · {mealLabel(t.MealCode)}</>}
                      </p>
                    </div>
                    {orderedSeats.length > 0 && (
                      <div style={s.seatTags}>
                        {orderedSeats.map((seat, si) => (
                          <span key={si} style={s.seatTag}>
                            {legLabels[si] ? `${legLabels[si].origin}→${legLabels[si].destination} ${seat.SeatDesignator}` : seat.SeatDesignator}
                            {/* The fee was already in the payload and dropped,
                                so "Seat selection ₹1,400" had nothing to
                                itemise it against. */}
                            {Number(seat.SeatFee) > 0 && (
                              <span style={s.seatTagFee}> · {currency} {Number(seat.SeatFee).toLocaleString('en-IN')}</span>
                            )}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>

            <div style={s.contactBlock}>
              {booking.traveler_snapshot?.Email && (
                <p style={s.mutedLine}>{booking.traveler_snapshot.Email}</p>
              )}
              {booking.traveler_snapshot?.Mobile && (
                <p style={s.mutedLine}>{booking.traveler_snapshot.Mobile}</p>
              )}
            </div>
          </div>
        )}

        {/* ── Fare ─────────────────────────────────────────────────── */}
        <div style={s.card}>
          <h2 style={s.cardTitle}>Fare</h2>

          {booking.fare_breakdown?.passengerBreakup && booking.fare_breakdown.passengerBreakup.length > 0 && (
            <div style={s.paxFareList}>
              {booking.fare_breakdown.passengerBreakup.map((pax, i) => (
                <div key={i} style={s.paxFareRow}>
                  <span style={s.paxFareLabel}>
                    {PAX_TYPE_LABEL[pax.PaxType] ?? pax.PaxType}
                    {booking.fare_breakdown!.passengerBreakup!.filter(p => p.PaxType === pax.PaxType).length > 1
                      ? ` ${i + 1}` : ''}
                  </span>
                  <span style={s.paxFareBreakdown}>
                    Base {booking.fare_breakdown?.currency ?? ''} {pax.BaseFare?.toLocaleString('en-IN')}
                    {' + Tax '}{booking.fare_breakdown?.currency ?? ''} {pax.Tax?.toLocaleString('en-IN')}
                  </span>
                  <span style={s.paxFareValue}>
                    {booking.fare_breakdown?.currency ?? ''} {pax.TotalFare?.toLocaleString('en-IN')}
                  </span>
                </div>
              ))}
              <div style={s.fareDivider} />
            </div>
          )}

          {/* Base and taxes as the TRAVELLER's numbers. The markup rides inside
              base, so base + taxes is exactly the Fare line below — and there is
              no airline figure anywhere on this page to subtract it out of.
              Absent on bookings made before commercial rules existed, which have
              no frozen components to derive them from. */}
          {booking.fare && (
            <>
              <div style={s.fareRow}>
                <span style={s.fareLabel}>Base fare</span>
                <span style={s.fareValue}>{currency} {booking.fare.base.toLocaleString('en-IN')}</span>
              </div>
              <div style={s.fareRow}>
                <button
                  type="button"
                  onClick={() => setTaxesOpen(o => !o)}
                  style={s.fareDisclosure}
                  aria-expanded={taxesOpen}
                >
                  Taxes &amp; surcharges <span style={s.fareChevron}>{taxesOpen ? '▴' : '▾'}</span>
                </button>
                <span style={s.fareValue}>{currency} {(booking.fare.taxTotal ?? 0).toLocaleString('en-IN')}</span>
              </div>
              {/* Behind a disclosure: a traveller wants one tax number, a finance
                  team wants the codes. The codes are the airline's own — YQ the
                  fuel surcharge, K3 the Indian GST on air travel — and say
                  nothing about what we added, because base already carries it. */}
              {taxesOpen && (booking.fare.taxLines ?? []).map(tax => (
                <div key={tax.code} style={s.fareSubRow}>
                  <span style={s.fareSubLabel}>{TAX_LABELS[tax.code] ?? tax.code}</span>
                  <span style={s.fareSubValue}>{currency} {tax.amount.toLocaleString('en-IN')}</span>
                </div>
              ))}
            </>
          )}

          <div style={{ ...s.fareRow, ...s.fareRowSubtotal }}>
            <span style={s.fareLabel}>Fare</span>
            <span style={s.fareValue}>{currency} {fareLine.toLocaleString('en-IN')}</span>
          </div>

          {/* Discount and processing fee. The server sends only the lines a
              traveller may see. Both appear here — this card is the complete
              record of what was bought, and a breakdown missing a component
              cannot be reconciled against the amount charged, which is the one
              job it has. */}
          {(booking.commercial_lines ?? []).map(line => (
            <div key={line.source} style={s.fareRow}>
              <span style={s.fareLabel}>{line.label}</span>
              <span style={{ ...s.fareValue, ...(line.sign === -1 ? s.fareCredit : {}) }}>
                {line.sign === -1 ? '− ' : '+ '}
                {currency} {line.amount.toLocaleString('en-IN')}
              </span>
            </div>
          ))}

          {/* Rendered whenever seats were chosen, including when they were free.
              This was `!!seatFees`, so a booking with free seat selections showed
              no seat line at all — indistinguishable from having chosen none. */}
          {seatCount > 0 && (
            <div style={s.fareRow}>
              <span style={s.fareLabel}>
                Seat selection
                <span style={s.fareLabelAside}> · {seatCount} seat{seatCount === 1 ? '' : 's'}</span>
              </span>
              <span style={s.fareValue}>
                {seatFees > 0 ? `${currency} ${seatFees.toLocaleString('en-IN')}` : 'Included'}
              </span>
            </div>
          )}

          <div style={{ ...s.fareRow, ...s.fareRowTotal }}>
            <span style={s.fareTotalLabel}>Total</span>
            <span style={s.fareTotalValue}>{currency} {sellTotal.toLocaleString('en-IN')}</span>
          </div>

          {/* The parts are supposed to sum to the total. If they do not, say so
              rather than printing a total that quietly disagrees with the
              breakdown above it — a number nobody can reconcile is worse than a
              visible discrepancy, because only one of the two gets questioned. */}
          {!reconciles && (
            <p style={s.fareMismatch}>
              This breakdown does not add up to the total charged. Please contact your travel
              desk before relying on it.
            </p>
          )}
          {booking.fare_breakdown && (
            <div style={s.metaTags}>
              <span style={{ ...s.tag, color: booking.fare_breakdown.isRefundable ? '#065F46' : '#9CA3AF', background: booking.fare_breakdown.isRefundable ? '#ECFDF5' : '#F3F4F6' }}>
                {booking.fare_breakdown.isRefundable ? 'Refundable' : 'Non-refundable'}
              </span>
              {booking.fare_breakdown.fareType && <span style={s.tag}>{booking.fare_breakdown.fareType}</span>}
            </div>
          )}
        </div>

        {error && (
          <div style={s.errorBanner}>
            <span style={s.bannerIcon}>⚠</span> {error}
          </div>
        )}

        {errorCode === 'SEARCH_EXPIRED' && (
          <button
            type="button"
            onClick={() => router.push('/book/flights')}
            style={s.confirmBtn}
          >
            Search again →
          </button>
        )}

        {/* ── Action area — depends on approval status ────────────────── */}
        {booking.status === 'pending_approval' && (
          <>
            <div style={s.waitingCard}>
              <div style={s.spinnerSmall} />
              <div>
                <p style={s.waitingTitle}>
                  Waiting for approval{latestApproval?.approverName ? ` from ${latestApproval.approverName}` : ''}
                </p>
                <p style={s.waitingSub}>
                  You'll be able to confirm this booking with the airline as soon as it's approved. This page updates automatically, or check back from your dashboard any time.
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => router.replace('/dashboard')}
              style={s.dashboardBtn}
            >
              Go back to dashboard
            </button>
          </>
        )}

        {booking.status === 'rejected' && (
          <div style={s.rejectedCard}>
            <p style={s.rejectedTitle}>This booking was rejected</p>
            {latestApproval?.decision_note && (
              <p style={s.rejectedNote}>“{latestApproval.decision_note}”</p>
            )}
            <p style={s.waitingSub}>
              Contact your manager or TMC if you have questions, or start a new search to try again.
            </p>
            {/* Each of the three terminal cards below invited the traveller to
                do something — "start a new search", "contact your TMC" — and
                then offered no way to do it. All three were rendered with no
                link and no button at all, so the only exit was a browser back
                that is intercepted on this page and silently replaces to the
                dashboard. Saying "start a new search" without a search link is
                the part that made them dead ends. */}
            <TerminalExits />
          </div>
        )}

        {booking.status === 'approval_misconfigured' && (
          <div style={s.rejectedCard}>
            <p style={s.rejectedTitle}>Approval routing isn't set up correctly</p>
            <p style={s.waitingSub}>
              This booking needs approval but we couldn't find who should approve it (e.g. no manager is assigned to you yet). Contact your TMC or corporate admin.
            </p>
            <TerminalExits />
          </div>
        )}

        {booking.status === 'failed' && errorCode !== 'SEARCH_EXPIRED' && (
          <div style={s.rejectedCard}>
            <p style={s.rejectedTitle}>This booking couldn't be completed</p>
            <p style={s.waitingSub}>
              Something went wrong confirming this with the airline. Contact your TMC or corporate admin if this keeps happening.
            </p>
            <TerminalExits />
          </div>
        )}

        {booking.status === 'approved' && (
          <>
            {latestApproval?.decision_note && (
              <div style={s.approverNoteCard}>
                <p style={s.approverNoteLabel}>
                  Note from {latestApproval.approverName ?? 'your approver'}
                </p>
                <p style={s.approverNoteText}>“{latestApproval.decision_note}”</p>
              </div>
            )}
            <div style={s.noticeCard}>
              <p style={s.noticeText}>
                Clicking below will confirm this booking directly with the airline. This step typically can't be undone —
                double-check the traveler's name and dates match their passport exactly.
              </p>
            </div>
            <button
              type="button"
              onClick={handleConfirmBooking}
              disabled={confirming}
              style={{ ...s.confirmBtn, opacity: confirming ? 0.7 : 1 }}
            >
              {confirming ? 'Booking…' : 'Confirm booking →'}
            </button>
          </>
        )}
      </div>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  page: { background: '#F9FAFB', minHeight: '100vh' },
  root: { fontFamily: "'Inter', -apple-system, sans-serif", maxWidth: '640px', margin: '0 auto', padding: '32px 24px 64px' },

  header: { marginBottom: '20px' },
  heading: { fontSize: '22px', fontWeight: 700, color: '#0A0A14', margin: '0 0 6px', letterSpacing: '-0.4px' },
  sub: { fontSize: '13px', color: '#6B7280', margin: 0, lineHeight: 1.5 },

  loadingCard: { display: 'flex', justifyContent: 'center', padding: '80px 0' },
  spinner: { width: '22px', height: '22px', border: '2.5px solid #E5E7EB', borderTopColor: '#000835', borderRadius: '50%', animation: 'spin 0.7s linear infinite' },

  errorCard: { padding: '20px', background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: '14px' },
  errorTitle: { fontSize: '13px', color: '#DC2626', margin: '0 0 10px', lineHeight: 1.5 },
  errorLink: { fontSize: '13px', color: '#DC2626', fontWeight: 600, textDecoration: 'underline' },

  verdictCard: { border: '1px solid', borderRadius: '14px', padding: '16px', marginBottom: '16px' },
  verdictHeader: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' },
  verdictDot: { width: '9px', height: '9px', borderRadius: '50%', flexShrink: 0 },
  verdictLabel: { fontSize: '13px', fontWeight: 700 },
  verdictList: { margin: '8px 0 0', paddingLeft: '18px', display: 'flex', flexDirection: 'column' as const, gap: '4px' },
  verdictListItem: { fontSize: '12px', lineHeight: 1.5 },

  card: { background: '#fff', border: '1px solid #E5E7EB', borderRadius: '14px', padding: '20px', marginBottom: '16px' },
  cardTitle: { fontSize: '14px', fontWeight: 600, color: '#111827', margin: 0 },
  cardTitleRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px' },
  travelerCount: { fontSize: '12px', fontWeight: 500, color: '#9CA3AF' },
  editLink: { fontSize: '12px', fontWeight: 600, color: '#000835', textDecoration: 'none' },

  travelerList: { display: 'flex', flexDirection: 'column', gap: '10px', marginBottom: '12px' },
  travelerRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '10px', paddingBottom: '10px', borderBottom: '1px solid #F3F4F6' },
  seatTags: { display: 'flex', flexWrap: 'wrap' as const, gap: '5px', flexShrink: 0 },
  seatTag: { fontSize: '10.5px', fontWeight: 600, color: '#000835', background: '#EEF2FF', padding: '3px 9px', borderRadius: '6px' },
  contactBlock: { display: 'flex', flexDirection: 'column', gap: '2px' },

  paxFareList: { display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '12px' },
  paxFareRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px' },
  paxFareLabel: { fontSize: '12px', fontWeight: 600, color: '#374151', minWidth: '64px' },
  paxFareBreakdown: { fontSize: '11px', color: '#9CA3AF', flex: 1 },
  paxFareValue: { fontSize: '12px', fontWeight: 600, color: '#111827' },
  fareDivider: { height: '1px', background: '#F3F4F6', margin: '2px 0 0' },

  routeRow: { display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '10px' },
  routePoint: { display: 'flex', flexDirection: 'column', gap: '2px', flex: '0 0 auto', minWidth: '58px' },
  routeTime: { fontSize: '16px', fontWeight: 700, color: '#111827' },
  routeCode: { fontSize: '11px', fontWeight: 600, color: '#6B7280' },
  routeMiddle: { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px' },
  routeDuration: { fontSize: '10px', color: '#9CA3AF', fontWeight: 500 },
  routeLine: { width: '100%', height: '1px', background: '#D1D5DB' },
  routeStops: { fontSize: '10px', color: '#9CA3AF' },
  mutedLine: { fontSize: '12px', color: '#9CA3AF', margin: 0 },

  travelerName: { fontSize: '14px', fontWeight: 600, color: '#111827', margin: '0 0 4px' },

  fareRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' },
  fareLabel: { fontSize: '13px', color: '#6B7280' },
  fareValue: { fontSize: '16px', fontWeight: 700, color: '#0A0A14' },
  // A reduction reads green, so a discount is legible as a benefit rather than
  // as one more number in a column.
  fareCredit: { color: '#166534' },
  // Base + taxes rule off into the Fare line; Fare ± adjustments rule off into
  // the Total. Two weights of rule, so the two stages of the sum read as stages.
  fareRowSubtotal: { borderTop: '1px solid #F3F4F6', paddingTop: '10px' },
  fareRowTotal: { borderTop: '1.5px solid #111827', paddingTop: '10px', marginTop: '2px' },
  fareTotalLabel: { fontSize: '13px', fontWeight: 600, color: '#111827' },
  fareTotalValue: { fontSize: '18px', fontWeight: 700, color: '#0A0A14' },
  fareLabelAside: { color: '#9CA3AF' },
  seatTagFee: { color: '#6B7280', fontWeight: 400 },
  fareDisclosure: {
    fontSize: '13px', color: '#6B7280', background: 'none', border: 'none',
    padding: 0, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '4px',
  },
  fareChevron: { fontSize: '9px', color: '#9CA3AF' },
  fareSubRow: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    marginBottom: '6px', paddingLeft: '12px',
  },
  fareSubLabel: { fontSize: '11.5px', color: '#9CA3AF' },
  fareSubValue: { fontSize: '11.5px', color: '#6B7280', fontVariantNumeric: 'tabular-nums' },
  fareMismatch: {
    fontSize: '12px', color: '#991B1B', background: '#FEF2F2',
    border: '1px solid #FECACA', borderRadius: '8px', padding: '10px 12px', margin: '12px 0 0',
    lineHeight: 1.5,
  },
  metaTags: { display: 'flex', gap: '6px' },
  tag: { fontSize: '10px', color: '#6B7280', background: '#F3F4F6', padding: '3px 9px', borderRadius: '5px', fontWeight: 500 },

  approverNoteCard: { background: '#EFF6FF', border: '1px solid #BFDBFE', borderRadius: '12px', padding: '14px 16px', marginBottom: '16px' },
  approverNoteLabel: { fontSize: '11.5px', fontWeight: 700, color: '#1D4ED8', margin: '0 0 4px', textTransform: 'uppercase' as const, letterSpacing: '0.4px' },
  approverNoteText: { fontSize: '13.5px', color: '#1E3A8A', margin: 0, lineHeight: 1.5, fontStyle: 'italic' as const },
  noticeCard: { background: '#FFFBEB', border: '1px solid #FDE68A', borderRadius: '12px', padding: '14px 16px', marginBottom: '16px' },
  noticeText: { fontSize: '12px', color: '#92400E', margin: 0, lineHeight: 1.5 },

  errorBanner: { display: 'flex', alignItems: 'center', gap: '8px', background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: '10px', padding: '11px 14px', fontSize: '13px', color: '#DC2626', marginBottom: '16px' },
  bannerIcon: { fontSize: '14px' },

  waitingCard: { display: 'flex', alignItems: 'flex-start', gap: '12px', background: '#F9FAFB', border: '1px solid #E5E7EB', borderRadius: '14px', padding: '18px 16px', marginBottom: '16px' },
  waitingTitle: { fontSize: '14px', fontWeight: 700, color: '#111827', margin: '0 0 4px' },
  waitingSub: { fontSize: '12px', color: '#6B7280', margin: 0, lineHeight: 1.5 },
  spinnerSmall: { width: '18px', height: '18px', border: '2.5px solid #E5E7EB', borderTopColor: '#000835', borderRadius: '50%', flexShrink: 0, marginTop: '2px', animation: 'spin 0.7s linear infinite' },

  rejectedCard: { background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: '14px', padding: '16px', marginBottom: '16px' },
  terminalExits: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px 16px', marginTop: '14px' },
  terminalExitPrimary: { fontSize: '12.5px', fontWeight: 600, color: '#991B1B', textDecoration: 'none' },
  terminalExit: { fontSize: '12.5px', color: '#6B7280', textDecoration: 'none' },
  rejectedTitle: { fontSize: '14px', fontWeight: 700, color: '#991B1B', margin: '0 0 6px' },
  rejectedNote: { fontSize: '12px', color: '#991B1B', margin: '0 0 8px', lineHeight: 1.5, fontStyle: 'italic' },

  confirmBtn: {
    height: '48px', width: '100%', background: '#000835', color: '#fff', fontSize: '14px', fontWeight: 700,
    border: 'none', borderRadius: '10px', cursor: 'pointer', letterSpacing: '0.2px',
  },
  dashboardBtn: {
    height: '48px', width: '100%', background: '#fff', color: '#000835', fontSize: '14px', fontWeight: 700,
    border: '1.5px solid #000835', borderRadius: '10px', cursor: 'pointer', letterSpacing: '0.2px',
  },
}