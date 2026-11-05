import { describe, it, expect, beforeAll, vi } from 'vitest'
import { POST as addPassengerPost } from '@/app/api/book/add-passenger/route'
import { PATCH as bookingPatch } from '@/app/api/book/[bookingId]/route'
import { call } from '../harness/call'
import { actors } from '../harness/actors'
import { resetDatabase } from '../harness/db'
import { db } from '@/app/lib/db'
import { sql, one, exec } from '@/app/lib/db/sql'

// ── A name the airline would refuse never reaches it ─────────────────────────
// On 2026-11-05 eight bookings failed at the last step, with no reason given,
// because the passenger's last name was "00003". Both ways a name reaches the
// airline (adding passengers, and correcting them before booking) now refuse
// it first, saying which traveller and which field, and the provider is not
// called at all.
// ─────────────────────────────────────────────────────────────────────────────

const h = vi.hoisted(() => ({ addPassenger: vi.fn() }))
vi.mock('@/app/lib/amadeus/client', async orig => {
  const actual = await orig<typeof import('@/app/lib/amadeus/client')>()
  return { ...actual, amadeus: { ...actual.amadeus, addPassenger: (...a: unknown[]) => h.addPassenger(...a) } }
})

const HAS_DB = Boolean(process.env.DATABASE_URL)
const d = HAS_DB ? describe : describe.skip

const pax = (LastName: string) => ({
  Title: 'MR', FirstName: 'Admin', MiddleName: 'Demo Client', LastName, PaxType: 'ADT', DateOfBirth: '29/09/1990',
})

d('passenger names before the airline', () => {
  let owner: { id: string }

  beforeAll(async () => {
    await resetDatabase()
    owner = { id: (await actors()).corpAdmin.id }
  })

  it('add-passenger: digits in a name are refused with the reason, and the airline is not called', async () => {
    const res = await call(addPassengerPost, {
      as: owner, method: 'POST', url: '/api/book/add-passenger',
      body: {
        key: 'K', pricingKey: 'PK', provider: '1A', referenceNo: 'ARRF1', totalFare: 9872,
        customerInfo: { Email: 'a@b.test', Mobile: '9876543210', PassengerDetails: [pax('00003')] },
      },
    })
    expect(res).toEqual({
      status: 400,
      json: {
        passenger: 0, field: 'lastName', code: 'INVALID_PASSENGER_NAME',
        error: 'Last name “00003” contains digits. Airlines accept letters only: enter it exactly as on the passport or ID.',
      },
    })
    expect(h.addPassenger).not.toHaveBeenCalled()
  })

  it('correcting the passenger: held to the same rule', async () => {
    const { id } = await one<{ id: string }>(db, sql`
      select id from bookings where employee_id = ${owner.id} order by created_at, id limit 1`)
    await exec(db, sql`update bookings set status = 'approved', amadeus_key = 'K', provider_order_id = 'R' where id = ${id}`)
    const res = await call(bookingPatch, {
      as: owner, method: 'PATCH', url: `/api/book/${id}`, params: { bookingId: id },
      body: { customerInfo: { Email: 'a@b.test', Mobile: '9876543210', PassengerDetails: [pax("O'Brien")] } },
    })
    expect(res.status).toBe(400)
    expect(res.json).toMatchObject({ code: 'INVALID_PASSENGER_NAME', field: 'lastName' })
    expect(h.addPassenger).not.toHaveBeenCalled()
  })
})
