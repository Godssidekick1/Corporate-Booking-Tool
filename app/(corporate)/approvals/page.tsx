'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import Pagination from '@/app/components/Pagination'
import { formatTime, formatDayLabel } from '@/app/lib/book/types'
import { FlightRow, type TripCardTrip, type TripCardFlight } from '@/app/components/trips/TripCard'
import { money } from '@/app/lib/trips/status'
import { VERDICT_META } from '@/app/lib/policy/verdictLabels'

// ── /approvals ────────────────────────────────────────────────────────────
// A manager/finance/admin's approval queue: bookings currently waiting on
// THEIR decision (pending), plus a 30-day history of what they've already
// decided. Approve/reject calls PATCH /api/approvals/[approvalId], which
// re-verifies server-side that the caller is really the assigned approver —
// this page's own auth is just for showing the right person's queue, not
// the real enforcement.
// ─────────────────────────────────────────────────────────────────────────────

interface ApprovalItem {
  approvalId: string
  // A booking's air approval, or a trip's sign-off (the whole trip, once it
  // is ready: its flights were each approved, if they needed it, when booked).
  kind: 'booking' | 'trip'
  bookingId: string | null
  tripId: string | null
  trip: (TripCardTrip & {
    bookings: { id: string; status: string; pnr: string | null; totalCost: number | null; itinerary: TripCardFlight['itinerary'] }[]
  }) | null
  tier: number
  status: string
  reason: string | null
  decisionNote: string | null
  verdict: string | null
  createdAt: string
  actionedAt: string | null
  booking: {
    bookingType: string
    totalCost: number
    itinerary: {
      origin?: { code: string; city: string; dateTime: string }
      destination?: { code: string; city: string; dateTime: string }
      airline?: { code: string; name: string }
    } | null
    policyVerdict: string | null
    status: string
    // Booked on the traveller's behalf (travel desk or a colleague).
    bookedByName?: string | null
  } | null
  traveler: {
    fullName: string
    email: string
    department: string | null
  } | null
}


const STATUS_META: Record<string, { label: string; color: string; bg: string }> = {
  approved: { label: 'Approved', color: '#166534', bg: '#F0FDF4' },
  rejected: { label: 'Rejected', color: '#991B1B', bg: '#FEF2F2' },
}

function timeAgo(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diffMs / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

// A pending approval sitting this long risks running into the stale-key
// recovery path on Book (or just leaving a traveler stuck) — flagged as
// urgent so it doesn't get buried under newer, less time-critical requests.
const URGENT_HOURS = 10

function hoursPending(iso: string): number {
  return (Date.now() - new Date(iso).getTime()) / 3_600_000
}

export default function ApprovalsPage() {
  const router = useRouter()
  const [pending, setPending] = useState<ApprovalItem[]>([])
  const [history, setHistory] = useState<ApprovalItem[]>([])
  const [tab, setTab] = useState<'pending' | 'history'>('pending')
  // Each tab pages on its own; totals and the urgent count come from the
  // server, since a page holds only ten.
  const [pendingPage, setPendingPage] = useState(1)
  const [historyPage, setHistoryPage] = useState(1)
  const [pendingTotal, setPendingTotal] = useState(0)
  const [historyTotal, setHistoryTotal] = useState(0)
  const [urgentTotal, setUrgentTotal] = useState(0)
  const [pageSize, setPageSize] = useState(10)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [actingOn, setActingOn] = useState<string | null>(null)
  const [refreshingId, setRefreshingId] = useState<string | null>(null)
  const [noteDraft, setNoteDraft] = useState<Record<string, string>>({})

  // Once the approver has decided on at least one item this visit, this
  // page's pending list is no longer a safe place to land on via browser
  // back — it may show an item as still-pending when it's actually been
  // decided (approved/rejected), or an approve button that would now hit
  // the 409 "already actioned" guard server-side. Rather than let back
  // reopen that stale state, redirect forward to /dashboard instead.
  const hasDecidedRef = useRef(false)

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load reads the page numbers it depends on
  }, [pendingPage, historyPage])

  useEffect(() => {
    function handlePopState() {
      if (hasDecidedRef.current) {
        router.replace('/dashboard')
      }
    }
    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [router])

  async function load() {
    setLoading(true)
    setError('')
    try {
      const res = await fetch(`/api/approvals?pendingPage=${pendingPage}&historyPage=${historyPage}`)
      const data = await res.json()
      if (!data.ok) {
        setError(data.error || 'Could not load approvals.')
        return
      }
      setPending(data.pending)
      setHistory(data.history)
      setPendingTotal(data.pendingTotal ?? data.pending.length)
      setHistoryTotal(data.historyTotal ?? data.history.length)
      setUrgentTotal(data.urgentCount ?? 0)
      setPageSize(data.pageSize ?? 10)
    } catch {
      setError('Something went wrong loading approvals.')
    } finally {
      setLoading(false)
    }
  }

  async function handleRefreshFare(approvalId: string) {
    setRefreshingId(approvalId)
    setError('')
    try {
      const res = await fetch(`/api/approvals/${approvalId}/refresh-fare`, { method: 'POST' })
      const data = await res.json()
      if (!data.ok) {
        setError(data.error || 'Could not refresh the fare for this booking.')
        return
      }
      // The refreshed price/verdict is now saved server-side — reload the
      // queue so this card shows the new numbers rather than patching
      // fields in locally and risking drift from what's actually stored.
      await load()
    } catch {
      setError('Something went wrong refreshing the fare. Please try again.')
    } finally {
      setRefreshingId(null)
    }
  }

  async function handleDecision(approvalId: string, decision: 'approve' | 'reject') {
    setActingOn(approvalId)
    setError('')
    try {
      const res = await fetch(`/api/approvals/${approvalId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision, note: noteDraft[approvalId]?.trim() || undefined }),
      })
      const data = await res.json()
      if (!data.ok) {
        setError(data.error || 'Could not record your decision.')
        return
      }
      hasDecidedRef.current = true

      // Reload rather than patch state locally — a decision can create a
      // NEW pending row for the next tier (a different approver, so it
      // won't show here), or flip the booking to approved/misconfigured;
      // simplest to just re-fetch the queue fresh.
      await load()
    } catch {
      setError('Something went wrong recording your decision. Please try again.')
    } finally {
      setActingOn(null)
    }
  }

  const list = tab === 'pending' ? pending : history
  const urgentCount = urgentTotal

  return (
    <div className="page-frame narrow" style={s.page}>
      <div style={s.header}>
        <div style={s.headerRow}>
          <div>
            <h1 style={s.heading}>Approvals</h1>
            <p style={s.sub}>Bookings waiting on your sign-off, and what you've decided in the last 30 days.</p>
          </div>
          <button
            type="button"
            onClick={() => router.replace('/dashboard')}
            style={s.backBtn}
          >
            ← Back to dashboard
          </button>
        </div>
        {urgentCount > 0 && (
          <div style={s.urgentBanner}>
            <span style={s.urgentBannerIcon}>⏱</span>
            {urgentCount === 1
              ? '1 request has been waiting more than 10 hours.'
              : `${urgentCount} requests have been waiting more than 10 hours.`}
          </div>
        )}
      </div>

      <div style={s.tabs}>
        <button type="button" onClick={() => setTab('pending')} style={{ ...s.tab, ...(tab === 'pending' ? s.tabActive : {}) }}>
          Pending {pendingTotal > 0 && <span style={s.tabBadge}>{pendingTotal}</span>}
        </button>
        <button type="button" onClick={() => setTab('history')} style={{ ...s.tab, ...(tab === 'history' ? s.tabActive : {}) }}>
          History
        </button>
      </div>

      {error && <div style={s.errorBanner}><span style={s.bannerIcon}>⚠</span> {error}</div>}

      {loading ? (
        <div style={s.loadingRow}><div style={s.spinner} /></div>
      ) : list.length === 0 ? (
        <div style={s.emptyState}>
          {tab === 'pending' ? 'Nothing waiting on you right now.' : 'No decisions in the last 30 days.'}
        </div>
      ) : (
        <div style={s.list}>
          {list.map(item => {
            const verdictMeta = item.verdict ? VERDICT_META[item.verdict] : null
            const statusMeta = item.status !== 'pending' ? STATUS_META[item.status] : null
            const itinerary = item.booking?.itinerary
            const isUrgent = tab === 'pending' && hoursPending(item.createdAt) >= URGENT_HOURS

            return (
              <div key={item.approvalId} style={{ ...s.card, ...(isUrgent ? s.cardUrgent : {}) }}>
                <div style={s.cardTop}>
                  <div>
                    {item.kind === 'trip' && <div style={s.kindLabel}>Trip sign-off</div>}
                    <div style={s.travelerName}>{item.traveler?.fullName ?? 'Unknown traveler'}</div>
                    <div style={s.travelerSub}>
                      {item.traveler?.department ?? '—'} · Tier {item.tier}
                      {item.booking?.bookedByName ? ` · Requested by ${item.booking.bookedByName}` : ''}
                      {' · '}{tab === 'pending' ? timeAgo(item.createdAt) : `decided ${item.actionedAt ? timeAgo(item.actionedAt) : ''}`}
                    </div>
                  </div>
                  <div style={s.badges}>
                    {isUrgent && (
                      <span style={s.urgentBadge}>⏱ Urgent</span>
                    )}
                    {verdictMeta && (
                      <span style={{ ...s.badge, color: verdictMeta.color, background: verdictMeta.bg }}>{verdictMeta.label}</span>
                    )}
                    {statusMeta && (
                      <span style={{ ...s.badge, color: statusMeta.color, background: statusMeta.bg }}>{statusMeta.label}</span>
                    )}
                  </div>
                </div>

                {item.kind === 'trip' && item.trip && <TripSignOffSummary trip={item.trip} />}

                {item.kind === 'booking' && itinerary?.origin && itinerary?.destination && (
                  <div style={s.routeRow}>
                    <span style={s.routeCode}>{itinerary.origin.code}</span>
                    <span style={s.routeArrow}>→</span>
                    <span style={s.routeCode}>{itinerary.destination.code}</span>
                    <span style={s.routeMeta}>
                      {formatDayLabel(itinerary.origin.dateTime)} · {formatTime(itinerary.origin.dateTime)}
                      {itinerary.airline && ` · ${itinerary.airline.name}`}
                    </span>
                  </div>
                )}

                {item.kind === 'booking' && <div style={s.costRow}>
                  <span style={s.costLabel}>Total cost</span>
                  <div style={s.costRight}>
                    <span style={s.costValue}>₹{item.booking?.totalCost?.toLocaleString('en-IN') ?? '—'}</span>
                    {tab === 'pending' && (
                      <button
                        type="button"
                        onClick={() => handleRefreshFare(item.approvalId)}
                        disabled={refreshingId === item.approvalId || actingOn === item.approvalId}
                        style={{ ...s.refreshFareBtn, opacity: refreshingId === item.approvalId ? 0.6 : 1 }}
                        title="Get the current price and policy check for this fare before deciding"
                      >
                        {refreshingId === item.approvalId ? 'Refreshing…' : '↻ Refresh fare'}
                      </button>
                    )}
                  </div>
                </div>}

                {item.reason && (
                  <div style={s.reasonBox}>{item.reason}</div>
                )}

                {item.decisionNote && (
                  <div style={s.noteBox}>Your note: “{item.decisionNote}”</div>
                )}

                {tab === 'pending' && (
                  <>
                    <textarea
                      placeholder="Optional note (visible to the traveler)"
                      value={noteDraft[item.approvalId] ?? ''}
                      onChange={e => setNoteDraft(prev => ({ ...prev, [item.approvalId]: e.target.value }))}
                      style={s.noteInput}
                      rows={2}
                    />
                    <div style={s.actionRow}>
                      <button
                        type="button"
                        onClick={() => handleDecision(item.approvalId, 'reject')}
                        disabled={actingOn === item.approvalId}
                        style={{ ...s.rejectBtn, opacity: actingOn === item.approvalId ? 0.6 : 1 }}
                      >
                        Reject
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDecision(item.approvalId, 'approve')}
                        disabled={actingOn === item.approvalId}
                        style={{ ...s.approveBtn, opacity: actingOn === item.approvalId ? 0.6 : 1 }}
                      >
                        {actingOn === item.approvalId ? 'Saving…' : 'Approve'}
                      </button>
                    </div>
                  </>
                )}
              </div>
            )
          })}
        </div>
      )}

      {tab === 'pending'
        ? <Pagination page={pendingPage} pageSize={pageSize} total={pendingTotal} onPageChange={setPendingPage} busy={loading} noun="approvals" />
        : <Pagination page={historyPage} pageSize={pageSize} total={historyTotal} onPageChange={setHistoryPage} busy={loading} noun="decisions" />}
    </div>
  )
}

// A trip sign-off's body: what the trip is for, what it spent against its
// budget, and its flights, read-only -- each was approved, if it needed to be,
// when it was booked; this decision is about the trip as a whole.
function TripSignOffSummary({ trip }: { trip: NonNullable<ApprovalItem['trip']> }) {
  const currency = trip.currency ?? 'INR'
  const total = trip.total_cost ?? 0
  const facts = [
    trip.name || 'Untitled trip',
    trip.travel_type ? (trip.travel_type === 'domestic' ? 'Domestic' : 'International') : null,
    trip.cost_centre_code ? `Cost centre ${trip.cost_centre_code}` : null,
    trip.billable ? 'Billable' : null,
    trip.project ? `Project: ${trip.project}` : null,
  ].filter(Boolean)
  return (
    <div style={s.tripBox}>
      <div style={s.tripFacts}>{facts.map((f, i) => <span key={i} style={i === 0 ? s.tripName : undefined}>{f}</span>)}</div>
      <ul style={s.tripFlights}>
        {trip.bookings.map(b => (
          <FlightRow key={b.id} flight={{ id: b.id, status: b.status, pnr: b.pnr, total_cost: b.totalCost, itinerary: b.itinerary }} />
        ))}
      </ul>
      <div style={s.costRow}>
        <span style={s.costLabel}>Trip total</span>
        <span style={s.costValue}>
          {money(total, currency)}
          {trip.budget_amount != null && (
            <span style={{ ...s.budgetNote, ...(total > trip.budget_amount ? s.overBudget : {}) }}>
              {' '}of {money(trip.budget_amount, currency)} budget
            </span>
          )}
        </span>
      </div>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  kindLabel: { fontSize: 10.5, fontWeight: 700, color: '#4338CA', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 2 },
  tripBox: { display: 'flex', flexDirection: 'column', gap: 8, margin: '10px 0' },
  tripFacts: { display: 'flex', flexWrap: 'wrap', gap: '4px 12px', fontSize: 12.5, color: '#4B5563' },
  tripName: { fontWeight: 700, color: '#111827' },
  tripFlights: { listStyle: 'none', margin: 0, padding: 0, borderTop: '1px solid #F3F4F6' },
  budgetNote: { fontSize: 12, fontWeight: 500, color: '#6B7280' },
  overBudget: { color: '#B91C1C', fontWeight: 600 },
  // Padding and width: the shared .page-frame (globals.css).
  page: { fontFamily: "'Inter', -apple-system, sans-serif" },

  header: { marginBottom: '20px' },
  headerRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '16px', flexWrap: 'wrap' as const },
  heading: { fontSize: '22px', fontWeight: 700, color: '#0A0A14', margin: '0 0 6px', letterSpacing: '-0.4px' },
  sub: { fontSize: '13px', color: '#6B7280', margin: 0, lineHeight: 1.5 },
  backBtn: {
    flexShrink: 0, height: '40px', padding: '0 16px', background: '#000835', color: '#fff', border: 'none',
    borderRadius: '10px', fontSize: '13px', fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap' as const,
  },
  urgentBanner: {
    display: 'flex', alignItems: 'center', gap: '8px', background: '#FEF2F2', border: '1px solid #FECACA',
    borderRadius: '10px', padding: '10px 14px', fontSize: '12.5px', fontWeight: 600, color: '#991B1B', marginTop: '14px',
  },
  urgentBannerIcon: { fontSize: '13px' },
  urgentBadge: {
    fontSize: '10.5px', fontWeight: 700, padding: '3px 9px', borderRadius: '6px', whiteSpace: 'nowrap' as const,
    color: '#991B1B', background: '#FEF2F2', border: '1px solid #FECACA',
  },

  tabs: { display: 'flex', gap: '8px', marginBottom: '20px' },
  tab: {
    fontSize: '13px', fontWeight: 600, color: '#6B7280', background: '#fff', border: '1px solid #E5E7EB',
    borderRadius: '8px', padding: '8px 14px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px',
  },
  tabActive: { color: '#000835', border: '1px solid #000835', background: '#EEF2FF' },
  tabBadge: {
    fontSize: '10px', fontWeight: 700, color: '#fff', background: '#000835',
    borderRadius: '999px', padding: '1px 7px', minWidth: '16px', textAlign: 'center' as const,
  },

  errorBanner: {
    display: 'flex', alignItems: 'center', gap: '8px', background: '#FEF2F2', border: '1px solid #FECACA',
    borderRadius: '10px', padding: '11px 14px', fontSize: '13px', color: '#DC2626', marginBottom: '16px',
  },
  bannerIcon: { fontSize: '14px' },

  loadingRow: { display: 'flex', justifyContent: 'center', padding: '80px 0' },
  spinner: { width: '24px', height: '24px', border: '2.5px solid #E5E7EB', borderTopColor: '#000835', borderRadius: '50%', animation: 'spin 0.7s linear infinite' },

  emptyState: { padding: '60px 20px', textAlign: 'center' as const, fontSize: '13px', color: '#9CA3AF' },

  list: { display: 'flex', flexDirection: 'column' as const, gap: '14px' },
  card: { background: '#fff', border: '1px solid #E5E7EB', borderRadius: '14px', padding: '18px' },
  cardUrgent: { borderColor: '#FECACA', boxShadow: '0 0 0 1px #FECACA' },
  cardTop: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '10px', gap: '10px' },
  travelerName: { fontSize: '14.5px', fontWeight: 700, color: '#111827' },
  travelerSub: { fontSize: '11.5px', color: '#9CA3AF', marginTop: '2px' },
  badges: { display: 'flex', gap: '6px', flexShrink: 0, flexWrap: 'wrap' as const, justifyContent: 'flex-end' as const },
  badge: { fontSize: '10.5px', fontWeight: 700, padding: '3px 9px', borderRadius: '6px', whiteSpace: 'nowrap' as const },

  routeRow: {
    display: 'flex', alignItems: 'center', gap: '8px', background: '#F9FAFB', border: '1px solid #F3F4F6',
    borderRadius: '10px', padding: '10px 12px', marginBottom: '10px', fontSize: '13px',
  },
  routeCode: { fontWeight: 700, color: '#111827' },
  routeArrow: { color: '#9CA3AF', fontSize: '12px' },
  routeMeta: { fontSize: '11.5px', color: '#9CA3AF', marginLeft: 'auto' },

  costRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' },
  costLabel: { fontSize: '11.5px', color: '#9CA3AF' },
  costRight: { display: 'flex', alignItems: 'center', gap: '10px' },
  costValue: { fontSize: '15px', fontWeight: 700, color: '#0A0A14' },
  refreshFareBtn: {
    fontSize: '11px', fontWeight: 600, color: '#374151', background: '#F9FAFB',
    border: '1px solid #E5E7EB', borderRadius: '7px', padding: '5px 10px', cursor: 'pointer', whiteSpace: 'nowrap' as const,
  },

  reasonBox: { fontSize: '12px', color: '#6B7280', lineHeight: 1.5, background: '#F9FAFB', borderRadius: '8px', padding: '10px 12px', marginBottom: '10px' },
  noteBox: { fontSize: '12px', color: '#6B7280', fontStyle: 'italic' as const, marginBottom: '10px' },

  noteInput: {
    width: '100%', fontSize: '12.5px', color: '#111827', background: '#F9FAFB', border: '1px solid #E5E7EB',
    borderRadius: '8px', padding: '8px 10px', outline: 'none', resize: 'vertical' as const, marginBottom: '10px', fontFamily: 'inherit',
    boxSizing: 'border-box' as const,
  },

  actionRow: { display: 'flex', gap: '10px' },
  rejectBtn: {
    flex: 1, height: '38px', background: '#fff', color: '#DC2626', border: '1px solid #FECACA',
    borderRadius: '8px', fontSize: '13px', fontWeight: 600, cursor: 'pointer',
  },
  approveBtn: {
    flex: 1, height: '38px', background: '#000835', color: '#fff', border: 'none',
    borderRadius: '8px', fontSize: '13px', fontWeight: 700, cursor: 'pointer',
  },
}