import { describe, it, expect, beforeAll } from 'vitest'
import { NextRequest } from 'next/server'
import { GET as queueGet } from '@/app/api/tmc/queues/refunds/route'
import { GET as detailGet } from '@/app/api/tmc/queues/refunds/[id]/route'
import { POST as processPost } from '@/app/api/tmc/queues/refunds/[id]/process/route'
import { POST as rejectPost } from '@/app/api/tmc/queues/refunds/[id]/reject/route'
import { POST as markCancelledPost } from '@/app/api/tmc/queues/cancellations/[bookingId]/mark-cancelled/route'
import { POST as attachPost } from '@/app/api/tmc/queues/refunds/[id]/attachments/route'
import { GET as fileGet, DELETE as fileDelete } from '@/app/api/tmc/queues/refunds/[id]/attachments/[aid]/route'
import { PATCH as clientPatch } from '@/app/api/tmc/clients/[id]/route'
import { GET as bookingGet } from '@/app/api/book/[bookingId]/route'
import { GET as tmcReport } from '@/app/api/tmc/reports/[report]/route'
import { GET as corporateReport } from '@/app/api/reports/[report]/route'
import { financialYear } from '@/app/lib/repositories/refunds'
import { call } from '../harness/call'
import { actAs } from '../harness/session'
import { actors, type Actors } from '../harness/actors'
import { resetDatabase } from '../harness/db'
import { db } from '@/app/lib/db'
import { sql, one, many, exec } from '@/app/lib/db/sql'

// ── The cancellation queue and its refunds ───────────────────────────────────
// Who sees the queue (the TMC with process_refunds, within its reach), its
// filters, processing (recomputed on the server, a credit note number per TMC
// and financial year with no gaps, never twice), the airline-confirmation
// step, rejecting, and what bad input gets back.
// ─────────────────────────────────────────────────────────────────────────────

const HAS_DB = Boolean(process.env.DATABASE_URL)
const d = HAS_DB ? describe : describe.skip

interface QueueJson { items: { id: string; state: string; booking_id: string; ticket_number: string | null }[]; total: number }

d('cancellation queue and refunds', () => {
  let a: Actors
  let admin: { id: string }
  const refundOf: Record<string, string> = {}
  let bookings: string[]

  const queue = (as: { id: string }, query = '') =>
    call(queueGet, { as, url: `/api/tmc/queues/refunds${query}` })
  const detail = (as: { id: string }, id: string) =>
    call(detailGet, { as, url: `/api/tmc/queues/refunds/${id}`, params: { id } })
  const process = (as: { id: string }, id: string, body: unknown) =>
    call(processPost, { as, method: 'POST', url: `/api/tmc/queues/refunds/${id}/process`, params: { id }, body })
  const reject = (as: { id: string }, id: string, body: unknown) =>
    call(rejectPost, { as, method: 'POST', url: `/api/tmc/queues/refunds/${id}/reject`, params: { id }, body })
  const today = new Date().toISOString().slice(0, 10)
  const good = { refundDate: today, mode: 'agency_credit' }

  // A ticketed booking, cancelled: the provider kept 1,000 + 180 tax.
  const cancelTicketed = async (id: string, status: 'cancelled' | 'cancel_requested', ticket: string) => {
    await exec(db, sql`
      update bookings set status = ${status}, ticket_numbers = ${[ticket]}, cancelled_at = now(),
        cancelled_by = ${a.corpAdmin.id}, cancellation_reason = 'Trip called off',
        cancellation = ${JSON.stringify({ cancelStatus: status === 'cancelled' ? 'cancelled' : 'requested', wasTicketed: true,
          cancellationCharge: 1000, serviceTaxOnRaf: 180, refundedAmount: 0 })}::jsonb
      where id = ${id}`)
    await exec(db, sql`delete from refunds where booking_id = ${id}`)
    await exec(db, sql`
      insert into refunds (client_id, booking_id, passenger_index, ticket_number)
      select client_id, id, 0, ${ticket} from bookings where id = ${id}`)
    refundOf[id] = (await one<{ id: string }>(db, sql`select id from refunds where booking_id = ${id}`)).id
  }

  beforeAll(async () => {
    await resetDatabase()
    a = await actors()
    admin = { id: a.tmcAdmin.id }
    // The corporate admin's client belongs to the TMC admin's TMC in the template.
    bookings = (await many<{ id: string }>(db, sql`
      select b.id from bookings b join clients k on k.id = b.client_id
      where b.employee_id = ${a.corpAdmin.id} and k.tmc_id = ${a.tmcAdmin.tmc_id}
      order by b.created_at, b.id limit 4`)).map(r => r.id)
    expect(bookings).toHaveLength(4)
    await cancelTicketed(bookings[0], 'cancelled', 'TKT-0001')
    await cancelTicketed(bookings[1], 'cancelled', 'TKT-0002')
    await cancelTicketed(bookings[2], 'cancel_requested', 'TKT-0003')
    await cancelTicketed(bookings[3], 'cancelled', 'TKT-0004')
  })

  it('the TMC admin sees the queue: awaiting confirmation first, then pending', async () => {
    const res = await queue(admin)
    expect(res.status).toBe(200)
    const json = res.json as QueueJson
    const mine = json.items.filter(i => bookings.includes(i.booking_id))
    expect(mine).toHaveLength(4)
    expect(mine[0]).toMatchObject({ state: 'cancel_requested', ticket_number: 'TKT-0003' })
    expect(mine.slice(1).every(i => i.state === 'pending')).toBe(true)
  })

  it('filters: by state and by search', async () => {
    const requested = (await queue(admin, '?state=cancel_requested')).json as QueueJson
    expect(requested.items.map(i => i.ticket_number)).toContain('TKT-0003')
    expect(requested.items.every(i => i.state === 'cancel_requested')).toBe(true)
    const found = (await queue(admin, '?search=TKT-0002')).json as QueueJson
    expect(found.items.map(i => i.ticket_number)).toEqual(['TKT-0002'])
  })

  it('outside its reach: a corporate user is refused, another TMC sees nothing and gets 404', async () => {
    expect((await queue({ id: a.corpAdmin.id })).status).toBe(403)
    if (a.otherTmcAdmin) {
      const other = (await queue({ id: a.otherTmcAdmin.id })).json as QueueJson
      expect(other.items.filter(i => bookings.includes(i.booking_id))).toEqual([])
      expect((await detail({ id: a.otherTmcAdmin.id }, refundOf[bookings[0]])).status).toBe(404)
      expect((await process({ id: a.otherTmcAdmin.id }, refundOf[bookings[0]], good)).status).toBe(404)
    }
  })

  it('a counsellor needs process_refunds', async () => {
    if (!a.tc) return
    await exec(db, sql`delete from employee_permissions where employee_id = ${a.tc.id} and permission_key = 'process_refunds'`)
    expect(await queue({ id: a.tc.id })).toMatchObject({ status: 403, json: { error: 'Missing permission: process_refunds' } })
  })

  it('the panel: the ticket and its computation, made from the airline’s charge', async () => {
    const res = await detail(admin, refundOf[bookings[0]])
    expect(res.status).toBe(200)
    const json = res.json as {
      refund: { status: string; canProcess: boolean }; ticket: { ticketNumber: string }
      computation: { deductions: { key: string; amount: number }[]; result: { refundAmount: number } }
    }
    expect(json.refund).toMatchObject({ status: 'pending', canProcess: true })
    expect(json.ticket.ticketNumber).toBe('TKT-0001')
    const charge = json.computation.deductions.find(x => x.key === 'airline_cancellation_charge')!
    const tax = json.computation.deductions.find(x => x.key === 'airline_charge_tax')!
    expect(charge.amount + tax.amount).toBe(1180)
  })

  it('process: recomputed with the desk’s edit, a credit note number, frozen, audited; never twice', async () => {
    const id = refundOf[bookings[0]]
    const res = await process(admin, id, { ...good, overrides: { airline_cancellation_charge: 800 }, remark: 'Airline note attached' })
    expect(res.status).toBe(200)
    const fy = financialYear(new Date())
    expect(res.json).toMatchObject({ ok: true, creditNoteNo: `CN/${fy}/00001` })

    const row = await one<Record<string, unknown>>(db, sql`
      select status, credit_note_no, refund_date::text as refund_date, mode, remark, processed_by,
             lines -> 'overrides' as overrides
      from refunds where id = ${id}`)
    expect(row).toMatchObject({
      status: 'processed', credit_note_no: `CN/${fy}/00001`, refund_date: today, mode: 'agency_credit',
      remark: 'Airline note attached', processed_by: admin.id, overrides: { airline_cancellation_charge: 800 },
    })
    const after = (await detail(admin, id)).json as { refund: { status: string; creditNoteNo: string }; computation: { deductions: { key: string; amount: number; source: string }[] } }
    expect(after.refund).toMatchObject({ status: 'processed', creditNoteNo: `CN/${fy}/00001` })
    expect(after.computation.deductions.find(x => x.key === 'airline_cancellation_charge')).toMatchObject({ amount: 800, source: 'edited' })
    expect((await one<{ n: number }>(db, sql`
      select count(*)::int as n from audit_log where action = 'refund.processed' and entity_id = ${id}`)).n).toBe(1)

    expect(await process(admin, id, good)).toMatchObject({ status: 409, json: { code: 'NOT_PENDING' } })
  })

  it('credit note numbers: no gaps and no duplicates when two are processed at once', async () => {
    const fy = financialYear(new Date())
    await cancelTicketed(bookings[0], 'cancelled', 'TKT-0001')   // a fresh pending refund
    const [x, y] = await Promise.all([
      process(admin, refundOf[bookings[0]], good),
      process(admin, refundOf[bookings[1]], good),
    ])
    expect([x.status, y.status]).toEqual([200, 200])
    const numbers = [x.json, y.json].map(j => (j as { creditNoteNo: string }).creditNoteNo).sort()
    expect(numbers).toEqual([`CN/${fy}/00002`, `CN/${fy}/00003`])
  })

  it('the same refund processed twice at the same moment: one wins, the other is refused, one number used', async () => {
    const fy = financialYear(new Date())
    await cancelTicketed(bookings[1], 'cancelled', 'TKT-0002')   // a fresh pending refund
    const id = refundOf[bookings[1]]
    const counter = async () => (await many<{ last_no: number }>(db, sql`
      select last_no from credit_note_counters where tmc_id = ${a.tmcAdmin.tmc_id} and financial_year = ${fy}`))[0]?.last_no ?? 0
    const before = await counter()
    const audits = async () => (await one<{ n: number }>(db, sql`
      select count(*)::int as n from audit_log where action = 'refund.processed' and entity_id = ${id}`)).n
    const auditsBefore = await audits()

    const results = await Promise.all([process(admin, id, good), process(admin, id, good)])
    expect(results.map(r => r.status).sort()).toEqual([200, 409])
    expect(await audits()).toBe(auditsBefore + 1)
    expect(await counter()).toBe(before + 1)
    const winner = results.find(r => r.status === 200)!.json as { creditNoteNo: string }
    expect(winner.creditNoteNo).toBe(`CN/${fy}/${String(before + 1).padStart(5, '0')}`)
  })

  it('awaiting the airline’s confirmation: refused until marked cancelled, then processable', async () => {
    const id = refundOf[bookings[2]]
    expect(await process(admin, id, good)).toMatchObject({ status: 409, json: { code: 'AWAITING_CONFIRMATION' } })
    const mark = await call(markCancelledPost, {
      as: admin, method: 'POST', url: `/api/tmc/queues/cancellations/${bookings[2]}/mark-cancelled`, params: { bookingId: bookings[2] },
    })
    expect(mark).toEqual({ status: 200, json: { ok: true, status: 'cancelled' } })
    expect((await one<{ status: string }>(db, sql`select status from bookings where id = ${bookings[2]}`)).status).toBe('cancelled')
    const again = await call(markCancelledPost, {
      as: admin, method: 'POST', url: `/api/tmc/queues/cancellations/${bookings[2]}/mark-cancelled`, params: { bookingId: bookings[2] },
    })
    expect(again).toMatchObject({ status: 409, json: { code: 'NOT_AWAITING' } })
    expect((await process(admin, id, good)).status).toBe(200)
  })

  it('reject: a reason is required; once rejected it cannot be processed', async () => {
    const id = refundOf[bookings[3]]
    expect(await reject(admin, id, { reason: '  ' })).toMatchObject({ status: 400 })
    expect(await reject(admin, id, { reason: 'Non-refundable fare, airline refused' })).toEqual({ status: 200, json: { ok: true, status: 'rejected' } })
    expect((await one<{ rejected_reason: string }>(db, sql`select rejected_reason from refunds where id = ${id}`)).rejected_reason)
      .toBe('Non-refundable fare, airline refused')
    expect(await process(admin, id, good)).toMatchObject({ status: 409, json: { code: 'NOT_PENDING' } })
  })

  it('bad input: unknown or negative deductions, a future date, an unknown mode', async () => {
    await cancelTicketed(bookings[3], 'cancelled', 'TKT-0004')
    const id = refundOf[bookings[3]]
    expect(await process(admin, id, { ...good, overrides: { tip: 5 } })).toMatchObject({ status: 400, json: { error: 'Unknown deduction: tip' } })
    expect(await process(admin, id, { ...good, overrides: { airline_penalty: -1 } })).toMatchObject({
      status: 400, json: { error: 'Airline penalty must be zero or more.' },
    })
    expect(await process(admin, id, { ...good, refundDate: '2999-01-01' })).toMatchObject({ status: 400 })
    expect(await process(admin, id, { ...good, mode: 'cash' })).toMatchObject({ status: 400 })
    expect((await one<{ status: string }>(db, sql`select status from refunds where id = ${id}`)).status).toBe('pending')
  })

  it('the financial year runs April to March, in Indian time', () => {
    expect(financialYear(new Date('2026-03-31T18:00:00Z'))).toBe('2025-26')   // 31 Mar, 23:30 IST
    expect(financialYear(new Date('2026-03-31T18:31:00Z'))).toBe('2026-27')   // 1 Apr, 00:01 IST
    expect(financialYear(new Date('2027-01-15T00:00:00Z'))).toBe('2026-27')
  })
})

// ── Attachments ──────────────────────────────────────────────────────────────


const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(64, 0x20), Buffer.from('%%EOF')])

async function upload(as: { id: string }, id: string, bytes: Buffer, name: string, type: string) {
  actAs(as)
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(bytes)], { type }), name)
  const req = new NextRequest(new URL(`/api/tmc/queues/refunds/${id}/attachments`, 'http://localhost'), { method: 'POST', body: form })
  const res = await attachPost(req, { params: Promise.resolve({ id }) })
  return { status: res.status, json: await res.json() as { attachment?: { id: string; filename: string; size: number }; error?: string } }
}

d('refund attachments', () => {
  let a: Actors
  let admin: { id: string }
  let refundId: string

  beforeAll(async () => {
    a = await actors()
    admin = { id: a.tmcAdmin.id }
    refundId = (await one<{ id: string }>(db, sql`
      select r.id from refunds r join bookings b on b.id = r.booking_id
      where r.status = 'pending' and b.status = 'cancelled' and r.tmc_id = ${a.tmcAdmin.tmc_id}
      order by r.created_at limit 1`)).id
  })

  it('a PDF is stored, listed on the panel and downloaded byte for byte, always as a download', async () => {
    const up = await upload(admin, refundId, PDF, '../airline note.pdf', 'application/pdf')
    expect(up.status).toBe(200)
    expect(up.json.attachment).toMatchObject({ filename: 'airline note.pdf', size: PDF.length })

    const panel = (await call(detailGet, { as: admin, url: `/api/tmc/queues/refunds/${refundId}`, params: { id: refundId } })).json as { attachments: { id: string }[] }
    expect(panel.attachments.map(x => x.id)).toContain(up.json.attachment!.id)

    actAs(admin)
    const aid = up.json.attachment!.id
    const res = await fileGet(new NextRequest(new URL(`/api/tmc/queues/refunds/${refundId}/attachments/${aid}`, 'http://localhost')),
      { params: Promise.resolve({ id: refundId, aid }) })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/pdf')
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="airline note.pdf"/)
    expect(Buffer.from(await res.arrayBuffer()).equals(PDF)).toBe(true)
  })

  it('a file is judged by its own bytes: HTML named .pdf is refused, and so is anything over 5 MB', async () => {
    const html = await upload(admin, refundId, Buffer.from('<html><script>alert(1)</script></html>'), 'refund.pdf', 'application/pdf')
    expect(html).toMatchObject({ status: 415, json: { error: 'Only PDF, JPG and PNG files can be attached.' } })
    const big = await upload(admin, refundId, Buffer.concat([PDF, Buffer.alloc(5 * 1024 * 1024)]), 'big.pdf', 'application/pdf')
    expect(big.status).toBe(413)
  })

  it('another TMC can neither upload nor download; a pending refund’s document can be removed, a settled one’s cannot', async () => {
    const up = await upload(admin, refundId, PDF, 'note.pdf', 'application/pdf')
    const aid = up.json.attachment!.id
    if (a.otherTmcAdmin) {
      expect((await upload({ id: a.otherTmcAdmin.id }, refundId, PDF, 'x.pdf', 'application/pdf')).status).toBe(404)
      actAs({ id: a.otherTmcAdmin.id })
      const res = await fileGet(new NextRequest(new URL('/x', 'http://localhost')), { params: Promise.resolve({ id: refundId, aid }) })
      expect(res.status).toBe(404)
    }
    actAs(admin)
    const del = await fileDelete(new NextRequest(new URL('/x', 'http://localhost'), { method: 'DELETE' }), { params: Promise.resolve({ id: refundId, aid }) })
    expect(del.status).toBe(200)

    const keep = (await upload(admin, refundId, PDF, 'keep.pdf', 'application/pdf')).json.attachment!.id
    await exec(db, sql`update refunds set status = 'processed', credit_note_no = 'CN/TEST/1', refund_amount = 0, lines = '{}'::jsonb where id = ${refundId}`)
    actAs(admin)
    const settled = await fileDelete(new NextRequest(new URL('/x', 'http://localhost'), { method: 'DELETE' }), { params: Promise.resolve({ id: refundId, aid: keep }) })
    expect(settled.status).toBe(409)
  })
})

// ── The refund rule (Corporate Settings, and the Cancellation queues) ────────


d('the refund rule', () => {
  let a: Actors
  const patch = (as: { id: string }, body: unknown) => call(clientPatch, {
    as, method: 'PATCH', url: `/api/tmc/clients/${a.corpAdmin.client_id}`, params: { id: a.corpAdmin.client_id! }, body,
  })

  let pendingId: string

  beforeAll(async () => {
    a = await actors()
    // A pending refund of its own, whatever ran before.
    const { id } = await one<{ id: string }>(db, sql`
      select b.id from bookings b where b.employee_id = ${a.corpAdmin.id} order by b.created_at desc, b.id limit 1`)
    await exec(db, sql`
      update bookings set status = 'cancelled', cancelled_at = now(), ticket_numbers = ${['TKT-RULE']},
        cancellation = '{"wasTicketed": true, "cancellationCharge": 500, "serviceTaxOnRaf": 90}'::jsonb
      where id = ${id}`)
    await exec(db, sql`delete from refunds where booking_id = ${id}`)
    pendingId = (await one<{ id: string }>(db, sql`
      insert into refunds (client_id, booking_id, passenger_index, ticket_number)
      select client_id, id, 0, 'TKT-RULE' from bookings where id = ${id} returning id`)).id
  })

  it('the TMC sets it; the refund panel starts from it at once', async () => {
    const res = await patch({ id: a.tmcAdmin.id }, {
      refund_markup: true, refund_processing_fee: false, tmc_cancellation_fee: 2, tmc_cancellation_fee_unit: 'percent', gst_rate: 18,
    })
    expect(res.status).toBe(200)
    expect((res.json as { client: Record<string, unknown> }).client).toMatchObject({
      refund_markup: true, refund_processing_fee: false, tmc_cancellation_fee: 2, tmc_cancellation_fee_unit: 'percent', gst_rate: 18,
    })
    const panel = (await call(detailGet, { as: { id: a.tmcAdmin.id }, url: `/api/tmc/queues/refunds/${pendingId}`, params: { id: pendingId } })).json as {
      rule: Record<string, unknown>; computation: { deductions: { key: string; amount: number }[]; charged: { totalPaid: number } }
    }
    expect(panel.rule).toMatchObject({ refundMarkup: true, tmcCancellationFee: 2, tmcCancellationFeeUnit: 'percent' })
    const fee = panel.computation.deductions.find(x => x.key === 'tmc_cancellation_fee')!.amount
    expect(fee).toBe(Math.round(panel.computation.charged.totalPaid * 0.02 * 100) / 100)
    expect(panel.computation.deductions.find(x => x.key === 'markup_kept')!.amount).toBe(0)
  })

  it('out of range is refused, with what is allowed', async () => {
    expect(await patch({ id: a.tmcAdmin.id }, { tmc_cancellation_fee: 150, tmc_cancellation_fee_unit: 'percent' })).toMatchObject({
      status: 400, json: { error: 'The TMC cancellation fee must be a percentage from 0 to 100.' },
    })
    expect(await patch({ id: a.tmcAdmin.id }, { gst_rate: 120 })).toMatchObject({ status: 400 })
    expect(await patch({ id: a.tmcAdmin.id }, { tmc_cancellation_fee_unit: 'rupees' })).toMatchObject({ status: 400 })
    expect(await patch({ id: a.tmcAdmin.id }, { refund_markup: 'yes' })).toMatchObject({ status: 400 })
  })

  it('a counsellor with process_refunds (and not manage_clients) may set the rule, and nothing else', async () => {
    if (!a.tc) return
    const tc = { id: a.tc.id }
    await exec(db, sql`delete from employee_permissions where employee_id = ${a.tc.id} and permission_key in ('manage_clients', 'process_refunds')`)
    await exec(db, sql`insert into employee_permissions (employee_id, permission_key) values (${a.tc.id}, 'process_refunds')`)
    await exec(db, sql`
      insert into employee_client_access (employee_id, client_id) values (${a.tc.id}, ${a.corpAdmin.client_id})
      on conflict do nothing`)
    expect((await patch(tc, { gst_rate: 12 })).status).toBe(200)
    expect((await patch(tc, { gst_rate: 18, name: 'Renamed by a counsellor' })).status).toBe(403)
  })
})

// ── What the traveller and the company see ───────────────────────────────────

d('the refund outcome on the booking', () => {
  let a: Actors

  beforeAll(async () => { a = await actors() })

  it('refunded: the amount, the date and the credit note; never what the TMC keeps or the airline’s figures', async () => {
    const r = await one<{ booking_id: string; refund_amount: number; credit_note_no: string; tmc_retained: number; airline_refund: number }>(db, sql`
      select r.booking_id, r.refund_amount, r.credit_note_no, r.tmc_retained, r.airline_refund
      from refunds r join bookings b on b.id = r.booking_id
      where r.status = 'processed' and b.employee_id = ${a.corpAdmin.id} and r.credit_note_no like 'CN/%/%'
      order by r.processed_at desc limit 1`)
    const res = await call(bookingGet, { as: { id: a.corpAdmin.id }, url: `/api/book/${r.booking_id}`, params: { bookingId: r.booking_id } })
    expect(res.status).toBe(200)
    const view = (res.json as { booking: { cancellation: Record<string, unknown> } }).booking.cancellation
    expect(view).toMatchObject({
      refund: 'refunded',
      refunded: { amount: Number(r.refund_amount), creditNotes: [r.credit_note_no] },
      declinedReason: null,
    })
    expect(JSON.stringify(view)).not.toMatch(/tmcRetained|airlineRefund|tmc_retained|airline_refund|provider/)
  })

  it('declined: the reason, and nothing refunded', async () => {
    const { id } = await one<{ id: string }>(db, sql`
      select b.id from bookings b where b.employee_id = ${a.corpAdmin.id} and b.status in ('ticketed', 'held')
      order by b.created_at, b.id limit 1`)
    await exec(db, sql`
      update bookings set status = 'cancelled', cancelled_at = now(),
        cancellation = '{"wasTicketed": true, "cancellationCharge": 0, "serviceTaxOnRaf": 0}'::jsonb
      where id = ${id}`)
    await exec(db, sql`delete from refunds where booking_id = ${id}`)
    await exec(db, sql`
      insert into refunds (client_id, booking_id, passenger_index, status, rejected_reason)
      select client_id, id, 0, 'rejected', 'Non-refundable fare' from bookings where id = ${id}`)
    const res = await call(bookingGet, { as: { id: a.corpAdmin.id }, url: `/api/book/${id}`, params: { bookingId: id } })
    expect((res.json as { booking: { cancellation: unknown } }).booking.cancellation).toMatchObject({
      refund: 'declined', refunded: null, declinedReason: 'Non-refundable fare',
    })
  })
})

// ── Reports, once refunds are processed ──────────────────────────────────────

d('refunds in the reports', () => {
  let a: Actors
  // Yesterday to tomorrow: reports count days in Indian time, the test's clock may not.
  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)
  const range = `from=${day(-1)}&to=${day(1)}`

  beforeAll(async () => {
    a = await actors()
    // A processed refund of its own, whatever ran before: 5,000 paid, 3,800 back, 200 kept by the TMC.
    const { id } = await one<{ id: string }>(db, sql`
      select b.id from bookings b where b.employee_id = ${a.corpAdmin.id} order by b.created_at, b.id offset 5 limit 1`)
    await exec(db, sql`update bookings set status = 'cancelled', cancelled_at = now() where id = ${id}`)
    await exec(db, sql`delete from refunds where booking_id = ${id}`)
    await exec(db, sql`
      insert into refunds (client_id, booking_id, passenger_index, status, lines, refund_amount, airline_refund, tmc_retained,
                           credit_note_no, refund_date, mode, processed_at)
      select client_id, id, 0, 'processed', '{"computation": {"charged": {"totalPaid": 5000}}}'::jsonb, 3800, 4000, 200,
             'CN/TEST/R1', current_date, 'agency_credit', now()
      from bookings where id = ${id}`)
  })

  interface ReportJson { headline: { label: string; value: number }[]; tables: { key: string; columns: { key: string }[] }[] }

  it('TMC revenue: refunded and kept on cancellations, and a table by client', async () => {
    const res = await call(tmcReport, { as: { id: a.tmcAdmin.id }, url: `/api/tmc/reports/revenue?${range}`, params: { report: 'revenue' } })
    expect(res.status).toBe(200)
    const r = res.json as { report: ReportJson }
    const labels = r.report.headline.map(h => h.label)
    expect(labels).toEqual(expect.arrayContaining(['Refunded', 'Kept on cancellations']))
    expect(r.report.tables.map(t => t.key)).toContain('cancellations')
  })

  it('corporate spend: the cancellation charges, and never what the TMC kept', async () => {
    const res = await call(corporateReport, { as: { id: a.corpAdmin.id }, url: `/api/reports/spend?${range}`, params: { report: 'spend' } })
    expect(res.status).toBe(200)
    const r = res.json as { report: ReportJson }
    expect(r.report.headline.map(h => h.label)).toContain('Cancellation charges')
    expect(JSON.stringify(r)).not.toMatch(/Kept by the TMC|tmcKept|tmc_kept|Kept on cancellations/)
  })
})
