import type { DeskView } from '@/app/lib/commercials/deskView'

// ── How the price is made, for the travel desk ───────────────────────────────
// Rendered only when the server sent `desk`, which it does for TMC staff
// booking for someone and for nobody else (app/lib/commercials/deskView.ts).
// The traveller's own pages never receive the figures, so there is nothing
// here to hide from them.
//
// Laid out as a small statement, matching the fare breakdown above it: one
// line per figure with its sign, a rule, then what the client pays and what
// the TMC keeps. Amounts in the page's own format (paise kept, aligned).
// ─────────────────────────────────────────────────────────────────────────────

export default function DeskFareStrip({ desk, currency = 'INR' }: { desk: DeskView | null | undefined; currency?: string }) {
  if (!desk) return null
  const money = (n: number) =>
    `${currency} ${Math.abs(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  const marginPct = desk.sellTotal ? (desk.margin / desk.sellTotal) * 100 : 0
  const lines: { label: string; value: string; tone?: 'minus' }[] = [
    { label: 'Airline fare', value: money(desk.airlineTotal) },
    { label: 'Markup', value: `+ ${money(desk.markup)}` },
    ...(desk.discount ? [{ label: 'Discount', value: `− ${money(desk.discount)}`, tone: 'minus' as const }] : []),
    ...(desk.fee ? [{ label: 'Processing fee', value: `+ ${money(desk.fee)}` }] : []),
  ]

  return (
    <section style={s.card} aria-label="Desk view of the fare">
      <header style={s.head}>
        <span style={s.title}><span style={s.dot} aria-hidden="true" />Desk view</span>
        <span style={s.note}>Visible to the travel desk only</span>
      </header>

      <dl style={s.list}>
        {lines.map(l => (
          <div key={l.label} style={s.row}>
            <dt style={s.label}>{l.label}</dt>
            <dd style={{ ...s.value, ...(l.tone === 'minus' ? s.minus : {}) }}>{l.value}</dd>
          </div>
        ))}
      </dl>

      <dl style={{ ...s.list, ...s.totals }}>
        <div style={s.row}>
          <dt style={s.totalLabel}>Client pays</dt>
          <dd style={s.totalValue}>{money(desk.sellTotal)}</dd>
        </div>
        <div style={s.row}>
          <dt style={s.label}>
            TMC margin
            <span style={s.pct}>{marginPct.toFixed(1)}%</span>
          </dt>
          <dd style={{ ...s.value, ...s.marginValue, ...(desk.margin < 0 ? s.loss : s.gain) }}>
            {desk.margin < 0 ? '− ' : ''}{money(desk.margin)}
          </dd>
        </div>
      </dl>
    </section>
  )
}

const s: Record<string, React.CSSProperties> = {
  card: {
    marginTop: 16, padding: '14px 16px 12px', background: '#FBFAFF',
    border: '1px solid #E9E5F8', borderRadius: 10, fontVariantNumeric: 'tabular-nums',
  },
  head: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap',
    paddingBottom: 10, marginBottom: 8, borderBottom: '1px solid #EEEAF8',
  },
  title: {
    display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 11, fontWeight: 700,
    letterSpacing: '0.6px', textTransform: 'uppercase', color: '#4C1D95',
  },
  dot: { width: 6, height: 6, borderRadius: '50%', background: '#7C3AED' },
  note: { fontSize: 11.5, color: '#8B86A3' },

  list: { margin: 0, display: 'flex', flexDirection: 'column', gap: 6 },
  row: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 16 },
  label: { margin: 0, fontSize: 13, color: '#6B7280', display: 'inline-flex', alignItems: 'baseline', gap: 8 },
  value: { margin: 0, fontSize: 13, color: '#1F2937', fontWeight: 500, whiteSpace: 'nowrap' },
  minus: { color: '#047857' },

  totals: { marginTop: 10, paddingTop: 10, borderTop: '1px solid #E9E5F8' },
  totalLabel: { margin: 0, fontSize: 13.5, fontWeight: 600, color: '#111827' },
  totalValue: { margin: 0, fontSize: 13.5, fontWeight: 700, color: '#111827', whiteSpace: 'nowrap' },
  pct: { fontSize: 11, fontWeight: 600, color: '#6D28D9', background: '#F1ECFE', borderRadius: 999, padding: '1px 7px' },
  marginValue: { fontWeight: 700 },
  gain: { color: '#5B21B6' },
  loss: { color: '#B91C1C' },
}
