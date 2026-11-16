'use client'

import { useEffect, useState } from 'react'
import type React from 'react'
import Link from 'next/link'
import { BarSeries } from '@/app/components/charts/Bars'
import { SkeletonTiles } from '@/app/components/Skeleton'
import { ListHeader, list } from '@/app/components/config/ListPage'

// ── /settings/company ────────────────────────────────────────────────────────
// The company at a glance, for its admins: people and this month's travel up
// top, then everything the travel desk has configured for it (profile, how it
// books, approvals, refunds, people). Read-only: the travel desk owns client
// configuration, and the page says so (GET /api/settings/company).
// ─────────────────────────────────────────────────────────────────────────────

interface Company {
  travelDesk: { name: string | null; branch: { name: string; city: string | null } | null }
  profile: {
    name: string; code: string | null; status: string; industry: string | null; size: string | null
    email: string | null; phone: string | null; address: string | null; timezone: string; currency: string
    bookingMode: 'sbt' | 'cbt' | 'both'
    gstin: { gstin: string; state: string | null; registrations: number } | null
  }
  booking: {
    bookingActivation: boolean | null; holdActivation: boolean | null; domesticTicketing: boolean | null
    internationalTicketing: boolean | null; policyControlling: boolean | null; personalTrips: boolean | null
    guestBookings: boolean | null; outOfPolicy: string | null; reasonRequired: boolean | null
    duplicateCheck: string | null; fareRiseReapproval: { amount: number; unit: string | null } | null
  }
  approvals: { air: string | null; hotel: string | null; trip: string | null; withinPolicy: string | null; escalationHours: number | null }
  refunds: { markupRefunded: boolean | null; feeRefunded: boolean | null; cancellationFee: { amount: number; unit: string | null } | null; gstRate: number | null }
  people: {
    active: number; invited: number; deactivated: number; admins: number; finance: number; noManager: number
    departments: number; costCentres: number; bands: { code: string; label: string; rank: number; people: number }[]
  }
  figures: {
    thisMonth: { bookings: number; spend: number }; lastMonth: { bookings: number; spend: number }
    outcomes: { within: number; needsApproval: number; outOfPolicy: number; notEvaluated: number }
    outOfPolicySpend: number; topDepartment: { name: string; spend: number } | null
    months: { month: string; bookings: number; spend: number }[]
  }
}

const MODE: Record<string, string> = {
  sbt: 'Self-booking: employees book their own travel',
  cbt: 'Travel desk: a counsellor books on your behalf',
  both: 'Hybrid: employees book, and the travel desk can too',
}
const APPROVAL_MODE: Record<string, string> = { before_booking: 'Approval before booking', not_required: 'No approval', on_submit: 'Signed off when the trip is submitted' }
const OUT_OF_POLICY: Record<string, string> = { approve: 'Allowed, with approval', block_red: 'Out-of-policy fares blocked' }
const DUPLICATE: Record<string, string> = { off: 'Not checked', warn: 'Warn the booker', block: 'Blocked' }
const inr = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`
const compact = (n: number) => n >= 1e5 ? `₹${(n / 1e5).toFixed(1)}L` : n >= 1e3 ? `₹${Math.round(n / 1e3)}k` : `₹${Math.round(n)}`
const yesNo = (v: boolean | null | undefined) => (v === null || v === undefined ? '—' : v ? 'Yes' : 'No')
const onOff = (v: boolean | null | undefined) => (v === null || v === undefined ? '—' : v ? 'On' : 'Off')

export default function CompanyPage() {
  const [c, setC] = useState<Company | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let live = true
    fetch('/api/settings/company')
      .then(async r => ({ ok: r.ok, body: await r.json().catch(() => ({})) }))
      .then(({ ok, body }) => { if (!live) return; if (!ok) setError(body.error ?? 'Could not load your company.'); else setC(body) })
      .catch(() => { if (live) setError('Could not load your company. Check your connection and try again.') })
    return () => { live = false }
  }, [])

  if (error) return <div style={list.root}><ListHeader title="Company" /><p style={list.errorBanner}>{error}</p></div>
  if (!c) return <div style={list.root}><ListHeader title="Company" /><SkeletonTiles count={4} /></div>

  const f = c.figures
  const judged = f.outcomes.within + f.outcomes.needsApproval + f.outcomes.outOfPolicy
  const compliance = judged ? Math.round((f.outcomes.within / judged) * 100) : null
  const change = (now: number, before: number) => before ? `${now >= before ? '+' : ''}${Math.round(((now - before) / before) * 100)}% on last month` : 'No bookings last month'

  return (
    <div style={list.root}>
      <ListHeader
        title={c.profile.name}
        description={<>Everything configured for your company, and this month&apos;s travel. Managed by your travel desk{c.travelDesk.name ? ` (${c.travelDesk.name})` : ''}: contact them to change any of it.</>}
        actions={<Link href="/settings/users" style={{ ...list.ghostBtn, display: 'inline-flex', alignItems: 'center', textDecoration: 'none' }}>Manage users</Link>}
      />

      {/* ── At a glance ───────────────────────────────────────────── */}
      <div style={tiles}>
        <Tile label="People" value={String(c.people.active)} hint={`${c.people.invited} invited · ${c.people.admins} admin${c.people.admins === 1 ? '' : 's'}`} />
        <Tile label="Bookings this month" value={String(f.thisMonth.bookings)} hint={change(f.thisMonth.bookings, f.lastMonth.bookings)} />
        <Tile label="Spend this month" value={inr(f.thisMonth.spend)} hint={change(f.thisMonth.spend, f.lastMonth.spend)} />
        <Tile label="Within policy" value={compliance === null ? '—' : `${compliance}%`}
          hint={f.outOfPolicySpend > 0 ? `${inr(f.outOfPolicySpend)} spent out of policy` : judged ? 'This month' : 'Nothing judged this month'} />
      </div>

      <section style={card}>
        <div style={cardHead}><h2 style={h2}>Spend, last six months</h2>
          {f.topDepartment && <span style={muted}>Top department: {f.topDepartment.name} ({inr(f.topDepartment.spend)})</span>}</div>
        <BarSeries
          points={f.months.map(m => ({ label: new Date(`${m.month}T00:00:00`).toLocaleDateString('en-IN', { month: 'short' }), value: m.spend }))}
          format={compact} />
      </section>

      {c.people.noManager > 0 && (
        <div style={list.warnBanner}>
          <strong>{c.people.noManager} {c.people.noManager === 1 ? 'person has' : 'people have'} no manager set.</strong>{' '}
          Approval steps that go to someone&apos;s manager cannot reach them. <Link href="/organization?unassigned=1">See who</Link>, then ask your travel desk to set their reporting lines.
        </div>
      )}

      <div style={grid}>
        <Card title="Profile" rows={[
          ['Company code', c.profile.code],
          ['Industry', c.profile.industry],
          ['Size', c.profile.size],
          ['Email', c.profile.email],
          ['Phone', c.profile.phone],
          ['Address', c.profile.address],
          ['GSTIN', c.profile.gstin ? `${c.profile.gstin.gstin}${c.profile.gstin.state ? ` (${c.profile.gstin.state})` : ''}${c.profile.gstin.registrations > 1 ? ` + ${c.profile.gstin.registrations - 1} more` : ''}` : null],
          ['Currency · timezone', `${c.profile.currency} · ${c.profile.timezone}`],
          ['Travel desk', [c.travelDesk.name, c.travelDesk.branch ? `${c.travelDesk.branch.name}${c.travelDesk.branch.city ? `, ${c.travelDesk.branch.city}` : ''}` : null].filter(Boolean).join(' · ') || null],
        ]} />
        <Card title="How you book" rows={[
          ['Booking mode', MODE[c.profile.bookingMode] ?? c.profile.bookingMode],
          ['Booking', onOff(c.booking.bookingActivation)],
          ['Hold, then book later', onOff(c.booking.holdActivation)],
          ['Ticketing', `Domestic ${onOff(c.booking.domesticTicketing).toLowerCase()} · international ${onOff(c.booking.internationalTicketing).toLowerCase()}`],
          ['Travel policy checked', yesNo(c.booking.policyControlling)],
          ['Out-of-policy fares', c.booking.outOfPolicy ? OUT_OF_POLICY[c.booking.outOfPolicy] ?? c.booking.outOfPolicy : '—'],
          ['Reason asked for out-of-policy', yesNo(c.booking.reasonRequired)],
          ['Personal trips', c.booking.personalTrips ? 'Allowed' : 'Not allowed'],
          ['Bookings for guests', c.booking.guestBookings ? 'Allowed' : 'Not allowed'],
          ['Same trip booked twice', c.booking.duplicateCheck ? DUPLICATE[c.booking.duplicateCheck] ?? c.booking.duplicateCheck : '—'],
        ]} />
        <Card title="Approvals" rows={[
          ['Flights', c.approvals.air ? APPROVAL_MODE[c.approvals.air] ?? c.approvals.air : '—'],
          ['Hotels', c.approvals.hotel ? APPROVAL_MODE[c.approvals.hotel] ?? c.approvals.hotel : '—'],
          ['Trips', c.approvals.trip ? APPROVAL_MODE[c.approvals.trip] ?? c.approvals.trip : '—'],
          ['Within-policy bookings', c.approvals.withinPolicy === 'required' ? 'Sent for approval' : c.approvals.withinPolicy === 'auto' ? 'Approved automatically' : '—'],
          ['Waiting too long', c.approvals.escalationHours ? `Passes to the approver’s manager after ${c.approvals.escalationHours} h` : 'Not escalated'],
          ['Fare rises before booking', c.booking.fareRiseReapproval ? `Approved again above ${c.booking.fareRiseReapproval.unit === 'pct' ? `${c.booking.fareRiseReapproval.amount}%` : inr(c.booking.fareRiseReapproval.amount)}` : 'Not re-approved'],
        ]} />
        <Card title="Refunds on cancellation" rows={[
          ['Markup refunded', yesNo(c.refunds.markupRefunded)],
          ['Processing fee refunded', yesNo(c.refunds.feeRefunded)],
          ['Travel desk cancellation fee', c.refunds.cancellationFee ? (c.refunds.cancellationFee.unit === 'percent' ? `${c.refunds.cancellationFee.amount}%` : inr(c.refunds.cancellationFee.amount)) : 'None'],
          ['GST on that fee', c.refunds.gstRate !== null ? `${c.refunds.gstRate}%` : '—'],
        ]} />
        <section style={card}>
          <h2 style={h2}>People</h2>
          <dl style={facts}>
            <dt style={dt}>Active</dt><dd style={dd}>{c.people.active}</dd>
            <dt style={dt}>Invited, not joined</dt><dd style={dd}>{c.people.invited}</dd>
            <dt style={dt}>Deactivated</dt><dd style={dd}>{c.people.deactivated}</dd>
            <dt style={dt}>Admins · finance</dt><dd style={dd}>{c.people.admins} · {c.people.finance}</dd>
            <dt style={dt}>Departments · cost centres</dt><dd style={dd}>{c.people.departments} · {c.people.costCentres}</dd>
          </dl>
          {c.people.bands.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
              {c.people.bands.map(b => (
                <span key={b.code} style={bandChip} title={b.label}>{b.code} <b style={{ fontWeight: 700 }}>{b.people}</b></span>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div style={tile}>
      <p style={tileLabel}>{label}</p>
      <p style={tileValue}>{value}</p>
      {hint && <p style={tileHint}>{hint}</p>}
    </div>
  )
}

function Card({ title, rows }: { title: string; rows: [string, string | null | undefined][] }) {
  return (
    <section style={card}>
      <h2 style={h2}>{title}</h2>
      <dl style={facts}>
        {rows.map(([k, v]) => (
          <div key={k} style={{ display: 'contents' }}>
            <dt style={dt}>{k}</dt>
            <dd style={dd}>{v || '—'}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

const tiles: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: 12, marginBottom: 14 }
const tile: React.CSSProperties = { background: '#fff', border: '1px solid #E5E7EB', borderRadius: 10, padding: '14px 16px' }
const tileLabel: React.CSSProperties = { fontSize: 10.5, fontWeight: 600, color: '#9CA3AF', margin: '0 0 6px', textTransform: 'uppercase', letterSpacing: '0.4px' }
const tileValue: React.CSSProperties = { fontSize: 22, fontWeight: 700, color: '#111827', margin: 0, fontVariantNumeric: 'tabular-nums' }
const tileHint: React.CSSProperties = { fontSize: 11.5, color: '#6B7280', margin: '4px 0 0' }
const grid: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 14 }
const card: React.CSSProperties = { background: '#fff', border: '1px solid #E5E7EB', borderRadius: 10, padding: '14px 16px', marginBottom: 14, minWidth: 0 }
const cardHead: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }
const h2: React.CSSProperties = { fontSize: 12, fontWeight: 700, color: '#111827', textTransform: 'uppercase', letterSpacing: '0.5px', margin: '0 0 10px' }
const muted: React.CSSProperties = { fontSize: 12, color: '#6B7280' }
const facts: React.CSSProperties = { margin: 0, display: 'grid', gridTemplateColumns: 'minmax(140px, auto) 1fr', gap: '7px 14px', fontSize: 13 }
const dt: React.CSSProperties = { color: '#6B7280' }
const dd: React.CSSProperties = { margin: 0, color: '#111827', overflowWrap: 'anywhere' }
const bandChip: React.CSSProperties = { fontSize: 11.5, color: '#3730A3', background: '#EEF2FF', borderRadius: 6, padding: '3px 8px' }
