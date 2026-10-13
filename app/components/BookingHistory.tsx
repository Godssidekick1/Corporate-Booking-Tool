'use client'

import Pagination from '@/app/components/Pagination'
import { usePagedList } from '@/app/hooks/usePagedList'

// ── Booking history (GET /api/book/history) ──────────────────────────────────
// One table for every "bookings for other people" view: what the desk booked
// (/tmc/book), what a corporate admin booked for colleagues (My trips), and
// one person's bookings (Settings → Users). Sell-side, paged, newest first.
// `params` is the history query: { traveller }, { bookedBy: 'me' } or
// { scope: 'desk', clientId }.
// ─────────────────────────────────────────────────────────────────────────────

interface Itinerary { origin?: { code?: string; dateTime?: string }; destination?: { code?: string } }

interface HistoryRow {
  id: string; status: string; pnr: string | null; total_cost: number; created_at: string
  itinerary: Itinerary | null; employee_id: string; booked_by: string
  traveller_name: string | null; booker_name: string | null; client_name: string | null
  policy_reason_code: string | null
}

type Column = 'traveller' | 'client' | 'bookedBy'

const route = (i: Itinerary | null) =>
  i?.origin?.code && i?.destination?.code ? `${i.origin.code} → ${i.destination.code}` : 'Flight'
const day = (iso?: string) =>
  iso ? new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : ''
const money = (n: number) => `₹${Math.round(Number(n)).toLocaleString('en-IN')}`

export default function BookingHistory({ params, columns, empty }: {
  params: Record<string, string | null | undefined>
  columns: Column[]
  empty: string
}) {
  const list = usePagedList<HistoryRow>('/api/book/history', { params })
  const show = (c: Column) => columns.includes(c)

  return (
    <>
      <div style={{ ...s.wrap, ...(list.refreshing ? { opacity: 0.55 } : {}) }}>
        {list.error ? (
          <p style={s.error}>{list.error}</p>
        ) : list.loading ? (
          <p style={s.muted}>Loading…</p>
        ) : list.items.length === 0 ? (
          <p style={s.muted}>{empty}</p>
        ) : (
          <table style={s.table}>
            <thead>
              <tr>
                <th style={s.th}>Booked</th>
                {show('traveller') && <th style={s.th}>Traveller</th>}
                {show('client') && <th style={s.th}>Client</th>}
                <th style={s.th}>Trip</th>
                <th style={s.th}>Status</th>
                {show('bookedBy') && <th style={s.th}>Booked by</th>}
                <th style={{ ...s.th, textAlign: 'right' }}>Amount</th>
              </tr>
            </thead>
            <tbody>
              {list.items.map(b => (
                <tr key={b.id}>
                  <td style={s.td}>{day(b.created_at)}</td>
                  {show('traveller') && <td style={{ ...s.td, fontWeight: 500, color: '#111827' }}>{b.traveller_name}</td>}
                  {show('client') && <td style={s.td}>{b.client_name}</td>}
                  <td style={s.td}>
                    {route(b.itinerary)}
                    {b.itinerary?.origin?.dateTime && <span style={s.sub}> · {day(b.itinerary.origin.dateTime)}</span>}
                    {b.policy_reason_code && <span style={s.reason} title="Booked outside policy, with a reason">reason given</span>}
                  </td>
                  <td style={s.td}><span style={s.status}>{b.status.replace(/_/g, ' ')}</span></td>
                  {show('bookedBy') && (
                    <td style={s.td}>{b.booked_by === b.employee_id ? <span style={s.sub}>Themself</span> : b.booker_name}</td>
                  )}
                  <td style={{ ...s.td, textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: '#111827' }}>{money(b.total_cost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <Pagination page={list.page} pageSize={10} total={list.total} onPageChange={list.setPage} busy={list.refreshing} noun="bookings" />
    </>
  )
}

const s: Record<string, React.CSSProperties> = {
  wrap: { background: '#fff', border: '1px solid #E5E7EB', borderRadius: 10, overflowX: 'auto', transition: 'opacity 120ms ease' },
  table: { width: '100%', borderCollapse: 'collapse', minWidth: 560 },
  th: { textAlign: 'left', fontSize: 11, fontWeight: 600, color: '#6B7280', padding: '10px 14px', borderBottom: '1px solid #E5E7EB', background: '#FAFAFA' },
  td: { fontSize: 12.5, color: '#374151', padding: '10px 14px', borderBottom: '1px solid #F3F4F6' },
  sub: { color: '#9CA3AF' },
  status: { fontSize: 11, textTransform: 'capitalize', color: '#374151', background: '#F3F4F6', borderRadius: 4, padding: '1px 7px' },
  reason: { marginLeft: 8, fontSize: 10.5, color: '#92400E', background: '#FEF3C7', borderRadius: 4, padding: '1px 6px' },
  muted: { fontSize: 12.5, color: '#9CA3AF', margin: 0, padding: 16 },
  error: { fontSize: 12.5, color: '#DC2626', margin: 0, padding: 16 },
}
