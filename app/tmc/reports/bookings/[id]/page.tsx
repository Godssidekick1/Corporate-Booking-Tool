'use client'

import { useEffect, useState } from 'react'
import type React from 'react'
import { SkeletonHeader, SkeletonRecord } from '@/app/components/Skeleton'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import AirlineMark from '@/app/components/AirlineMark'
import FareRulesPanel from '@/app/components/book/FareRulesPanel'
import type { FareRules } from '@/app/lib/book/fareRules'
import { VERDICT_META } from '@/app/lib/policy/verdictLabels'
import { s, money, dateOnly, dateTime } from '@/app/tmc/configurations/cancellation-queues/ui'

// ── /tmc/reports/bookings/[id] ───────────────────────────────────────────────
// One booking, all of it, for the TMC: opened from the Bookings report (and
// the desk's own bookings table). What it earned, line by line, with the rule
// behind each adjustment; what was stamped on it; how policy judged it and
// who approved it; the tickets, cancellation and refunds; and every recorded
// step. Read-only: acting on a booking stays on its own pages.
// ─────────────────────────────────────────────────────────────────────────────

interface Journey {
  journeyNo?: number
  origin?: { code?: string; city?: string; dateTime?: string }
  destination?: { code?: string; city?: string; dateTime?: string }
  stopCount?: number
  legs?: { airlineCode?: string; flightNumber?: string; bookingCode?: string; cabin?: string }[]
}
interface Itinerary extends Journey {
  journeys?: Journey[]
  airline?: { code?: string; name?: string }
  cabin?: string
}
interface Adjustment {
  source: string; label: string; sign: -1 | 1; amount: number; visibility: string
  rule: { id: string; airline: string | null; active: boolean | null } | null
  via: string | null; calcType: string | null; calcOn: string | null; rate: number | null
  calcBasis: string | null; pax: number | null; sectors: number | null
}
interface DeskBooking {
  id: string
  status: string
  createdAt: string
  updatedAt: string
  purpose: string | null
  forGuest: boolean | null
  client: { id: string; name: string | null }
  traveller: { id: string; name: string | null; email: string | null; band: string | null }
  bookedBy: { kind: 'self' | 'desk' | 'colleague'; name: string | null }
  confirmedBy: string | null
  trip: { id: string; name: string | null } | null
  references: { pnr: string | null; airlinePnr: string | null; providerReference: string | null; provider: string | null; ticketNumbers: (string | null)[] }
  itinerary: Itinerary | null
  passengers: { FirstName?: string; LastName?: string; Title?: string; PaxType?: string }[]
  contact: { email: string | null; mobile: string | null } | null
  fare: { currency?: string; isRefundable?: boolean; fareType?: string; seatFees?: number } | null
  money: {
    airlineTotal: number | null
    sellTotal: number | null
    airline: { total: number; base: number; otherTax: number; fuelSurcharge: number; taxLines: { code: string; amount: number }[] } | null
    adjustments: Adjustment[]
    desk: { airlineTotal: number; markup: number; discount: number; fee: number; sellTotal: number; margin: number } | null
    ambiguous: boolean
  }
  dealCodes: unknown
  formOfPayment: unknown
  fareRules: FareRules | null
  policy: { status: string | null; verdict: string | null; breaches: unknown[]; reason: string | null; reasonCode: string | null; reasonNote: string | null }
  approvals: { id: string; tier: number; status: string; verdict: string | null; reason: string | null; approver: string | null; note: string | null; askedAt: string; decidedAt: string | null }[]
  approvalOnPair: boolean
  cancellation: { at: string; by: string | null; reason: string | null; provider: unknown } | null
  refunds: { id: string; passengerIndex: number; ticketNumber: string | null; status: string; refundAmount: number | null; tmcKept: number | null; creditNote: string | null; processedAt: string | null; rejectedReason: string | null }[]
  pair: { id: string; status: string; pnr: string | null; direction: 'onward' | 'return' }[]
  audit: { id: string; action: string; at: string; by: string | null; metadata: Record<string, unknown> }[]
}

const STATUS_LABEL: Record<string, string> = {
  ticketed: 'Ticketed', held: 'Confirmed', approved: 'Approved, not booked', pending_approval: 'Awaiting approval',
  cancelled: 'Cancelled', cancel_requested: 'Cancelling', rejected: 'Rejected', failed: 'Failed',
  approval_misconfigured: 'Approval not set up',
}
const STEP_LABEL: Record<string, string> = {
  pending: 'Waiting', approved: 'Approved', rejected: 'Rejected', withdrawn: 'Withdrawn',
  superseded: 'No longer needed', escalated: 'Escalated',
}
const BOOKED_BY: Record<string, string> = { self: 'The traveller', desk: 'The travel desk', colleague: 'A colleague' }
const clock = (iso?: string) => /T(\d{2}:\d{2})/.exec(iso ?? '')?.[1] ?? ''
// "booking.desk_override" -> "Desk override"
const actionLabel = (a: string) => {
  const last = a.split('.').pop() ?? a
  return last.charAt(0).toUpperCase() + last.slice(1).replace(/_/g, ' ')
}

// How an adjustment was worked out, in a line.
function howWorked(a: Adjustment): string {
  const parts: string[] = []
  if (a.calcType === 'percent' && a.rate !== null) parts.push(`${a.rate}%${a.calcOn ? ` of ${a.calcOn.replace(/_/g, ' + ').toUpperCase()}` : ''}`)
  if (a.calcType === 'fixed' && a.rate !== null) parts.push(`${money(a.rate)} fixed`)
  if (a.calcBasis === 'per_sector' && a.sectors) parts.push(`× ${a.sectors} sector${a.sectors === 1 ? '' : 's'}`)
  if (a.pax && a.pax > 1) parts.push(`× ${a.pax} passengers`)
  return parts.join(' ')
}

// A stamped deal code or form of payment, shown as plain lines whatever its shape.
function describe(value: unknown): string[] {
  if (!value) return []
  const list = Array.isArray(value) ? value : [value]
  return list.map(item => {
    if (!item || typeof item !== 'object') return String(item)
    const o = item as Record<string, unknown>
    const name = o.label ?? o.code ?? o.name ?? o.fopCode ?? o.dealCode
    const extra = [o.airlineCode ?? o.airline, o.type ?? o.payer, o.via].filter(Boolean).join(' · ')
    return [name, extra].filter(Boolean).join(' · ') || JSON.stringify(o)
  })
}

export default function DeskBookingPage() {
  const { id } = useParams<{ id: string }>()
  const [booking, setBooking] = useState<DeskBooking | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let live = true
    fetch(`/api/tmc/bookings/${id}`)
      .then(async r => ({ ok: r.ok, body: await r.json().catch(() => ({})) }))
      .then(({ ok, body }) => {
        if (!live) return
        if (!ok) { setError(body.error ?? 'This booking could not be loaded.'); return }
        setBooking(body.booking)
      })
      .catch(() => { if (live) setError('This booking could not be loaded. Check your connection and try again.') })
    return () => { live = false }
  }, [id])

  const back = <Link href="/tmc/reports?report=bookings" style={s.linkBtn}>← Bookings report</Link>
  if (error) return <main className="page-frame">{back}<p style={{ ...s.errorBanner, marginTop: 12 }}>{error}</p></main>
  if (!booking) return <main className="page-frame">{back}<div style={{ marginTop: 16 }}><SkeletonHeader /><SkeletonRecord /></div></main>

  const it = booking.itinerary
  const journeys: Journey[] = it?.journeys?.length ? it.journeys : it ? [it] : []
  const code = (it?.airline?.code ?? it?.legs?.[0]?.airlineCode ?? '').toUpperCase()
  const m = booking.money
  const verdictMeta = booking.policy.verdict ? VERDICT_META[booking.policy.verdict] : null
  const tickets = booking.references.ticketNumbers.filter(Boolean)

  return (
    <main className="page-frame">
      {back}

      {/* ── Who and what ───────────────────────────────────────────── */}
      <header style={{ ...s.header, marginTop: 12 }}>
        <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
          <AirlineMark code={code} name={it?.airline?.name} size={40} />
          <div>
            <h1 style={s.title}>
              {journeys[0]?.origin?.code} {journeys.length > 1 ? '⇄' : '→'} {journeys[0]?.destination?.code}
              {' · '}{booking.traveller.name ?? 'Traveller'}
            </h1>
            <p style={s.sub}>
              {booking.client.name} · booked {dateTime(booking.createdAt)} by {BOOKED_BY[booking.bookedBy.kind]}
              {booking.bookedBy.kind !== 'self' && booking.bookedBy.name ? ` (${booking.bookedBy.name})` : ''}
              {booking.purpose === 'personal' ? ' · personal trip' : ''}{booking.forGuest ? ' · for a guest' : ''}
            </p>
          </div>
        </div>
        <span style={{ ...s.pill, ...pillFor(booking.status) }}>{STATUS_LABEL[booking.status] ?? booking.status}</span>
      </header>

      <div style={grid}>
        <section style={card}>
          <h2 style={h2}>References</h2>
          <Facts rows={[
            ['PNR', booking.references.pnr],
            ['Airline PNR', booking.references.airlinePnr],
            ['Provider reference', booking.references.providerReference],
            ['Tickets', tickets.length ? tickets.join(', ') : null],
            ['Confirmed by', booking.confirmedBy],
            ['Trip', booking.trip ? booking.trip.name ?? 'Unnamed trip' : null],
          ]} />
        </section>
        <section style={card}>
          <h2 style={h2}>Traveller</h2>
          <Facts rows={[
            ['Name', booking.traveller.name],
            ['Email', booking.traveller.email],
            ['Band', booking.traveller.band],
            ['Contact on the booking', [booking.contact?.email, booking.contact?.mobile].filter(Boolean).join(' · ') || null],
          ]} />
        </section>
      </div>

      {/* ── The flights and passengers ─────────────────────────────── */}
      <section style={card}>
        <h2 style={h2}>Itinerary</h2>
        {journeys.map((j, i) => (
          <div key={i} style={row}>
            <span style={label}>{journeys.length > 1 ? (i === 0 ? 'Outbound' : 'Return') : 'Flight'}</span>
            <span style={{ fontVariantNumeric: 'tabular-nums' }}>
              {j.origin?.code} {dateOnly(j.origin?.dateTime?.slice(0, 10))} {clock(j.origin?.dateTime)} → {j.destination?.code} {clock(j.destination?.dateTime)}
              {' · '}{(j.legs ?? []).map(l => `${l.airlineCode ?? ''} ${l.flightNumber ?? ''}${l.bookingCode ? ` (${l.bookingCode})` : ''}`.trim()).join(', ')}
              {' · '}{(j.stopCount ?? 0) === 0 ? 'non-stop' : `${j.stopCount} stop${(j.stopCount ?? 0) > 1 ? 's' : ''}`}
            </span>
          </div>
        ))}
        <div style={row}>
          <span style={label}>Passengers</span>
          <span>{booking.passengers.map(p => [p.Title, p.FirstName, p.LastName].filter(Boolean).join(' ') + (p.PaxType && p.PaxType !== 'ADT' ? ` (${p.PaxType})` : '')).join(', ') || '—'}</span>
        </div>
        <div style={row}>
          <span style={label}>Fare</span>
          <span>{booking.fare?.fareType ?? '—'} · {booking.fare?.isRefundable ? 'refundable' : 'non-refundable'}{it?.cabin ? ` · ${it.cabin}` : ''}</span>
        </div>
        {booking.pair.length > 1 && (
          <div style={row}>
            <span style={label}>Round trip</span>
            <span>
              {booking.pair.filter(p => p.id !== booking.id).map(p => (
                <Link key={p.id} href={`/tmc/reports/bookings/${p.id}`} style={s.linkBtn}>
                  The {p.direction} flight ({STATUS_LABEL[p.status] ?? p.status}{p.pnr ? `, PNR ${p.pnr}` : ''})
                </Link>
              ))}
              {' '}is its other booking.
            </span>
          </div>
        )}
      </section>

      {/* ── The money ──────────────────────────────────────────────── */}
      <section style={card}>
        <h2 style={h2}>What it earned</h2>
        {!m.airline ? (
          <p style={s.hint}>This booking was made before commercials were recorded: the client paid {money(m.sellTotal)}, the airline&apos;s fare.</p>
        ) : (
          <>
            <div style={statement}>
              <Line label="Airline base fare" value={m.airline.base} />
              {m.airline.taxLines.map(t => <Line key={t.code} label={`Tax ${t.code}`} value={t.amount} sub />)}
              {m.airline.taxLines.length === 0 && <Line label="Taxes" value={m.airline.otherTax} sub />}
              <Line label="Airline fare" value={m.airline.total} strong />
              {m.adjustments.map((a, i) => (
                <div key={i}>
                  <Line label={a.label} value={a.sign * a.amount} signed
                    note={a.visibility === 'embedded' ? 'inside the fare the client sees' : a.visibility === 'line' ? 'a line the client sees' : undefined} />
                  <p style={adjustNote}>
                    {[howWorked(a), a.via ? `reached the client by ${a.via}` : null,
                      a.rule ? `rule for ${a.rule.airline ?? 'all airlines'}${a.rule.active === false ? ', since switched off' : ''}` : null]
                      .filter(Boolean).join(' · ')}
                  </p>
                </div>
              ))}
              {(booking.fare?.seatFees ?? 0) > 0 && <Line label="Seat fees (to the airline, not marked up)" value={booking.fare?.seatFees ?? 0} />}
              <Line label="The client pays" value={m.sellTotal ?? 0} strong />
            </div>
            {m.desk && (
              <div style={marginBox}>
                <span>Margin <small style={{ color: '#6B7280' }}>(markup + fee − discount)</small></span>
                <b style={{ color: m.desk.margin < 0 ? '#B91C1C' : '#065F46' }}>{money(m.desk.margin)}</b>
              </div>
            )}
            {m.ambiguous && <p style={s.warnBanner}>Two rules could not be told apart when this was priced: check the commercial rules for this client.</p>}
          </>
        )}
      </section>

      <div style={grid}>
        <section style={card}>
          <h2 style={h2}>Deal codes</h2>
          {describe(booking.dealCodes).length ? <ul style={list}>{describe(booking.dealCodes).map((d, i) => <li key={i}>{d}</li>)}</ul>
            : <p style={s.hint}>None applied.</p>}
        </section>
        <section style={card}>
          <h2 style={h2}>Form of payment</h2>
          {describe(booking.formOfPayment).length ? <ul style={list}>{describe(booking.formOfPayment).map((d, i) => <li key={i}>{d}</li>)}</ul>
            : <p style={s.hint}>None resolved.</p>}
        </section>
      </div>

      {/* ── The airline's fare rules: what a cancellation or change costs ── */}
      {booking.fareRules
        ? <FareRulesPanel rules={booking.fareRules} showDealCode title="Fare rules (airline)" />
        : (
          <section style={card}>
            <h2 style={h2}>Fare rules (airline)</h2>
            <p style={s.hint}>None stored: booked before fare rules were fetched, or the airline sent none.</p>
          </section>
        )}

      {/* ── Policy and approval ────────────────────────────────────── */}
      <section style={card}>
        <h2 style={h2}>Policy</h2>
        {booking.policy.status !== 'evaluated' || !verdictMeta ? (
          <p style={s.hint}>Not checked against policy{booking.purpose === 'personal' ? ' (a personal trip)' : ''}.</p>
        ) : (
          <>
            <span style={{ ...s.pill, color: verdictMeta.color, background: verdictMeta.bg }}>{verdictMeta.label}</span>
            {booking.policy.reason && booking.policy.verdict !== 'green' && <p style={{ ...s.hint, marginTop: 8 }}>{booking.policy.reason}</p>}
            {booking.policy.reasonCode && (
              <p style={{ ...s.hint, marginTop: 6 }}>Reason given: {booking.policy.reasonCode.replace(/_/g, ' ')}{booking.policy.reasonNote ? ` (${booking.policy.reasonNote})` : ''}</p>
            )}
          </>
        )}
      </section>

      <section style={card}>
        <h2 style={h2}>Approval</h2>
        {booking.approvalOnPair && <p style={s.hint}>A round trip: one approval covers both bookings, raised on the onward flight.</p>}
        {booking.approvals.length === 0 ? <p style={s.hint}>No approval was asked for.</p> : (
          <div style={s.tableWrap}>
            <table style={s.table}>
              <thead><tr>{['Step', 'Asked of', 'Asked', 'Decision', 'Decided', 'Note'].map(h => <th key={h} style={s.th}>{h}</th>)}</tr></thead>
              <tbody>
                {booking.approvals.map(a => (
                  <tr key={a.id} style={s.tr}>
                    <td style={s.td}>{a.tier}</td>
                    <td style={s.td}>{a.approver ?? '—'}</td>
                    <td style={s.td}>{dateTime(a.askedAt)}</td>
                    <td style={s.td}>{STEP_LABEL[a.status] ?? a.status}</td>
                    <td style={s.td}>{dateTime(a.decidedAt)}</td>
                    <td style={{ ...s.td, whiteSpace: 'normal' }}>{a.note ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ── Cancellation and refunds ───────────────────────────────── */}
      {(booking.cancellation || booking.refunds.length > 0) && (
        <section style={card}>
          <h2 style={h2}>Cancellation and refunds</h2>
          {booking.cancellation && (
            <Facts rows={[
              ['Cancelled', dateTime(booking.cancellation.at)],
              ['By', booking.cancellation.by],
              ['Reason', booking.cancellation.reason],
            ]} />
          )}
          {booking.refunds.length > 0 && (
            <div style={{ ...s.tableWrap, marginTop: 10 }}>
              <table style={s.table}>
                <thead><tr>{['Ticket', 'Status', 'Refunded', 'TMC kept', 'Credit note', ''].map(h => <th key={h} style={s.th}>{h}</th>)}</tr></thead>
                <tbody>
                  {booking.refunds.map(r => (
                    <tr key={r.id} style={s.tr}>
                      <td style={{ ...s.td, ...s.mono }}>{r.ticketNumber ?? `Passenger ${r.passengerIndex + 1}`}</td>
                      <td style={s.td}>{r.status === 'processed' ? 'Refunded' : r.status === 'rejected' ? `Declined${r.rejectedReason ? `: ${r.rejectedReason}` : ''}` : 'Pending'}</td>
                      <td style={{ ...s.td, ...s.num }}>{money(r.refundAmount)}</td>
                      <td style={{ ...s.td, ...s.num }}>{money(r.tmcKept)}</td>
                      <td style={{ ...s.td, ...s.mono }}>{r.creditNote ?? '—'}</td>
                      <td style={s.td}><Link href={`/tmc/configurations/cancellation-queues/${r.id}`} style={s.linkBtn}>Open refund</Link></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {/* ── Every recorded step ────────────────────────────────────── */}
      <section style={card}>
        <h2 style={h2}>Activity</h2>
        {booking.audit.length === 0 ? <p style={s.hint}>Nothing recorded beyond the booking itself.</p> : (
          <ul style={list}>
            {booking.audit.map(a => (
              <li key={a.id}>
                <b>{actionLabel(a.action)}</b> · {dateTime(a.at)}{a.by ? ` · ${a.by}` : ''}
                {typeof a.metadata?.reason === 'string' && a.metadata.reason ? ` · “${a.metadata.reason}”` : ''}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  )
}

function pillFor(status: string): React.CSSProperties {
  if (status === 'ticketed' || status === 'held') return { color: '#166534', background: '#DCFCE7' }
  if (status === 'pending_approval' || status === 'approved') return { color: '#1E40AF', background: '#DBEAFE' }
  if (status === 'cancelled' || status === 'rejected' || status === 'failed') return { color: '#991B1B', background: '#FEE2E2' }
  return { color: '#374151', background: '#F3F4F6' }
}

function Facts({ rows }: { rows: [string, string | null | undefined][] }) {
  return (
    <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: 'minmax(120px, auto) 1fr', gap: '6px 14px', fontSize: 13 }}>
      {rows.map(([k, v]) => (
        <div key={k} style={{ display: 'contents' }}>
          <dt style={{ color: '#6B7280' }}>{k}</dt>
          <dd style={{ margin: 0, color: '#111827', overflowWrap: 'anywhere' }}>{v || '—'}</dd>
        </div>
      ))}
    </dl>
  )
}

function Line({ label, value, strong, sub, signed, note }: { label: string; value: number; strong?: boolean; sub?: boolean; signed?: boolean; note?: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: sub ? 12 : 13, color: sub ? '#6B7280' : '#111827',
      fontWeight: strong ? 700 : 400, padding: sub ? '1px 0 1px 14px' : '4px 0', borderTop: strong ? '1px solid #E5E7EB' : undefined, marginTop: strong ? 4 : 0 }}>
      <span>{label}{note && <small style={{ color: '#9CA3AF', marginLeft: 6 }}>{note}</small>}</span>
      <span style={{ fontVariantNumeric: 'tabular-nums' }}>{signed && value > 0 ? '+' : ''}{money(value)}</span>
    </div>
  )
}

const card: React.CSSProperties = { background: '#fff', border: '1px solid var(--color-line)', borderRadius: 10, padding: '14px 16px', marginBottom: 14, minWidth: 0 }
const grid: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 14 }
const h2: React.CSSProperties = { fontSize: 12, fontWeight: 700, color: '#111827', textTransform: 'uppercase', letterSpacing: '0.5px', margin: '0 0 10px' }
const row: React.CSSProperties = { display: 'grid', gridTemplateColumns: '110px minmax(0, 1fr)', gap: 12, fontSize: 13, color: '#111827', padding: '5px 0', borderTop: '1px solid #F3F4F6' }
const label: React.CSSProperties = { fontSize: 11, fontWeight: 700, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.4px', paddingTop: 2 }
const statement: React.CSSProperties = { maxWidth: 560 }
const adjustNote: React.CSSProperties = { fontSize: 11.5, color: '#9CA3AF', margin: '-2px 0 4px' }
const marginBox: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', maxWidth: 560, marginTop: 10, padding: '10px 12px', background: '#F9FAFB', borderRadius: 8, fontSize: 13.5 }
const list: React.CSSProperties = { margin: 0, paddingLeft: 18, display: 'grid', gap: 4, fontSize: 13, color: '#374151' }
