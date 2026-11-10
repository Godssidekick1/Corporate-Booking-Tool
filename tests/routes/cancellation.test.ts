import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { POST as cancelPost } from '@/app/api/book/[bookingId]/cancel/route'
import { GET as bookingGet } from '@/app/api/book/[bookingId]/route'
import { AmadeusError } from '@/app/lib/amadeus/client'
import { call } from '../harness/call'
import { actors, type Actors } from '../harness/actors'
import { resetDatabase } from '../harness/db'
import { db } from '@/app/lib/db'
import { sql, one, many, exec } from '@/app/lib/db/sql'

// ── Cancelling a booking ─────────────────────────────────────────────────────
// Amadeus is FAKED (never the real API: a cancellation is real at the
// airline). What these pin: who may cancel, which statuses go to the provider
// and which are withdrawn here, that one booking is cancelled once, what each
// person is shown of the money, and that an accepted cancellation the
// database failed to record is still reported as done.
// ─────────────────────────────────────────────────────────────────────────────

const h = vi.hoisted(() => ({
  cancelBooking: vi.fn(),
  failRecord: false,
}))

vi.mock('@/app/lib/amadeus/client', async orig => {
  const actual = await orig<typeof import('@/app/lib/amadeus/client')>()
  return { ...actual, amadeus: { ...actual.amadeus, cancelBooking: (...a: unknown[]) => h.cancelBooking(...a) } }
})

vi.mock('@/app/lib/repositories/bookings', async orig => {
  const actual = await orig<typeof import('@/app/lib/repositories/bookings')>()
  return {
    ...actual,
    recordCancellation: async (...a: Parameters<typeof actual.recordCancellation>) => {
      if (h.failRecord) throw new Error('connection terminated unexpectedly')
      return actual.recordCancellation(...a)
    },
  }
})

const HAS_DB = Boolean(process.env.DATABASE_URL)
const d = HAS_DB ? describe : describe.skip

// As documented: a held booking, cancelled at once, no money.
const HELD_ANSWER = {
  Status: 'Success', Key: 'ARRF1', ClientCode: 'C', ReferenceNo: 'ARRF1', ChangeRequestId: '',
  CancelStatus: 'cancelled', Remarks: 'cancelled', ErrorCode: null, ErrorMessage: null,
  RefundedAmount: 0, CancellationCharge: 0, ServiceTaxOnRAF: 0, ChangeRequestStatus: 'cancelled',
  TrackIds: '20261105033619', TicketIndex: null, TransactionID: '8PEAO4', Error: null,
}
// A ticketed booking: the airline keeps a charge, the refund settles later.
const TICKETED_ANSWER = {
  ...HELD_ANSWER, CancelStatus: 'requested', ChangeRequestStatus: 'pending', ChangeRequestId: 'CR-77',
  RefundedAmount: 8200, CancellationCharge: 3000, ServiceTaxOnRAF: 540,
}

d('booking cancellation', () => {
  let a: Actors
  let owner: { id: string }
  let ids: string[]

  const cancel = (as: { id: string } | null, bookingId: string, body: unknown = {}) =>
    call(cancelPost, { as, method: 'POST', url: `/api/book/${bookingId}/cancel`, body, params: { bookingId } })
  const view = (as: { id: string }, bookingId: string) =>
    call(bookingGet, { as, url: `/api/book/${bookingId}`, params: { bookingId } })
  const row = (id: string) => one<Record<string, unknown>>(db, sql`
    select status, cancelled_at, cancelled_by, cancellation_reason, cancellation, cancel_started_at
    from bookings where id = ${id}`)
  const setStatus = (id: string, status: string) => exec(db, sql`
    update bookings set status = ${status}, provider_order_id = 'ARRF-' || left(id::text, 6),
      cancelled_at = null, cancelled_by = null, cancellation_reason = null, cancellation = null,
      cancel_started_at = null
    where id = ${id}`)

  beforeAll(async () => {
    await resetDatabase()
    a = await actors()
    owner = { id: a.corpAdmin.id }
    ids = (await many<{ id: string }>(db, sql`
      select id from bookings where employee_id = ${owner.id} order by created_at, id limit 4`)).map(r => r.id)
    expect(ids).toHaveLength(4)
  })

  beforeEach(() => {
    h.cancelBooking.mockReset()
    h.failRecord = false
  })

  it('a held booking: sent to the provider with its ReferenceNo, then recorded as cancelled', async () => {
    await setStatus(ids[0], 'held')
    h.cancelBooking.mockResolvedValue(HELD_ANSWER)
    const res = await cancel(owner, ids[0], { reason: 'Meeting moved' })
    expect(res.status).toBe(200)
    expect(res.json).toMatchObject({
      ok: true, status: 'cancelled', cancellation: { charges: 0, refund: 'none', reason: 'Meeting moved' },
    })
    expect(h.cancelBooking).toHaveBeenCalledWith(`ARRF-${ids[0].slice(0, 6)}`, 'Meeting moved')
    const r = await row(ids[0])
    expect(r).toMatchObject({ status: 'cancelled', cancelled_by: owner.id, cancellation_reason: 'Meeting moved', cancel_started_at: null })
    expect(r.cancellation).toMatchObject({ cancelStatus: 'cancelled', transactionId: '8PEAO4', wasTicketed: false })
    const audit = await one<{ n: number }>(db, sql`
      select count(*)::int as n from audit_log where action = 'booking.cancelled' and entity_id = ${ids[0]}`)
    expect(audit.n).toBe(1)
  })

  it('cancelled twice: the second is refused without calling the provider', async () => {
    const res = await cancel(owner, ids[0])
    expect(res).toMatchObject({ status: 409, json: { code: 'ALREADY_CANCELLED' } })
    expect(h.cancelBooking).not.toHaveBeenCalled()
  })

  it('a ticketed booking: the traveller sees the charges and "processing", never the refund', async () => {
    await setStatus(ids[1], 'ticketed')
    h.cancelBooking.mockResolvedValue(TICKETED_ANSWER)
    const res = await cancel(owner, ids[1])
    expect(res.status).toBe(200)
    // The provider has not said "cancelled": requested, settled later.
    expect(res.json).toMatchObject({ status: 'cancel_requested', cancellation: { charges: 3540, refund: 'processing' } })
    expect(h.cancelBooking).toHaveBeenCalledWith(expect.any(String), 'Cancelled by the traveller')
    expect(JSON.stringify(res.json)).not.toMatch(/8200|refundedAmount|provider/)

    const page = await view(owner, ids[1])
    expect(page.status).toBe(200)
    const shown = (page.json as { booking: { cancellation: unknown } }).booking.cancellation
    expect(shown).toMatchObject({ charges: 3540, refund: 'processing', cancelledByName: expect.any(String) })
    expect(JSON.stringify(page.json)).not.toMatch(/8200|refundedAmount|CR-77/)
    expect((await row(ids[1])).status).toBe('cancel_requested')
  })

  it('a ticketed cancellation queues one refund per passenger; a held one queues none', async () => {
    const queued = (id: string) => many<{ passenger_index: number; status: string }>(db, sql`
      select passenger_index, status from refunds where booking_id = ${id} order by passenger_index`)
    const passengers = await one<{ n: number }>(db, sql`
      select greatest(1, jsonb_array_length(coalesce(traveler_snapshot -> 'PassengerDetails', '[]'::jsonb)))::int as n
      from bookings where id = ${ids[1]}`)
    const rows = await queued(ids[1])
    expect(rows).toHaveLength(passengers.n)
    expect(rows.every(r => r.status === 'pending')).toBe(true)
    expect(await queued(ids[0])).toEqual([])
  })

  it('the travel desk sees everything the provider said', async () => {
    const page = await view({ id: a.tmcAdmin.id }, ids[1])
    expect(page.status).toBe(200)
    expect((page.json as { booking: { cancellation: unknown } }).booking.cancellation).toMatchObject({
      charges: 3540, refund: 'processing',
      provider: { refundedAmount: 8200, cancellationCharge: 3000, serviceTaxOnRaf: 540, changeRequestId: 'CR-77' },
    })
  })

  it('the desk can cancel for the traveller, and its reason goes to the provider', async () => {
    await setStatus(ids[2], 'held')
    h.cancelBooking.mockResolvedValue(HELD_ANSWER)
    const res = await cancel({ id: a.tmcAdmin.id }, ids[2])
    expect(res).toMatchObject({ status: 200, json: { status: 'cancelled' } })
    expect(h.cancelBooking).toHaveBeenCalledWith(expect.any(String), 'Cancelled by the travel desk')
    expect((await row(ids[2])).cancelled_by).toBe(a.tmcAdmin.id)
  })

  it('the provider refuses: the booking is unchanged, the person can try again', async () => {
    await setStatus(ids[2], 'held')
    h.cancelBooking.mockRejectedValue(new AmadeusError('Amadeus CancellationRequest failed: PNR locked', 'E1', '', {}, 'req-1234-5678'))
    const res = await cancel(owner, ids[2])
    expect(res.status).toBe(502)
    expect((res.json as { error: string }).error).toMatch(/^The airline did not confirm the cancellation\. Your booking is unchanged/)
    expect(JSON.stringify(res.json)).not.toMatch(/PNR locked/)
    expect(await row(ids[2])).toMatchObject({ status: 'held', cancelled_at: null, cancel_started_at: null })

    h.cancelBooking.mockResolvedValue(HELD_ANSWER)
    expect((await cancel(owner, ids[2])).status).toBe(200)
  })

  it('a cancellation already with the provider: a second one is refused (409), not sent twice', async () => {
    await setStatus(ids[2], 'held')
    await exec(db, sql`update bookings set cancel_started_at = now() where id = ${ids[2]}`)
    const res = await cancel(owner, ids[2])
    expect(res).toMatchObject({ status: 409, json: { code: 'CANCEL_IN_PROGRESS' } })
    expect(h.cancelBooking).not.toHaveBeenCalled()

    // Abandoned (over two minutes old): it may be retried.
    await exec(db, sql`update bookings set cancel_started_at = now() - interval '3 minutes' where id = ${ids[2]}`)
    h.cancelBooking.mockResolvedValue(HELD_ANSWER)
    expect((await cancel(owner, ids[2])).status).toBe(200)
  })

  it('the airline cancelled but recording it failed: still reported as done, with a warning', async () => {
    await setStatus(ids[2], 'held')
    h.cancelBooking.mockResolvedValue(HELD_ANSWER)
    h.failRecord = true
    const res = await cancel(owner, ids[2])
    expect(res.status).toBe(200)
    expect(res.json).toMatchObject({ ok: true, status: 'cancelled' })
    expect((res.json as { warning: string }).warning).toMatch(/^The airline accepted the cancellation, but saving it here failed/)
  })

  it('waiting for approval: withdrawn here, its open steps close, no provider call', async () => {
    await setStatus(ids[3], 'pending_approval')
    const approver = a.manager ?? a.tmcAdmin
    await exec(db, sql`
      insert into approvals (client_id, booking_id, approver_id, tier, status, verdict)
      values (${a.corpAdmin.client_id}, ${ids[3]}, ${approver.id}, 1, 'pending', 'amber')`)
    const res = await cancel(owner, ids[3], { reason: 'Not travelling' })
    expect(res).toMatchObject({ status: 200, json: { ok: true, status: 'cancelled' } })
    expect(h.cancelBooking).not.toHaveBeenCalled()
    // The open step closes; steps already decided keep their decision.
    expect(await many(db, sql`
      select status from approvals where booking_id = ${ids[3]} and status in ('pending', 'withdrawn')`))
      .toEqual([{ status: 'withdrawn' }])
    expect(await row(ids[3])).toMatchObject({ status: 'cancelled', cancellation: null, cancellation_reason: 'Not travelling' })
  })

  it('refusals: signed out, someone else, a booking never confirmed, a bad reason', async () => {
    await setStatus(ids[3], 'held')
    expect((await cancel(null, ids[3])).status).toBe(401)
    if (a.employee) expect((await cancel({ id: a.employee.id }, ids[3])).status).toBe(403)
    if (a.otherTmcAdmin) expect([403, 404]).toContain((await cancel({ id: a.otherTmcAdmin.id }, ids[3])).status)
    expect((await cancel(owner, '00000000-0000-0000-0000-000000000000')).status).toBe(404)
    expect(await cancel(owner, ids[3], { reason: 42 })).toMatchObject({ status: 400 })
    expect(await cancel(owner, ids[3], { reason: 'x'.repeat(501) })).toMatchObject({ status: 400 })

    await setStatus(ids[3], 'failed')
    expect(await cancel(owner, ids[3])).toMatchObject({ status: 409, json: { code: 'NOT_CANCELLABLE' } })
    expect(h.cancelBooking).not.toHaveBeenCalled()
  })
})
