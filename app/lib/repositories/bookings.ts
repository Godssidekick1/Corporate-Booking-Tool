import { sql, many, type Queryable } from '@/app/lib/db/sql'
import type { Row } from '@/app/lib/db/types.generated'

// ── Bookings and price quotes ────────────────────────────────────────────────
// Owns: bookings, price_quotes.
//
// Read together on every ticketing request, which is why they share a module:
// a quote is the server-side record of what a booking was priced at, and the
// booking cannot be finalised without it.
// ─────────────────────────────────────────────────────────────────────────────

export type BookingStatRow = Pick<Row<'bookings'>, 'id' | 'client_id' | 'total_cost' | 'status' | 'created_at'>

// Everything the TMC dashboard aggregates, for a set of clients. The route
// aggregates in TypeScript (weekly buckets, last-30-days) so the date maths
// stays in one place.
export async function statRows(db: Queryable, clientIds: readonly string[]): Promise<BookingStatRow[]> {
  if (clientIds.length === 0) return []
  return many<BookingStatRow>(db, sql`
    select id, client_id, total_cost, status, created_at from bookings
    where client_id = any(${[...clientIds]})
    order by created_at, id`)
}
