'use client'

import { useState } from 'react'
import type React from 'react'
import type { FareRules, FareRuleWindow, FareRulePax } from '@/app/lib/book/fareRules'

// ── FareRulesPanel ───────────────────────────────────────────────────────────
// The airline's own cancellation and change rules for a fare, as the GDS filed
// them (app/lib/book/fareRules.ts): per sector, each window before departure
// and its charge, no-show, and the airline's notes folded underneath. One
// component for every page that shows them: the fare page once a fare is
// chosen, the traveller's booking, the TMC's booking page and refund panel.
//
// The charges are the AIRLINE's, per passenger per sector. The travel desk's
// own cancellation fee is separate, and the foot note says so.
// ─────────────────────────────────────────────────────────────────────────────

const money = (amount: number, currency: string) =>
  currency === 'INR' ? `₹${Math.round(amount).toLocaleString('en-IN')}` : `${currency} ${amount.toLocaleString('en-IN')}`

function chargeText(w: FareRuleWindow, kind: 'cancel' | 'change'): { text: string; tone: 'free' | 'fee' | 'no' } {
  if (!w.permitted) return { text: kind === 'cancel' ? 'Non-refundable' : 'Not permitted', tone: 'no' }
  if (w.amount === 0) return { text: kind === 'cancel' ? 'Free cancellation' : 'Free change', tone: 'free' }
  return { text: `${money(w.amount, w.currency)} per passenger`, tone: 'fee' }
}

const PAX: Record<string, string> = { ADT: 'Adult', CHD: 'Child', CNN: 'Child', INF: 'Infant' }

function travelDay(v: string | null): string | null {
  if (!v) return null
  const d = new Date(v.replace(' ', 'T'))
  return Number.isNaN(d.getTime()) ? v : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
}

// Why a fare page has no rules to show, when it knows (from /api/book/fare-rules).
export type RulesProblem = 'timeout' | 'error' | 'none' | null

export default function FareRulesPanel({ rules, loading = false, problem = null, onRetry, compact = false, embedded = false, showDealCode = false, title = 'Fare rules' }: {
  rules: FareRules | null | undefined
  loading?: boolean
  // Said instead of the plain "no rules" line: the airline did not answer, or
  // the request failed, which a retry may fix (onRetry offers it).
  problem?: RulesProblem
  onRetry?: () => void
  // The fare page: notes folded away and tighter spacing.
  compact?: boolean
  // Inside another card (the round trip's flight): a divider, not a second box.
  embedded?: boolean
  // The TMC only: the deal code the fare was priced under.
  showDealCode?: boolean
  title?: string
}) {
  return (
    <section style={embedded ? s.embedded : s.card} aria-label={title}>
      <div style={s.head}>
        <h2 style={s.title}>{title}</h2>
        <span style={s.sub}>From the airline</span>
      </div>

      {loading && (
        <p style={s.muted}>
          Getting the cancellation and change rules from the airline. The airline can take up to half a minute to answer; the
          price above is already confirmed.
        </p>
      )}

      {!loading && !rules?.sectors.length && (problem === 'timeout' || problem === 'error') && (
        <p style={s.muted}>
          {problem === 'timeout'
            ? 'The airline did not answer with this fare’s rules in time.'
            : 'The airline’s rules for this fare could not be fetched.'}
          {onRetry && <> <button type="button" onClick={onRetry} style={s.retry}>Try again</button></>}
        </p>
      )}

      {!loading && !rules?.sectors.length && problem !== 'timeout' && problem !== 'error' && (
        <p style={s.muted}>
          The airline has no rules on file for this fare.
          {rules?.unavailable.length ? ` (${rules.unavailable[0]})` : ''} Ask your travel desk before relying on a refund.
        </p>
      )}

      {!loading && rules?.sectors.map((sector, si) => (
        <div key={si} style={si > 0 ? { ...s.sector, ...s.sectorDivider } : s.sector}>
          <div style={s.sectorHead}>
            <span style={s.route}>{sector.origin ?? '—'} → {sector.destination ?? '—'}</span>
            <span style={s.meta}>
              {[sector.carrier, travelDay(sector.travelDate), sector.fareBasis.length ? `Fare basis ${sector.fareBasis.join(', ')}` : null]
                .filter(Boolean).join(' · ')}
              {showDealCode && sector.dealCode && <span style={s.deal}>Deal code {sector.dealCode}</span>}
            </span>
          </div>
          {sector.pax.map((p, pi) => (
            <PaxRules key={pi} pax={p} label={sector.pax.length > 1 ? PAX[p.paxType] ?? p.paxType : null} compact={compact} />
          ))}
        </div>
      ))}

      {!loading && !!rules?.sectors.length && (
        <p style={s.foot}>
          Airline charges, per passenger for each flight. Your travel desk’s own cancellation fee may also apply.
        </p>
      )}
    </section>
  )
}

function PaxRules({ pax, label, compact }: { pax: FareRulePax; label: string | null; compact: boolean }) {
  const [open, setOpen] = useState(!compact)
  const notes = [...new Set([...pax.cancel, ...pax.change, ...pax.other.flatMap(o => o.windows)]
    .map(w => w.note).filter((n): n is string => !!n))]
  return (
    <div style={s.pax}>
      {label && <span style={s.paxLabel}>{label}</span>}
      <div style={compact ? s.tablesCompact : s.tables}>
        <RuleTable heading="Cancellation" kind="cancel" windows={pax.cancel} />
        <RuleTable heading="Date change" kind="change" windows={pax.change} />
      </div>
      {pax.other.map(o => (
        <RuleTable key={o.policyType} heading={`Other rule (${o.policyType})`} kind="change" windows={o.windows} />
      ))}
      {notes.length > 0 && (
        <div style={s.notes}>
          <button type="button" onClick={() => setOpen(v => !v)} style={s.notesToggle} aria-expanded={open}>
            {open ? '▾' : '▸'} Airline notes ({notes.length})
          </button>
          {open && (
            <ul style={s.notesList}>
              {notes.map((n, i) => <li key={i} style={s.note}>{n}</li>)}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

function RuleTable({ heading, kind, windows }: { heading: string; kind: 'cancel' | 'change'; windows: FareRuleWindow[] }) {
  return (
    <div style={s.table}>
      <span style={s.tableHead}>{heading}</span>
      {windows.length === 0 && <span style={s.muted}>Not filed by the airline</span>}
      {windows.map((w, i) => {
        const c = chargeText(w, kind)
        return (
          <div key={i} style={s.row}>
            <span style={s.when}>{w.label}</span>
            <span style={{ ...s.charge, ...(c.tone === 'free' ? s.free : c.tone === 'no' ? s.no : null) }}>{c.text}</span>
          </div>
        )
      })}
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  card: { background: 'var(--color-surface)', border: '1px solid var(--color-line)', borderRadius: 14, padding: '18px 20px', marginBottom: 16 },
  embedded: { borderTop: '1px solid var(--color-line)', marginTop: 14, paddingTop: 12 },
  head: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, marginBottom: 10 },
  title: { fontSize: 15, fontWeight: 700, color: 'var(--color-ink)', margin: 0 },
  sub: { fontSize: 11.5, color: 'var(--color-muted)' },
  muted: { fontSize: 12.5, color: 'var(--color-muted)', margin: '4px 0' },
  retry: { background: 'none', border: 0, padding: 0, font: 'inherit', fontWeight: 600, color: 'var(--color-info-fg)', cursor: 'pointer', textDecoration: 'underline' },
  sector: { paddingTop: 4 },
  sectorDivider: { borderTop: '1px solid var(--color-line)', marginTop: 12, paddingTop: 12 },
  sectorHead: { display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: '4px 12px', marginBottom: 8 },
  route: { fontSize: 13.5, fontWeight: 700, color: 'var(--color-ink)' },
  meta: { fontSize: 12, color: 'var(--color-muted)', display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'baseline' },
  deal: { fontSize: 11, fontWeight: 600, color: 'var(--color-info-fg)', background: 'var(--color-info-bg)', padding: '1px 7px', borderRadius: 999 },
  pax: { marginBottom: 8 },
  paxLabel: { display: 'block', fontSize: 11, fontWeight: 700, color: 'var(--color-secondary)', textTransform: 'uppercase', letterSpacing: 0.4, margin: '6px 0 4px' },
  tables: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 14 },
  tablesCompact: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 },
  table: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 },
  tableHead: { fontSize: 10.5, fontWeight: 700, color: 'var(--color-muted)', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 2 },
  row: { display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 12.5, padding: '5px 0', borderBottom: '1px dashed var(--color-line)' },
  when: { color: 'var(--color-body)', minWidth: 0 },
  charge: { fontWeight: 600, color: 'var(--color-warn-fg)', whiteSpace: 'nowrap' },
  free: { color: 'var(--color-success-fg)' },
  no: { color: 'var(--color-danger-fg)' },
  notes: { marginTop: 8 },
  notesToggle: { background: 'none', border: 'none', padding: 0, fontSize: 12, fontWeight: 600, color: 'var(--color-info-fg)', cursor: 'pointer' },
  notesList: { margin: '6px 0 0', paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 4 },
  note: { fontSize: 12, color: 'var(--color-body)', lineHeight: 1.45 },
  foot: { fontSize: 11.5, color: 'var(--color-muted)', margin: '10px 0 0' },
}
