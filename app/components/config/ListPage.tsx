import type React from 'react'

// ── The list page layout (Configurations) ────────────────────────────────────
// One simple shape for every list screen, taken from the commercials rules
// page: a title and one line of what the screen is for, with its main action
// on the right; one row of filters; a full-width table that shows results
// straight away (no "pick something first"), each row opening its detail;
// pagination underneath. Traveller profiles, Cost centres, Corporate
// settings, Client groups and Users (TCs) are built from these pieces, so
// they look and behave the same.
// ─────────────────────────────────────────────────────────────────────────────

export function ListHeader({ title, description, actions }: {
  title: string
  description?: React.ReactNode
  actions?: React.ReactNode
}) {
  return (
    <div style={list.header}>
      <div style={{ minWidth: 0 }}>
        <h1 style={list.title}>{title}</h1>
        {description && <p style={list.sub}>{description}</p>}
      </div>
      {actions && <div style={list.actions}>{actions}</div>}
    </div>
  )
}

export function ListFilters({ children }: { children: React.ReactNode }) {
  return <div style={list.filters}>{children}</div>
}

export function ListEmpty({ title, description }: { title: string; description?: React.ReactNode }) {
  return (
    <div style={list.empty}>
      <p style={list.emptyTitle}>{title}</p>
      {description && <p style={list.emptyDesc}>{description}</p>}
    </div>
  )
}

// The styles behind those pieces, and the table's, for pages to use directly.
export const list: Record<string, React.CSSProperties> = {
  root: { paddingBottom: 60 },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap', marginBottom: 16 },
  title: { fontSize: 20, fontWeight: 600, color: '#0A0A14', margin: '0 0 4px', letterSpacing: '-0.3px' },
  sub: { fontSize: 13, color: '#6B7280', margin: 0, lineHeight: 1.6, maxWidth: 680 },
  actions: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' },

  filters: { display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' },
  input: { height: 36, padding: '0 10px', fontSize: 13, color: '#111827', background: '#fff', border: '1px solid #D1D5DB', borderRadius: 7, outline: 'none', boxSizing: 'border-box' },
  search: { height: 36, padding: '0 10px', fontSize: 13, color: '#111827', background: '#fff', border: '1px solid #D1D5DB', borderRadius: 7, outline: 'none', boxSizing: 'border-box', flex: '1 1 220px', minWidth: 180, maxWidth: 360 },
  picker: { width: 260 },
  check: { display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 12.5, color: '#374151', cursor: 'pointer', height: 36 },

  tableWrap: { border: '1px solid #E5E7EB', borderRadius: 8, overflowX: 'auto', background: '#fff' },
  table: { borderCollapse: 'collapse', width: '100%' },
  th: { padding: '8px 10px', textAlign: 'left', background: '#F9FAFB', borderBottom: '1px solid #E5E7EB', fontSize: 10.5, fontWeight: 600, color: '#374151', whiteSpace: 'nowrap' },
  td: { padding: '9px 10px', fontSize: 12.5, color: '#374151', borderBottom: '1px solid #F3F4F6', whiteSpace: 'nowrap' },
  row: { cursor: 'pointer' },
  name: { fontWeight: 600, color: '#111827' },
  sublabel: { display: 'block', fontSize: 11, color: '#9CA3AF', marginTop: 1 },
  mono: { fontFamily: 'var(--font-mono)' },
  muted: { color: '#9CA3AF' },
  num: { textAlign: 'right', fontVariantNumeric: 'tabular-nums' },
  pill: { display: 'inline-block', fontSize: 10, fontWeight: 600, borderRadius: 4, padding: '1px 6px' },
  dimmed: { opacity: 0.55, transition: 'opacity 120ms ease' },

  empty: { background: '#fff', border: '1px dashed #D1D5DB', borderRadius: 10, padding: '22px 18px', textAlign: 'center' },
  emptyTitle: { fontSize: 13, fontWeight: 600, color: '#111827', margin: '0 0 5px' },
  emptyDesc: { fontSize: 12, color: '#6B7280', margin: 0, lineHeight: 1.6 },

  errorBanner: { background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8, padding: '10px 14px', fontSize: 12, color: '#DC2626', marginBottom: 14 },
  successBanner: { background: '#ECFDF5', border: '1px solid #A7F3D0', borderRadius: 8, padding: '10px 14px', fontSize: 12, color: '#065F46', marginBottom: 14 },
  warnBanner: { background: '#FFFBEB', border: '1px solid #FDE68A', borderRadius: 8, padding: '10px 14px', fontSize: 12, color: '#92400E', marginBottom: 14 },

  primaryBtn: { height: 34, padding: '0 14px', background: '#000835', color: '#fff', fontSize: 12.5, fontWeight: 600, border: 'none', borderRadius: 7, cursor: 'pointer' },
  ghostBtn: { height: 34, padding: '0 12px', background: '#fff', color: '#374151', fontSize: 12.5, border: '1px solid #D1D5DB', borderRadius: 7, cursor: 'pointer' },
  dangerBtn: { height: 34, padding: '0 12px', background: '#fff', color: '#DC2626', fontSize: 12.5, border: '1px solid #FECACA', borderRadius: 7, cursor: 'pointer' },
}
