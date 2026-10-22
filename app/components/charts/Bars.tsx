'use client'

// ── Small bar charts, drawn with plain elements ──────────────────────────────
// The product's charts are few and simple (a series over months, a ranking),
// so they are divs rather than a charting library: the same look as the TMC
// dashboard's weekly trend, readable without JavaScript, and printable.
//
//   BarSeries  vertical bars along a time axis (a month, a week)
//   BarList    horizontal bars ranking named things (departments, airlines)
// Each bar carries its value as text and as a title, so nothing is only a
// height.
// ─────────────────────────────────────────────────────────────────────────────

export interface SeriesPoint { label: string; value: number }

export function BarSeries({ points, format = String, height = 120 }: {
  points: SeriesPoint[]
  format?: (n: number) => string
  height?: number
}) {
  const peak = Math.max(1, ...points.map(p => p.value))
  if (points.length === 0) return <p style={s.empty}>Nothing to chart yet.</p>
  return (
    <div style={s.series} role="img" aria-label={points.map(p => `${p.label}: ${format(p.value)}`).join(', ')}>
      {points.map(p => (
        <div key={p.label} style={s.col} title={`${p.label}: ${format(p.value)}`}>
          <span style={s.value}>{format(p.value)}</span>
          <div style={{ ...s.track, height }}>
            <div style={{ ...s.bar, height: `${(p.value / peak) * 100}%` }} />
          </div>
          <span style={s.label}>{p.label}</span>
        </div>
      ))}
    </div>
  )
}

export function BarList({ items, format = String, max = 8 }: {
  items: SeriesPoint[]
  format?: (n: number) => string
  max?: number
}) {
  const shown = items.slice(0, max)
  const peak = Math.max(1, ...shown.map(p => p.value))
  if (shown.length === 0) return <p style={s.empty}>Nothing to chart yet.</p>
  return (
    <div style={s.list}>
      {shown.map(p => (
        <div key={p.label} style={s.row} title={`${p.label}: ${format(p.value)}`}>
          <span style={s.rowLabel}>{p.label}</span>
          <div style={s.rowTrack}>
            <div style={{ ...s.rowBar, width: `${(p.value / peak) * 100}%` }} />
          </div>
          <span style={s.rowValue}>{format(p.value)}</span>
        </div>
      ))}
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  empty: { fontSize: 12, color: '#9CA3AF', margin: '8px 0' },
  series: { display: 'flex', alignItems: 'flex-end', gap: 10, overflowX: 'auto', paddingBottom: 2 },
  col: { flex: '1 0 44px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, minWidth: 44 },
  value: { fontSize: 10.5, fontWeight: 600, color: '#374151', whiteSpace: 'nowrap' },
  track: { width: '100%', maxWidth: 40, display: 'flex', alignItems: 'flex-end', background: '#F3F4F6', borderRadius: 4 },
  bar: { width: '100%', background: '#000835', borderRadius: 4, minHeight: 2 },
  label: { fontSize: 10.5, color: '#6B7280', whiteSpace: 'nowrap' },

  list: { display: 'flex', flexDirection: 'column', gap: 8 },
  row: { display: 'grid', gridTemplateColumns: 'minmax(90px, 30%) 1fr auto', alignItems: 'center', gap: 10 },
  rowLabel: { fontSize: 12, color: '#374151', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  rowTrack: { height: 10, background: '#F3F4F6', borderRadius: 5, overflow: 'hidden' },
  rowBar: { height: '100%', background: '#000835', borderRadius: 5, minWidth: 2 },
  rowValue: { fontSize: 12, fontWeight: 600, color: '#111827', whiteSpace: 'nowrap' },
}
