import type { DeskView } from '@/app/lib/commercials/deskView'

// ── How the price is made, for the travel desk ───────────────────────────────
// Rendered only when the server sent `desk`, which it does for TMC staff
// booking for someone and for nobody else (app/lib/commercials/deskView.ts).
// The traveller's own pages never receive the figures, so there is nothing
// here to hide from them.
// ─────────────────────────────────────────────────────────────────────────────

export default function DeskFareStrip({ desk, currency = 'INR' }: { desk: DeskView | null | undefined; currency?: string }) {
  if (!desk) return null
  const money = (n: number) => `${currency} ${Math.round(n).toLocaleString('en-IN')}`
  const parts: [string, string][] = [
    ['Airline fare', money(desk.airlineTotal)],
    ['Markup', money(desk.markup)],
    ...(desk.discount ? [['Discount', `− ${money(desk.discount)}`] as [string, string]] : []),
    ...(desk.fee ? [['Fee', money(desk.fee)] as [string, string]] : []),
    ['Client pays', money(desk.sellTotal)],
    ['Margin', money(desk.margin)],
  ]
  return (
    <div style={s.strip} aria-label="Desk view of the fare">
      <span style={s.tag}>Desk view</span>
      {parts.map(([label, value]) => (
        <span key={label} style={s.part}>
          <span style={s.label}>{label}</span> <strong style={s.value}>{value}</strong>
        </span>
      ))}
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  strip: {
    display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px 16px', margin: '12px 0 0', padding: '10px 12px',
    background: '#F5F3FF', border: '1px solid #DDD6FE', borderRadius: 8, fontSize: 12,
  },
  tag: { fontSize: 10, fontWeight: 700, letterSpacing: '0.5px', textTransform: 'uppercase', color: '#5B21B6' },
  part: { color: '#4C1D95' },
  label: { color: '#6D28D9' },
  value: { color: '#2E1065', fontWeight: 700 },
}
