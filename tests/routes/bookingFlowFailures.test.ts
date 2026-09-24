import { describe, it, expect, beforeAll, vi } from 'vitest'
import { POST as bookPost } from '@/app/api/book/booking/route'
import { POST as ticketPost } from '@/app/api/book/ticket/route'
import { call } from '../harness/call'
import { actors } from '../harness/actors'
import { resetDatabase } from '../harness/db'
import { db } from '@/app/lib/db'
import { sql, one, exec } from '@/app/lib/db/sql'

// ── The airline confirmed, and we could not record it ────────────────────────
// The one failure on the booking path no transaction can undo: the PNR or the
// ticket exists at the airline. Our save failing must NOT read as "booking
// failed" -- the traveller has to be handed the airline's reference or ticket
// numbers, with a warning, so support can reconcile.
//
// Repositories throw on failure, so this is the path that changed shape when
// the routes left the shim. Forced here by making the status writes throw.
// ─────────────────────────────────────────────────────────────────────────────

vi.mock('@/app/lib/amadeus/client', async orig => {
  const actual = await orig<typeof import('@/app/lib/amadeus/client')>()
  return {
    ...actual,
    amadeus: {
      ...actual.amadeus,
      booking: async () => ({ ReferenceNo: 'R-CONFIRMED', AirBookingResponse: [{ PNR: 'PNR777' }] }),
      ticket: async () => ({ AirBookingResponse: [{ PNR: 'PNR777', CustomerInfo: { PassengerDetails: [{ TicketNo: 'T777' }] } }] }),
    },
  }
})

vi.mock('@/app/lib/repositories/bookings', async orig => {
  const actual = await orig<typeof import('@/app/lib/repositories/bookings')>()
  const down = async () => { throw new Error('connection terminated unexpectedly') }
  return { ...actual, markHeld: down, markTicketed: down }
})

const HAS_DB = Boolean(process.env.DATABASE_URL)
const d = HAS_DB ? describe : describe.skip

d('airline confirmed, save failed', () => {
  let owner: { id: string }
  let bookingId: string

  beforeAll(async () => {
    await resetDatabase()
    const a = await actors()
    owner = { id: a.corpAdmin.id }
    bookingId = (await one<{ id: string }>(db, sql`
      select id from bookings where employee_id = ${owner.id} and status = 'held' order by created_at, id limit 1`)).id
  })

  it('book: the reference is still returned, with a warning', async () => {
    await exec(db, sql`
      update bookings set status = 'approved', amadeus_key = 'K', provider_order_id = 'R', provider = 'test'
      where id = ${bookingId}`)
    const res = await call(bookPost, { as: owner, method: 'POST', url: '/api/book/booking', body: { bookingId } })
    expect(res.status).toBe(200)
    expect(res.json).toMatchObject({ ok: true, bookingId, referenceNo: 'R-CONFIRMED', status: 'held' })
    expect((res.json as { warning: string }).warning).toMatch(/^Booking confirmed but there was an issue saving it/)
  })

  it('ticket: the ticket numbers are still returned, with a warning', async () => {
    await exec(db, sql`
      update bookings set status = 'held', amadeus_key = 'K', provider_order_id = 'R', pricing_key = 'PK',
        provider = 'test'
      where id = ${bookingId}`)
    const res = await call(ticketPost, { as: owner, method: 'POST', url: '/api/book/ticket', body: { bookingId } })
    expect(res.status).toBe(200)
    expect(res.json).toMatchObject({ ok: true, bookingId, pnr: 'PNR777', ticketNumbers: ['T777'], status: 'ticketed' })
    expect((res.json as { warning: string }).warning).toMatch(/^Ticket issued but there was an issue saving it/)
  })
})
