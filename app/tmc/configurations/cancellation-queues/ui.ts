import type React from 'react'

// ── Cancellation queues: shared look and wording ─────────────────────────────
// The queue page and the refund panel use the same pills, money format and
// table style as the other configuration screens (Deal codes, Buckets).
// ─────────────────────────────────────────────────────────────────────────────

export type QueueState = 'cancel_requested' | 'pending' | 'processed' | 'rejected'

export const STATE_META: Record<QueueState, { label: string; color: string; bg: string }> = {
  cancel_requested: { label: 'Awaiting airline', color: '#92400E', bg: '#FEF3C7' },
  pending:          { label: 'Refund pending',   color: '#1E40AF', bg: '#DBEAFE' },
  processed:        { label: 'Refunded',         color: '#166534', bg: '#DCFCE7' },
  rejected:         { label: 'Rejected',         color: '#991B1B', bg: '#FEE2E2' },
}

export const MODE_LABELS: Record<string, string> = {
  corporate_card: 'Back to the corporate card',
  agency_credit: 'Credit to the client’s account with the TMC',
  traveller_card: 'Back to the traveller’s card',
  other: 'Other (see the remark)',
}

// ₹ with paise when there are any, grouped the Indian way.
export function money(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return '—'
  const v = Number(n)
  const abs = Math.abs(v).toLocaleString('en-IN', { minimumFractionDigits: Number.isInteger(v) ? 0 : 2, maximumFractionDigits: 2 })
  return `${v < 0 ? '−' : ''}₹${abs}`
}

export function dateOnly(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso)
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
}

export function dateTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
}

export const s: Record<string, React.CSSProperties> = {
  root: { paddingBottom: 60 },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap', marginBottom: 16 },
  title: { fontSize: 20, fontWeight: 600, color: 'var(--color-ink)', margin: '0 0 4px', letterSpacing: '-0.3px' },
  sub: { fontSize: 13, color: 'var(--color-secondary)', margin: 0, lineHeight: 1.6, maxWidth: 680 },
  actions: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' },
  filters: { display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' },
  input: { height: 36, padding: '0 10px', fontSize: 13, color: '#111827', background: '#fff', border: '1px solid var(--color-line-strong)', borderRadius: 7, outline: 'none' },
  label: { fontSize: 11, fontWeight: 600, color: 'var(--color-secondary)', textTransform: 'uppercase', letterSpacing: '0.5px' },
  field: { display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 14 },
  dimmed: { opacity: 0.55, transition: 'opacity 120ms ease' },

  tableWrap: { background: '#fff', border: '1px solid var(--color-line)', borderRadius: 10, overflowX: 'auto' },
  table: { borderCollapse: 'collapse', width: '100%' },
  th: { padding: '10px 14px', textAlign: 'left', background: '#F9FAFB', borderBottom: '1px solid var(--color-line)', fontSize: 11, fontWeight: 600, color: '#374151', whiteSpace: 'nowrap' },
  tr: { borderBottom: '1px solid #F3F4F6' },
  td: { padding: '9px 14px', fontSize: 13, color: 'var(--color-body)', verticalAlign: 'middle', whiteSpace: 'nowrap' },
  tdSub: { display: 'block', fontSize: 11.5, color: 'var(--color-secondary)', marginTop: 2 },
  mono: { fontFamily: 'var(--font-mono)' },
  num: { fontVariantNumeric: 'tabular-nums', textAlign: 'right' },
  code: { fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 600, color: '#111827', background: '#F3F4F6', borderRadius: 4, padding: '2px 7px' },
  pill: { display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 600, borderRadius: 999, padding: '2px 9px' },

  empty: { background: '#fff', border: '1px dashed var(--color-line-strong)', borderRadius: 10, padding: '28px 22px', textAlign: 'center' },
  emptyTitle: { fontSize: 14, fontWeight: 600, color: 'var(--color-ink)', margin: '0 0 5px' },
  emptyDesc: { fontSize: 12, color: 'var(--color-secondary)', margin: 0, lineHeight: 1.6 },
  hint: { fontSize: 12, color: 'var(--color-secondary)', lineHeight: 1.55, margin: '4px 0 0' },
  errorBanner: { background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8, padding: '10px 14px', fontSize: 12, color: '#DC2626', marginBottom: 14 },
  successBanner: { background: '#ECFDF5', border: '1px solid #A7F3D0', borderRadius: 8, padding: '10px 14px', fontSize: 12, color: '#065F46', marginBottom: 14 },
  warnBanner: { background: '#FFFBEB', border: '1px solid #FDE68A', borderRadius: 8, padding: '10px 14px', fontSize: 12, color: '#92400E', marginBottom: 14 },

  primaryBtn: { height: 32, padding: '0 14px', background: 'var(--color-rail)', color: '#fff', fontSize: 12, fontWeight: 600, border: 'none', borderRadius: 6, cursor: 'pointer', textDecoration: 'none', display: 'inline-flex', alignItems: 'center' },
  ghostBtn: { height: 30, padding: '0 11px', background: '#fff', color: '#374151', fontSize: 12, border: '1px solid var(--color-line-strong)', borderRadius: 6, cursor: 'pointer', textDecoration: 'none', display: 'inline-flex', alignItems: 'center' },
  dangerBtn: { height: 32, padding: '0 12px', background: '#fff', color: '#DC2626', fontSize: 12, border: '1px solid #FECACA', borderRadius: 6, cursor: 'pointer' },
  linkBtn: { background: 'none', border: 'none', padding: 0, color: 'var(--color-info-fg)', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', textDecoration: 'none' },
}
