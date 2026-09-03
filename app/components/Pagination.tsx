// ── Pagination ───────────────────────────────────────────────────────────────
// "Showing 1–10 of 42" with prev/next.
//
// Renders nothing when everything fits on one page: a pager under a three-row
// table is chrome that tells the reader nothing they cannot already see.
// ─────────────────────────────────────────────────────────────────────────────

interface PaginationProps {
  page: number
  pageSize: number
  total: number
  onPageChange: (page: number) => void
  // Shown while a page change is in flight, so the arrows cannot be
  // double-clicked into a request storm.
  busy?: boolean
  // "travellers", "deal codes" — makes the count read as a sentence rather than
  // a bare number.
  noun?: string
}

export default function Pagination({
  page, pageSize, total, onPageChange, busy = false, noun = 'results',
}: PaginationProps) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  if (total <= pageSize) return null

  const first = (page - 1) * pageSize + 1
  // Guards the last page, which is usually short: 41–50 of 42 would be a lie.
  const last = Math.min(page * pageSize, total)

  const atStart = page <= 1
  const atEnd = page >= totalPages

  return (
    <div style={s.root}>
      <span style={s.count}>
        Showing <strong style={s.strong}>{first}–{last}</strong> of {total} {noun}
      </span>

      <div style={s.controls}>
        <span style={s.pageOf}>Page {page} of {totalPages}</span>
        <button
          type="button"
          onClick={() => onPageChange(page - 1)}
          disabled={atStart || busy}
          style={{ ...s.btn, ...(atStart || busy ? s.btnOff : {}) }}
          aria-label="Previous page"
        >
          ← Prev
        </button>
        <button
          type="button"
          onClick={() => onPageChange(page + 1)}
          disabled={atEnd || busy}
          style={{ ...s.btn, ...(atEnd || busy ? s.btnOff : {}) }}
          aria-label="Next page"
        >
          Next →
        </button>
      </div>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  root: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    gap: 12, flexWrap: 'wrap', padding: '10px 2px 0',
  },
  count: { fontSize: 12, color: 'var(--color-secondary)', fontVariantNumeric: 'tabular-nums' },
  strong: { fontWeight: 600, color: 'var(--color-ink)' },
  controls: { display: 'flex', alignItems: 'center', gap: 8 },
  pageOf: { fontSize: 12, color: 'var(--color-secondary)', fontVariantNumeric: 'tabular-nums', marginRight: 2 },
  btn: {
    height: 30, padding: '0 11px', background: '#fff', color: '#374151',
    fontSize: 12, border: '1px solid var(--color-line-strong)', borderRadius: 6, cursor: 'pointer',
  },
  btnOff: { opacity: 0.45, cursor: 'not-allowed' },
}
