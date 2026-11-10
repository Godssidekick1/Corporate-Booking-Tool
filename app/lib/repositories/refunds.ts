import { sql, exec, type Queryable } from '@/app/lib/db/sql'

// ── Refunds (20261110000000_refunds) ─────────────────────────────────────────
// One row per cancelled passenger ticket. Created 'pending' when a ticketed
// booking is cancelled (POST /api/book/[bookingId]/cancel), in the same
// transaction as the cancellation itself, so a cancelled ticket can never be
// missing from the queue. Processed or rejected by the TMC from
// Configurations → Queues → Cancellation queues.
// ─────────────────────────────────────────────────────────────────────────────

// One pending refund per passenger of a ticketed booking; ticket numbers by
// the same index as traveler_snapshot.PassengerDetails. A booking cancelled
// again (or both cancelled and confirmed) does not get a second set.
export async function createForBooking(db: Queryable, bookingId: string): Promise<number> {
  return exec(db, sql`
    insert into refunds (client_id, booking_id, passenger_index, ticket_number)
    select b.client_id, b.id, p.idx - 1, b.ticket_numbers[p.idx]
      from bookings b
      cross join lateral generate_series(1, greatest(1,
        jsonb_array_length(coalesce(b.traveler_snapshot -> 'PassengerDetails', '[]'::jsonb)))) as p(idx)
     where b.id = ${bookingId}
    on conflict (booking_id, passenger_index) do nothing`)
}
