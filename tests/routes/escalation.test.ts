import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { POST as chainPost } from '@/app/api/tmc/approval-chains/direct/route'
import { GET as approvalsGet } from '@/app/api/approvals/route'
import { PATCH as decide } from '@/app/api/approvals/[approvalId]/route'
import { POST as escalatePost } from '@/app/api/internal/escalate/route'
import { startApprovalForBooking } from '@/app/lib/approval-engine/resolveApprovalTier'
import { escalateDueApprovals } from '@/app/lib/approval-engine/escalate'
import { call } from '../harness/call'
import { actors, type Actors } from '../harness/actors'
import { resetDatabase } from '../harness/db'
import { db } from '@/app/lib/db'
import { sql, many, one, maybeOne, exec } from '@/app/lib/db/sql'

// ── Approval escalation ──────────────────────────────────────────────────────
// A step waiting past the company's limit passes to the approver's own
// manager, once; with no manager to pass it to, it stays. Nothing is approved
// without a person.
// ─────────────────────────────────────────────────────────────────────────────

const HAS_DB = Boolean(process.env.DATABASE_URL)
const d = HAS_DB ? describe : describe.skip

const HOUR = 3_600_000

d('approval escalation', () => {
  let a: Actors
  let clientId: string
  let traveller: { id: string }
  let approver: { id: string }
  let manager: { id: string }

  // A copy of one of the company's bookings, for the traveller, pending.
  const newBooking = async () => (await one<{ id: string }>(db, sql`
    insert into bookings
    select (jsonb_populate_record(null::bookings, to_jsonb(b) || jsonb_build_object(
      'id', gen_random_uuid(), 'trip_id', null, 'employee_id', ${traveller.id}::uuid, 'booked_by', ${traveller.id}::uuid,
      'status', 'pending_approval', 'policy_verdict', 'amber',
      'share_token', null, 'pnr', null, 'provider_order_id', null, 'amadeus_key', null))).*
    from (select * from bookings where client_id = ${clientId} order by created_at, id limit 1) b
    returning id`)).id

  const raise = (bookingId: string) => startApprovalForBooking(db, {
    bookingId, clientId, employeeId: traveller.id, travelType: 'flight', verdict: 'amber', reason: 'Over the cap',
  })
  const rows = (bookingId: string) => many<{ id: string; approver_id: string; status: string; escalated_from: string | null; escalates_at: string | null }>(db, sql`
    select id, approver_id, status, escalated_from, escalates_at from approvals where booking_id = ${bookingId} order by created_at, id`)

  beforeAll(async () => {
    await resetDatabase()
    a = await actors()
    clientId = a.corpAdmin.client_id!
    const people = await many<{ id: string }>(db, sql`
      select id from employees where client_id = ${clientId} and id <> ${a.corpAdmin.id}
        and role = 'employee' and status = 'active' order by id limit 3`)
    ;[traveller, approver, manager] = people
    await exec(db, sql`update employees set manager_id = ${manager.id} where id = ${approver.id}`)
    await exec(db, sql`update clients set approval_escalation_hours = 2, within_policy_approval = 'auto' where id = ${clientId}`)
    expect((await call(chainPost, {
      as: a.tmcAdmin, method: 'POST', url: '/api/tmc/approval-chains/direct',
      body: { clientId, employeeId: traveller.id, category: 'air', mode: 'sequential', quorum: 'all',
        approvers: [{ approver_type: 'specific_user', approver_user_id: approver.id, min_verdict: 'green' }] },
    })).status).toBe(200)
  })
  afterAll(async () => {
    delete process.env.INTERNAL_API_SECRET
  })

  it('a step passes to the approver\'s manager once it has waited past the limit, and only once', async () => {
    const bookingId = await newBooking()
    expect((await raise(bookingId)).approverId).toBe(approver.id)
    const [first] = await rows(bookingId)
    // Stamped two hours on.
    const wait = new Date(first.escalates_at!).getTime() - Date.now()
    expect(wait).toBeGreaterThan(1.9 * HOUR)
    expect(wait).toBeLessThan(2.1 * HOUR)

    // Not yet.
    expect(await escalateDueApprovals(db, new Date(Date.now() + HOUR))).toEqual({ escalated: 0, kept: 0 })

    const run = await escalateDueApprovals(db, new Date(Date.now() + 3 * HOUR))
    expect(run.escalated).toBeGreaterThanOrEqual(1)
    const after = await rows(bookingId)
    expect(after).toEqual([
      expect.objectContaining({ id: first.id, approver_id: approver.id, status: 'escalated' }),
      expect.objectContaining({ approver_id: manager.id, status: 'pending', escalated_from: first.id, escalates_at: null }),
    ])
    expect(await maybeOne(db, sql`select 1 as ok from audit_log where action = 'approval.escalated' and entity_id = ${first.id}`))
      .toEqual({ ok: 1 })

    // Once: a later run leaves it with the manager.
    await escalateDueApprovals(db, new Date(Date.now() + 30 * HOUR))
    expect(await rows(bookingId)).toHaveLength(2)

    // The manager sees who it came from; the first approver can no longer
    // decide it, the manager can.
    const queue = (await call(approvalsGet, { as: manager, url: '/api/approvals' })).json as {
      pending: { approvalId: string; escalatedFromName: string | null }[]
    }
    expect(queue.pending.find(p => p.approvalId === after[1].id)?.escalatedFromName).toBeTruthy()
    const decideAs = (as: { id: string }, approvalId: string) =>
      call(decide, { as, method: 'PATCH', url: `/api/approvals/${approvalId}`, params: { approvalId }, body: { decision: 'approve' } })
    expect((await decideAs(approver, first.id)).status).not.toBe(200)
    expect((await decideAs(manager, after[1].id)).status).toBe(200)
    expect(await one(db, sql`select status from bookings where id = ${bookingId}`)).toEqual({ status: 'approved' })
  })

  it('an approver with no manager keeps the step; nothing is approved by timeout', async () => {
    await exec(db, sql`update employees set manager_id = null where id = ${approver.id}`)
    try {
      const bookingId = await newBooking()
      await raise(bookingId)
      const run = await escalateDueApprovals(db, new Date(Date.now() + 3 * HOUR))
      expect(run.kept).toBeGreaterThanOrEqual(1)
      expect(await rows(bookingId)).toEqual([
        expect.objectContaining({ approver_id: approver.id, status: 'pending', escalates_at: null }),
      ])
      expect(await one(db, sql`select status from bookings where id = ${bookingId}`)).toEqual({ status: 'pending_approval' })
    } finally {
      await exec(db, sql`update employees set manager_id = ${manager.id} where id = ${approver.id}`)
    }
  })

  it('a company with no limit set: no step ever escalates', async () => {
    await exec(db, sql`update clients set approval_escalation_hours = null where id = ${clientId}`)
    try {
      const bookingId = await newBooking()
      await raise(bookingId)
      expect((await rows(bookingId))[0].escalates_at).toBeNull()
    } finally {
      await exec(db, sql`update clients set approval_escalation_hours = 2 where id = ${clientId}`)
    }
  })

  it('the scheduler\'s endpoint needs the internal secret', async () => {
    process.env.INTERNAL_API_SECRET = 'test-secret-for-escalation'
    const post = (secret?: string) => call(escalatePost, {
      method: 'POST', url: '/api/internal/escalate', body: {},
      headers: secret ? { 'x-internal-secret': secret } : {},
    })
    expect((await post()).status).toBe(401)
    expect((await post('wrong')).status).toBe(401)
    expect(await post('test-secret-for-escalation')).toMatchObject({ status: 200, json: { ok: true } })
  })
})
