'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { BarSeries } from '@/app/components/charts/Bars'

interface Employee {
  id: string
  full_name: string
  email: string
  role: 'admin' | 'finance' | 'employee'
  status: string
  client_id: string | null
  band_code: string | null
  band_rank: number | null
  department: string | null
}

interface Client {
  id: string
  name: string
  status: string
}

interface MeResponse {
  ok: boolean
  employee: Employee
  client: Client | null
  // False for a CBT-only client, whose travel desk books for them. They still
  // see their trips and approvals here; booking links are hidden because the
  // server refuses them (clientGates.selfBooking).
  canSelfBook: boolean
  // A manager is whoever has people reporting to them (there is no manager
  // role). Approvers: they, finance and corporate admins.
  hasDirectReports: boolean
  isApprover: boolean
}

// ── Approval summary (manager/admin/finance) ────────────────────────────
// Real data now — count + oldest 3 names of whoever's waiting on THIS
// person specifically, from /api/approvals?summary=1.
interface ApprovalSummary {
  pendingCount: number
  urgentCount: number
  oldestNames: string[]
}

// ── Actionable bookings (employee's own) ────────────────────────────────
// The traveler's own bookings sitting in a state that needs them to come
// back — approved-and-ready-to-confirm, still pending, rejected, or
// misconfigured. From /api/bookings/actionable.
interface ActionableBooking {
  id: string
  status: string
  totalCost: number
  itinerary: {
    origin?: { code: string; city: string }
    destination?: { code: string; city: string }
  } | null
  updatedAt: string
}

// ── The figures (GET /api/dashboard) ─────────────────────────────────────
// Every number on the page comes from here or from the lists above; nothing
// is written into the page. Sell side only.
interface DashboardFigures {
  mine: {
    bookedThisYear: number
    spendThisYear: number
    awaitingApproval: number
    next: { id: string; origin: string | null; destination: string | null; departure: string } | null
  }
  approver: { decided30d: number; medianHours: number | null } | null
  company: {
    thisMonth: { bookings: number; spend: number }
    lastMonth: { bookings: number; spend: number }
    outcomes: { within: number; needsApproval: number; outOfPolicy: number; notEvaluated: number }
    outOfPolicySpend: number
    topDepartment: { name: string; spend: number } | null
    months: { month: string; bookings: number; spend: number }[]
  } | null
}

const inr = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`
const inrShort = (n: number) => n >= 1e7 ? `₹${(n / 1e7).toFixed(1)}Cr` : n >= 1e5 ? `₹${(n / 1e5).toFixed(1)}L` : n >= 1e3 ? `₹${(n / 1e3).toFixed(0)}k` : inr(n)

// "+12% on last month", or nothing when there is no last month to compare.
function change(now: number, before: number): string {
  if (before === 0) return now === 0 ? 'Nothing last month either' : 'Nothing last month'
  const pct = Math.round(((now - before) / before) * 100)
  return `${pct >= 0 ? '+' : ''}${pct}% on last month`
}

interface RecentBooking {
  id: string
  status: string
  pnr: string | null
  totalCost: number | null
  itinerary: {
    origin?: { code: string; city: string }
    destination?: { code: string; city: string }
  } | null
  fareBreakdown: { currency?: string } | null
  createdAt: string
  travelerName: string | null
  isOwn: boolean
  // Booked for them by the travel desk or a colleague; null when self-made.
  bookedByName?: string | null
}

const RECENT_STATUS_META: Record<string, { label: string; color: string; bg: string }> = {
  ticketed:               { label: 'Ticketed',        color: '#166534', bg: '#DCFCE7' },
  held:                   { label: 'Booked',          color: '#1E40AF', bg: '#DBEAFE' },
  approved:               { label: 'Approved',        color: '#1E40AF', bg: '#DBEAFE' },
  pending_approval:       { label: 'Pending approval', color: '#92400E', bg: '#FEF3C7' },
  rejected:               { label: 'Rejected',        color: '#991B1B', bg: '#FEE2E2' },
  approval_misconfigured: { label: 'Needs attention',  color: '#991B1B', bg: '#FEE2E2' },
  failed:                 { label: 'Failed',          color: '#991B1B', bg: '#FEE2E2' },
  cancelled:              { label: 'Cancelled',       color: '#6B7280', bg: '#F3F4F6' },
}

const ACTIONABLE_META: Record<string, { label: string; cta: string }> = {
  approved: { label: 'Ready to confirm', cta: 'Confirm now →' },
  pending_approval: { label: 'Awaiting approval', cta: 'View status →' },
  rejected: { label: 'Rejected', cta: 'See why →' },
  approval_misconfigured: { label: 'Needs admin attention', cta: 'View →' },
}

export default function DashboardPage() {
  const router = useRouter()
  const [me, setMe] = useState<MeResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [approvalSummary, setApprovalSummary] = useState<ApprovalSummary | null>(null)
  const [actionableBookings, setActionableBookings] = useState<ActionableBooking[]>([])
  const [recentBookings, setRecentBookings] = useState<RecentBooking[]>([])
  const [figures, setFigures] = useState<DashboardFigures | null>(null)

  // Split out from the mount effect so it can also be called on refocus —
  // approving/rejecting/booking happens on other pages (/approvals,
  // /book/confirm/[id]), and this dashboard instance can stay mounted
  // across client-side navigation, so a mount-only fetch would keep
  // showing stale statuses (e.g. a booking stuck showing "pending
  // approval" here even after it was actually approved elsewhere).
  async function loadDashboardData(opts?: { silent?: boolean }) {
    if (!opts?.silent) setLoading(true)
    try {
      const r = await fetch('/api/me')
      const data: MeResponse = await r.json()
      if (!r.ok || !data.ok) { router.replace('/login'); return }
      setMe(data)

      // Fetch what applies once we know who's logged in -- the approver
      // summary only for approvers (admins, finance, anyone with direct
      // reports); the actionable-bookings banner for everyone (an admin can
      // also be a traveler on their own bookings).
      if (data.isApprover) {
        fetch('/api/approvals?summary=1')
          .then(res => res.json())
          .then(d => { if (d.ok) setApprovalSummary({ pendingCount: d.pendingCount, urgentCount: d.urgentCount ?? 0, oldestNames: d.oldestNames }) })
          .catch(() => {})
      }

      fetch('/api/bookings/actionable')
        .then(res => res.json())
        .then(d => { if (d.ok) setActionableBookings(d.bookings) })
        .catch(() => {})

      fetch('/api/bookings/recent?limit=5')
        .then(res => res.json())
        .then(d => { if (d.ok) setRecentBookings(d.bookings) })
        .catch(() => {})

      fetch('/api/dashboard')
        .then(res => res.json())
        .then(d => { if (d.ok) setFigures(d) })
        .catch(() => {})
    } catch {
      router.replace('/login')
    } finally {
      if (!opts?.silent) setLoading(false)
    }
  }

  useEffect(() => {
    loadDashboardData()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router])

  // Refetch whenever the dashboard tab/window regains focus, or the page
  // is restored from bfcache (e.g. browser back landing on /dashboard).
  // Covers: approved something on /approvals then tabbed back, or hit
  // back and the browser served the cached dashboard without a real
  // reload — either way this brings actionableBookings/approvalSummary
  // up to date instead of showing whatever was true at mount time.
  useEffect(() => {
    function handleFocus() {
      loadDashboardData({ silent: true })
    }
    function handlePageShow(e: PageTransitionEvent) {
      if (e.persisted) loadDashboardData({ silent: true })
    }
    window.addEventListener('focus', handleFocus)
    window.addEventListener('pageshow', handlePageShow)
    return () => {
      window.removeEventListener('focus', handleFocus)
      window.removeEventListener('pageshow', handlePageShow)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (loading || !me || !me.employee) return <LoadingScreen />

  const { employee } = me
  const { role, full_name, band_code } = employee
  const canSelfBook = me.canSelfBook !== false
  const firstName = full_name?.split(' ')[0] ?? 'there'
  const isApproverRole = me.isApprover === true

  // Tiles, by what this person is. A figure not loaded yet shows "…"; a
  // real zero says so in words.
  const mine = figures?.mine
  const company = figures?.company
  const outcomes = company?.outcomes
  const judged = outcomes ? outcomes.within + outcomes.needsApproval + outcomes.outOfPolicy : 0
  const waiting = '…'
  const nextTrip = mine?.next
  const stats = company
    ? [
        { label: 'Bookings this month', value: String(company.thisMonth.bookings), sub: change(company.thisMonth.bookings, company.lastMonth.bookings) },
        { label: 'Spend this month', value: inrShort(company.thisMonth.spend), sub: change(company.thisMonth.spend, company.lastMonth.spend) },
        {
          label: 'Within policy',
          value: judged ? `${Math.round((outcomes!.within / judged) * 100)}%` : '—',
          sub: judged
            ? `${outcomes!.needsApproval} needed approval · ${outcomes!.outOfPolicy} out of policy`
            : outcomes?.notEvaluated ? `${outcomes.notEvaluated} not checked against policy` : 'No bookings this month',
        },
        isApproverRole
          ? { label: 'Waiting for you', value: String(approvalSummary?.pendingCount ?? 0), sub: approvalSummary?.pendingCount ? 'Needs your decision' : 'Nothing to decide' }
          : { label: 'Out-of-policy spend', value: inrShort(company.outOfPolicySpend), sub: 'This month' },
      ]
    : [
        { label: 'Flights booked this year', value: mine ? String(mine.bookedThisYear) : waiting, sub: mine?.bookedThisYear ? 'Held or ticketed' : 'None yet this year' },
        { label: 'Spend this year', value: mine ? inrShort(mine.spendThisYear) : waiting, sub: 'What your company paid' },
        { label: 'Awaiting approval', value: mine ? String(mine.awaitingApproval) : waiting, sub: mine?.awaitingApproval ? 'With your approver' : 'Nothing waiting' },
        ...(isApproverRole
          ? [{ label: 'Waiting for you', value: String(approvalSummary?.pendingCount ?? 0), sub: approvalSummary?.pendingCount ? 'Needs your decision' : 'Nothing to decide' }]
          : []),
      ]

  return (
    <main className="page-frame" style={s.main}>
        <div style={s.topBar}>
          <div>
            <h1 style={s.pageTitle}>{getGreeting()}, {firstName}</h1>
            <p style={s.pageDate}>
              {new Date().toLocaleDateString('en-GB', {
                weekday: 'long', day: 'numeric',
                month: 'long', year: 'numeric',
              })}
            </p>
          </div>
          {canSelfBook && <a href="/book" style={s.bookBtn}>+ New booking</a>}
        </div>

        {/* ── "Your booking needs you" banner — any role, since even an   */}
        {/* admin/manager can be a traveler on their own bookings ────── */}
        {actionableBookings.length > 0 && (
          <div style={s.actionBanner}>
            <div style={s.actionBannerHeader}>
              <span style={s.actionBannerIcon}>✈</span>
              <p style={s.actionBannerTitle}>
                {actionableBookings.length === 1 ? 'You have a booking that needs attention' : `You have ${actionableBookings.length} bookings that need attention`}
              </p>
            </div>
            <div style={s.actionBannerList}>
              {actionableBookings.slice(0, 3).map(b => {
                const meta = ACTIONABLE_META[b.status] ?? { label: b.status, cta: 'View →' }
                const route = b.itinerary?.origin && b.itinerary?.destination
                  ? `${b.itinerary.origin.code} → ${b.itinerary.destination.code}`
                  : 'Booking'
                return (
                  <a key={b.id} href={`/book/confirm/${b.id}`} style={s.actionBannerRow}>
                    <div>
                      <span style={s.actionBannerRoute}>{route}</span>
                      <span style={s.actionBannerStatus}>{meta.label}</span>
                    </div>
                    <span style={s.actionBannerCta}>{meta.cta}</span>
                  </a>
                )
              })}
            </div>
          </div>
        )}

        {role === 'employee' && (
          <div style={s.infoBanner}>
            <span style={s.infoBannerText}>
              {band_code
                ? <>Your travel policy is set for band <strong>{band_code}</strong>. </>
                : <>You have no band yet, so bookings are not checked against a travel policy. </>}
              Bookings that need approval go to your approver first.
            </span>
          </div>
        )}

        {role === 'employee' && me.hasDirectReports && (
          <div style={s.infoBanner}>
            <span style={s.infoBannerText}>
              You approve booking requests from the people who report to you,
              wherever your company&apos;s approval chain asks for their manager.
            </span>
          </div>
        )}

        <div style={{ ...s.statsRow, gridTemplateColumns: `repeat(${stats.length}, 1fr)` }}>
          {stats.map(stat => (
            <div key={stat.label} style={s.statCard}>
              <p style={s.statLabel}>{stat.label}</p>
              <p style={s.statValue}>{stat.value}</p>
              <p style={s.statSub}>{stat.sub}</p>
            </div>
          ))}
        </div>

        {nextTrip && (
          <a href={`/book/ticket/${nextTrip.id}`} style={s.nextTrip}>
            <span style={s.nextLabel}>Your next flight</span>
            <span style={s.nextRoute}>{nextTrip.origin ?? '—'} → {nextTrip.destination ?? '—'}</span>
            <span style={s.nextWhen}>
              {new Date(nextTrip.departure).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}
              {' · '}{nextTrip.departure.slice(11, 16)}
            </span>
          </a>
        )}

        {company && (
          <Section title="Company spend, last six months" linkLabel="Reports" linkHref="/reports">
            <BarSeries
              points={company.months.map(m => ({
                label: new Date(m.month).toLocaleDateString('en-GB', { month: 'short' }),
                value: m.spend,
              }))}
              format={inrShort}
            />
            {company.topDepartment && (
              <p style={s.chartNote}>
                Most this month: <strong>{company.topDepartment.name}</strong>, {inr(company.topDepartment.spend)}.
              </p>
            )}
          </Section>
        )}

        {figures?.approver && (
          <p style={s.approverNote}>
            You decided {figures.approver.decided30d} request{figures.approver.decided30d === 1 ? '' : 's'} in the last 30 days
            {figures.approver.medianHours !== null ? `, typically within ${figures.approver.medianHours} h` : ''}.
          </p>
        )}

        <Section title="Recent bookings" linkLabel="View all" linkHref="/bookings">
          {recentBookings.length > 0 ? (
            <div style={s.recentBookingsList}>
              {recentBookings.map(b => {
                const meta = RECENT_STATUS_META[b.status] ?? { label: b.status, color: '#6B7280', bg: '#F3F4F6' }
                const it = b.itinerary
                const currency = b.fareBreakdown?.currency ?? ''
                return (
                  <a key={b.id} href={`/book/ticket/${b.id}`} style={s.recentBookingRow}>
                    <div>
                      <div style={s.recentBookingRoute}>
                        {it?.origin && it?.destination
                          ? `${it.origin.code} → ${it.destination.code}`
                          : 'Flight booking'}
                      </div>
                      <div style={s.recentBookingSub}>
                        {!b.isOwn && b.travelerName ? `${b.travelerName} · ` : ''}
                        {new Date(b.createdAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })}
                        {b.pnr ? ` · PNR ${b.pnr}` : ''}
                        {b.bookedByName ? ` · Booked by ${b.bookedByName}` : ''}
                      </div>
                    </div>
                    <div style={s.recentBookingRight}>
                      {b.totalCost != null && (
                        <span style={s.recentBookingFare}>{currency} {b.totalCost.toLocaleString('en-IN')}</span>
                      )}
                      <span style={{ ...s.recentBookingBadge, color: meta.color, background: meta.bg }}>{meta.label}</span>
                    </div>
                  </a>
                )
              })}
            </div>
          ) : (
            <EmptyState
              icon="✈"
              title="No bookings yet"
              desc={
                !canSelfBook
                  ? 'Your travel desk books trips for you. They will appear here once booked.'
                  : role === 'employee'
                    ? 'Bookings you make, or that are made for you, appear here. If one needs approval it goes to your approver first.'
                    : 'When your team starts booking, their trips will appear here.'
              }
              cta={canSelfBook ? 'Make your first booking →' : undefined}
              ctaHref={canSelfBook ? '/book' : undefined}
            />
          )}
        </Section>

        {isApproverRole && (
          <Section title="Pending approvals" linkLabel="View all" linkHref="/approvals">
            {approvalSummary && approvalSummary.pendingCount > 0 ? (
              <div style={s.approvalPreviewList}>
                {approvalSummary.oldestNames.map((name, i) => (
                  <a key={i} href="/approvals" style={s.approvalPreviewRow}>
                    <span style={s.approvalPreviewDot} />
                    <span style={s.approvalPreviewName}>{name}</span>
                    <span style={s.approvalPreviewArrow}>→</span>
                  </a>
                ))}
                {approvalSummary.pendingCount > 3 && (
                  <a href="/approvals" style={s.approvalPreviewMore}>
                    +{approvalSummary.pendingCount - 3} more waiting →
                  </a>
                )}
              </div>
            ) : (
              <EmptyState
                icon="✔"
                title="No pending approvals"
                desc="Bookings sent to you for approval will show up here."
              />
            )}
          </Section>
        )}
    </main>
  )
}

function Section({ title, linkLabel, linkHref, children }: {
  title: string
  linkLabel: string
  linkHref: string
  children: React.ReactNode
}) {
  return (
    <div style={s.section}>
      <div style={s.sectionHeader}>
        <h2 style={s.sectionTitle}>{title}</h2>
        <a href={linkHref} style={s.sectionLink}>{linkLabel}</a>
      </div>
      {children}
    </div>
  )
}

function EmptyState({ icon, title, desc, cta, ctaHref }: {
  icon: string
  title: string
  desc: string
  cta?: string
  ctaHref?: string
}) {
  return (
    <div style={s.emptyState}>
      <div style={s.emptyIcon}>{icon}</div>
      <p style={s.emptyTitle}>{title}</p>
      <p style={s.emptyDesc}>{desc}</p>
      {cta && ctaHref && <a href={ctaHref} style={s.emptyCta}>{cta}</a>}
    </div>
  )
}

function LoadingScreen() {
  return (
    <div style={{
      minHeight: '100vh', display: 'flex',
      alignItems: 'center', justifyContent: 'center',
      background: '#F7F8FC', fontFamily: "'Inter', sans-serif",
    }}>
      <p style={{ fontSize: '13px', color: '#9CA3AF' }}>Loading…</p>
    </div>
  )
}

function getGreeting() {
  const h = new Date().getHours()
  if (h < 12) return 'Good morning'
  if (h < 17) return 'Good afternoon'
  return 'Good evening'
}

const s: Record<string, React.CSSProperties> = {
  // Padding and width: the shared .page-frame (globals.css).
  main: {},
  topBar: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '24px' },
  pageTitle: { fontSize: '20px', fontWeight: 600, color: '#0A0A14', margin: '0 0 3px', letterSpacing: '-0.3px' },
  pageDate: { fontSize: '12px', color: '#9CA3AF', margin: 0 },
  bookBtn: { display: 'inline-block', height: '34px', lineHeight: '34px', padding: '0 14px', background: '#000835', color: '#fff', fontSize: '12px', fontWeight: 600, borderRadius: '7px', textDecoration: 'none', flexShrink: 0 },
  actionBanner: { background: '#EEF2FF', border: '1px solid #C7D2FE', borderRadius: '10px', padding: '16px 18px', marginBottom: '20px' },
  actionBannerHeader: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' },
  actionBannerIcon: { fontSize: '15px' },
  actionBannerTitle: { fontSize: '13px', fontWeight: 700, color: '#3730A3', margin: 0 },
  actionBannerList: { display: 'flex', flexDirection: 'column' as const, gap: '6px' },
  actionBannerRow: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    background: '#fff', borderRadius: '8px', padding: '10px 12px', textDecoration: 'none',
  },
  actionBannerRoute: { fontSize: '12.5px', fontWeight: 600, color: '#111827', marginRight: '8px' },
  actionBannerStatus: { fontSize: '11px', color: '#6B7280' },
  actionBannerCta: { fontSize: '11.5px', fontWeight: 600, color: '#000835' },

  infoBanner: { background: '#EEF2FF', border: '1px solid #C7D2FE', borderRadius: '8px', padding: '11px 14px', marginBottom: '20px' },
  infoBannerText: { fontSize: '12px', color: '#3730A3', lineHeight: '1.55' },
  statsRow: { display: 'grid', gap: '14px', marginBottom: '20px' },
  statCard: { background: '#fff', border: '1px solid #E5E7EB', borderRadius: '9px', padding: '16px 18px' },
  statLabel: { fontSize: '10px', fontWeight: 600, color: '#9CA3AF', margin: '0 0 6px', textTransform: 'uppercase' as const, letterSpacing: '0.4px' },
  statValue: { fontSize: '24px', fontWeight: 700, color: '#111827', margin: '0 0 3px' },
  statSub: { fontSize: '10px', color: '#9CA3AF', margin: 0 },
  nextTrip: {
    display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap', background: '#fff', border: '1px solid #E5E7EB',
    borderRadius: 9, padding: '14px 18px', marginBottom: 16, textDecoration: 'none',
  },
  nextLabel: { fontSize: 10, fontWeight: 600, color: '#9CA3AF', textTransform: 'uppercase' as const, letterSpacing: '0.4px' },
  nextRoute: { fontSize: 15, fontWeight: 700, color: '#111827' },
  nextWhen: { fontSize: 12, color: '#6B7280' },
  chartNote: { fontSize: 12, color: '#6B7280', margin: '12px 0 0' },
  approverNote: { fontSize: 12, color: '#6B7280', margin: '-4px 0 16px' },
  section: { background: '#fff', border: '1px solid #E5E7EB', borderRadius: '9px', padding: '18px', marginBottom: '16px' },
  sectionHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px' },
  sectionTitle: { fontSize: '13px', fontWeight: 600, color: '#111827', margin: 0 },
  sectionLink: { fontSize: '11px', color: '#000835', textDecoration: 'none', fontWeight: 500 },

  approvalPreviewList: { display: 'flex', flexDirection: 'column' as const, gap: '6px' },
  approvalPreviewRow: {
    display: 'flex', alignItems: 'center', gap: '8px',
    padding: '9px 10px', borderRadius: '7px', background: '#F9FAFB', textDecoration: 'none',
  },
  approvalPreviewDot: { width: '6px', height: '6px', borderRadius: '50%', background: '#F59E0B', flexShrink: 0 },
  approvalPreviewName: { flex: 1, fontSize: '12.5px', fontWeight: 500, color: '#111827' },
  approvalPreviewArrow: { fontSize: '11px', color: '#9CA3AF' },
  approvalPreviewMore: { fontSize: '11.5px', fontWeight: 600, color: '#000835', textDecoration: 'none', padding: '4px 10px' },

  recentBookingsList: { display: 'flex', flexDirection: 'column' as const, gap: '6px' },
  recentBookingRow: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px',
    padding: '10px 12px', borderRadius: '9px', background: '#F9FAFB', textDecoration: 'none',
  },
  recentBookingRoute: { fontSize: '13px', fontWeight: 600, color: '#111827' },
  recentBookingSub: { fontSize: '11px', color: '#9CA3AF', marginTop: '2px' },
  recentBookingRight: { display: 'flex', alignItems: 'center', gap: '10px', flexShrink: 0 },
  recentBookingFare: { fontSize: '12px', fontWeight: 600, color: '#374151' },
  recentBookingBadge: { fontSize: '10.5px', fontWeight: 700, padding: '3px 9px', borderRadius: '6px', whiteSpace: 'nowrap' as const },

  emptyState: { display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '24px 0', textAlign: 'center' as const },
  emptyIcon: { fontSize: '22px', width: '48px', height: '48px', borderRadius: '50%', background: '#F9FAFB', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: '10px' },
  emptyTitle: { fontSize: '13px', fontWeight: 600, color: '#374151', margin: '0 0 4px' },
  emptyDesc: { fontSize: '12px', color: '#9CA3AF', maxWidth: '300px', margin: '0 0 12px', lineHeight: '1.5' },
  emptyCta: { fontSize: '12px', fontWeight: 600, color: '#000835', textDecoration: 'none' },
}