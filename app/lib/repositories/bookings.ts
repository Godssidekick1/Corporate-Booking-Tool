import { sql, many, one, type Queryable } from '@/app/lib/db/sql'
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

export async function countForClients(db: Queryable, clientIds: readonly string[]): Promise<number> {
  if (clientIds.length === 0) return 0
  const row = await one<{ n: number }>(db, sql`
    select count(*)::int as n from bookings where client_id = any(${[...clientIds]})`)
  return row.n
}

// Bookings per traveller at a client, for the people on one roster page.
export async function tripCounts(
  db: Queryable,
  clientId: string,
  employeeIds: readonly string[]
): Promise<Map<string, number>> {
  if (employeeIds.length === 0) return new Map()
  const rows = await many<{ employee_id: string; n: number }>(db, sql`
    select employee_id, count(*)::int as n from bookings
    where client_id = ${clientId} and employee_id = any(${[...employeeIds]})
    group by employee_id`)
  return new Map(rows.map(r => [r.employee_id, r.n]))
}
