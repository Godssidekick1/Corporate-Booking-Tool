import { sql, empty, many, maybeOne, one, exec, json, type Queryable, type Sql } from '@/app/lib/db/sql'
import { page, searchAcross } from '@/app/lib/db/fragments'
import type { PageParams } from '@/app/lib/pagination'
import type { Row } from '@/app/lib/db/types.generated'

// ── Refunds (20261110000000_refunds) ─────────────────────────────────────────
// One row per cancelled passenger ticket. Created 'pending' when a ticketed
// booking is cancelled (POST /api/book/[bookingId]/cancel), in the same
// transaction as the cancellation itself, so a cancelled ticket can never be
// missing from the queue. Processed or rejected by the TMC from
// Configurations → Queues → Cancellation queues.
//
// What the queue calls a row's state:
//   cancel_requested   pending, but the booking is still 'cancel_requested':
//                      the airline has not confirmed; "Mark as cancelled" first
//   pending            the ticket is cancelled; the refund waits to be processed
//   processed          settled, with a credit note number
//   rejected           declined, with the reason
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

export const QUEUE_STATES = ['cancel_requested', 'pending', 'processed', 'rejected'] as const
export type QueueState = typeof QUEUE_STATES[number]
export const SOURCES = ['self', 'desk', 'colleague'] as const

export interface QueueFilters {
  tmcId: string
  // null: every client of the TMC (its admin); otherwise a counsellor's portfolio.
  clientIds: string[] | null
  search?: string | null
  state?: QueueState | null
  clientId?: string | null
  groupId?: string | null
  airline?: string | null
  source?: typeof SOURCES[number] | null
  requestedFrom?: string | null
  requestedTo?: string | null
  departureFrom?: string | null
  departureTo?: string | null
}

const PAX = sql`(b.traveler_snapshot -> 'PassengerDetails' -> r.passenger_index)`
const STATE = sql`(case when r.status = 'pending' and b.status = 'cancel_requested' then 'cancel_requested' else r.status end)`
const DEPARTURE = sql`(b.itinerary -> 'origin' ->> 'dateTime')`
const SOURCE = sql`(case when b.booked_by = b.employee_id then 'self'
  when (select k.role from employees k where k.id = b.booked_by) in ('tmc_admin', 'tc') then 'desk' else 'colleague' end)`
// This ticket's share of what the company paid: by its airline fare where the
// per-passenger split was kept, else an equal share.
const PAID = sql`round(coalesce(b.sell_total, b.total_cost) * coalesce(
  (b.fare_breakdown -> 'passengerBreakup' -> r.passenger_index ->> 'TotalFare')::numeric
    / nullif((select sum((x ->> 'TotalFare')::numeric) from jsonb_array_elements(coalesce(b.fare_breakdown -> 'passengerBreakup', '[]'::jsonb)) x), 0),
  1.0 / greatest(1, jsonb_array_length(coalesce(b.traveler_snapshot -> 'PassengerDetails', '[]'::jsonb)))), 2)`

function where(f: QueueFilters): Sql {
  const between = (col: Sql, from?: string | null, to?: string | null) => sql`
    ${from ? sql`and ${col} >= ${from}::date` : empty}
    ${to ? sql`and ${col} < ${to}::date + 1` : empty}`
  return sql`
    where r.tmc_id = ${f.tmcId}
    ${f.clientIds ? sql`and r.client_id = any(${f.clientIds})` : empty}
    ${f.state ? sql`and ${STATE} = ${f.state}` : empty}
    ${f.clientId ? sql`and r.client_id = ${f.clientId}` : empty}
    ${f.groupId ? sql`and k.client_group_id = ${f.groupId}` : empty}
    ${f.airline ? sql`and upper(b.itinerary -> 'airline' ->> 'code') = upper(${f.airline})` : empty}
    ${f.source ? sql`and ${SOURCE} = ${f.source}` : empty}
    ${between(sql`(b.cancelled_at at time zone 'Asia/Kolkata')`, f.requestedFrom, f.requestedTo)}
    ${between(sql`(${DEPARTURE})::timestamp`, f.departureFrom, f.departureTo)}
    ${searchAcross([
      sql`b.provider_order_id`, sql`b.pnr`, sql`b.airline_pnr`, sql`r.ticket_number`, sql`r.credit_note_no`,
      sql`b.cancellation ->> 'transactionId'`,
      sql`(${PAX} ->> 'FirstName') || ' ' || (${PAX} ->> 'LastName')`,
    ], f.search)}`
}

export interface QueueRow {
  id: string
  state: QueueState
  booking_id: string
  reference: string | null
  transaction_id: string | null
  client_id: string
  client_name: string
  client_code: string | null
  group_name: string | null
  pnr: string | null
  airline_pnr: string | null
  first_name: string | null
  last_name: string | null
  pax_type: string | null
  origin: string | null
  destination: string | null
  departure: string | null
  airline: string | null
  ticket_number: string | null
  paid: number | null
  refund_amount: number | null
  credit_note_no: string | null
  booked_at: string
  requested_at: string | null
  requested_by: string | null
  requested_by_kind: 'traveller' | 'desk' | 'admin' | null
  source: typeof SOURCES[number]
}

export async function queue(db: Queryable, f: QueueFilters, params: PageParams): Promise<{ rows: QueueRow[]; total: number }> {
  const from = sql`from refunds r join bookings b on b.id = r.booking_id join clients k on k.id = r.client_id`
  const filter = where(f)
  const [rows, count] = await Promise.all([
    many<QueueRow>(db, sql`
      select r.id, ${STATE} as state, b.id as booking_id, b.provider_order_id as reference,
             b.cancellation ->> 'transactionId' as transaction_id,
             k.id as client_id, k.name as client_name, k.client_code,
             (select g.name from client_groups g where g.id = k.client_group_id) as group_name,
             b.pnr, b.airline_pnr,
             ${PAX} ->> 'FirstName' as first_name, ${PAX} ->> 'LastName' as last_name, ${PAX} ->> 'PaxType' as pax_type,
             b.itinerary -> 'origin' ->> 'code' as origin, b.itinerary -> 'destination' ->> 'code' as destination,
             ${DEPARTURE} as departure, b.itinerary -> 'airline' ->> 'code' as airline,
             r.ticket_number, ${PAID} as paid, r.refund_amount, r.credit_note_no,
             b.created_at as booked_at, b.cancelled_at as requested_at,
             (select e.full_name from employees e where e.id = b.cancelled_by) as requested_by,
             case when b.cancelled_by is null then null
                  when b.cancelled_by = b.employee_id then 'traveller'
                  when (select e.role from employees e where e.id = b.cancelled_by) in ('tmc_admin', 'tc') then 'desk'
                  else 'admin' end as requested_by_kind,
             ${SOURCE} as source
      ${from} ${filter}
      order by (case ${STATE} when 'cancel_requested' then 0 when 'pending' then 1 else 2 end),
               b.cancelled_at desc nulls last, r.passenger_index
      ${page(params)}`),
    one<{ n: number }>(db, sql`select count(*)::int as n ${from} ${filter}`),
  ])
  return { rows, total: count.n }
}

// Everything the refund panel needs, for one refund within the caller's reach.
export type RefundDetail = Row<'refunds'> & {
  processed_by_name: string | null
  booking: Pick<Row<'bookings'>,
    | 'id' | 'status' | 'employee_id' | 'booked_by' | 'provider_order_id' | 'pnr' | 'airline_pnr' | 'ticket_numbers'
    | 'itinerary' | 'traveler_snapshot' | 'fare_breakdown' | 'commercials' | 'sell_total' | 'total_cost'
    | 'resolved_fop' | 'cancelled_at' | 'cancellation_reason' | 'cancellation' | 'created_at'
  > & { cancelled_by_name: string | null }
  client: Pick<Row<'clients'>,
    | 'id' | 'name' | 'client_code' | 'state' | 'refund_markup' | 'refund_processing_fee'
    | 'tmc_cancellation_fee' | 'tmc_cancellation_fee_unit' | 'gst_rate'
  > & { gst_state: string | null; branch_gst_state: string | null }
}

export async function detail(
  db: Queryable,
  id: string,
  scope: { tmcId: string; clientIds: string[] | null },
): Promise<RefundDetail | null> {
  const row = await maybeOne<Row<'refunds'> & { processed_by_name: string | null }>(db, sql`
    select r.*, (select e.full_name from employees e where e.id = r.processed_by) as processed_by_name
    from refunds r
    where r.id = ${id} and r.tmc_id = ${scope.tmcId}
      ${scope.clientIds ? sql`and r.client_id = any(${scope.clientIds})` : empty}`)
  if (!row) return null
  const [booking, client] = await Promise.all([
    one<RefundDetail['booking']>(db, sql`
      select id, status, employee_id, booked_by, provider_order_id, pnr, airline_pnr, ticket_numbers, itinerary,
             traveler_snapshot, fare_breakdown, commercials, sell_total, total_cost, resolved_fop, cancelled_at,
             cancellation_reason, cancellation, created_at,
             (select e.full_name from employees e where e.id = cancelled_by) as cancelled_by_name
      from bookings where id = ${row.booking_id}`),
    one<RefundDetail['client']>(db, sql`
      select k.id, k.name, k.client_code, k.state, k.refund_markup, k.refund_processing_fee,
             k.tmc_cancellation_fee, k.tmc_cancellation_fee_unit, k.gst_rate,
             (select nullif(g.state, '') from client_gst_registrations g
               where g.client_id = k.id order by g.is_primary desc, g.created_at limit 1) as gst_state,
             coalesce(
               (select nullif(br.gst_state, '') from branches br where br.id = k.branch_id),
               (select nullif(br.gst_state, '') from branches br where br.tmc_id = k.tmc_id and br.is_head_office limit 1)
             ) as branch_gst_state
      from clients k where k.id = ${row.client_id}`),
  ])
  return { ...row, booking, client }
}

// The Indian financial year a date falls in: April to March, "2026-27".
export function financialYear(date: Date): string {
  const ist = new Date(date.getTime() + 330 * 60_000)
  const y = ist.getUTCMonth() >= 3 ? ist.getUTCFullYear() : ist.getUTCFullYear() - 1
  return `${y}-${String((y + 1) % 100).padStart(2, '0')}`
}

export interface ProcessInput {
  lines: unknown
  refundAmount: number
  airlineRefund: number
  tmcRetained: number
  refundDate: string
  mode: 'corporate_card' | 'agency_credit' | 'traveller_card' | 'other'
  remark: string | null
  by: string
}

// Settles a pending refund: the next credit note number for the TMC's
// financial year, taken with one atomic upsert, so two people processing at
// once can neither share a number nor skip one. Null when the refund is no
// longer pending (processed or rejected meanwhile) or its booking is not yet
// confirmed cancelled. Run inside a transaction: a failure after the number
// is taken gives it back.
export async function process(db: Queryable, id: string, tmcId: string, p: ProcessInput): Promise<{ creditNoteNo: string } | null> {
  const ready = await maybeOne<{ id: string }>(db, sql`
    select r.id from refunds r join bookings b on b.id = r.booking_id
    where r.id = ${id} and r.tmc_id = ${tmcId} and r.status = 'pending' and b.status = 'cancelled'
    for update of r`)
  if (!ready) return null
  const fy = financialYear(new Date())
  const { last_no } = await one<{ last_no: number }>(db, sql`
    insert into credit_note_counters (tmc_id, financial_year, last_no) values (${tmcId}, ${fy}, 1)
    on conflict (tmc_id, financial_year) do update set last_no = credit_note_counters.last_no + 1
    returning last_no`)
  const creditNoteNo = `CN/${fy}/${String(last_no).padStart(5, '0')}`
  await exec(db, sql`
    update refunds set status = 'processed', lines = ${json(p.lines)}, refund_amount = ${p.refundAmount},
      airline_refund = ${p.airlineRefund}, tmc_retained = ${p.tmcRetained}, credit_note_no = ${creditNoteNo},
      refund_date = ${p.refundDate}, mode = ${p.mode}, remark = ${p.remark}, processed_by = ${p.by},
      processed_at = now(), updated_at = now()
    where id = ${id}`)
  return { creditNoteNo }
}

// False when the refund is no longer pending.
export async function reject(db: Queryable, id: string, tmcId: string, reason: string, by: string): Promise<boolean> {
  return (await exec(db, sql`
    update refunds set status = 'rejected', rejected_reason = ${reason}, processed_by = ${by},
      processed_at = now(), updated_at = now()
    where id = ${id} and tmc_id = ${tmcId} and status = 'pending'`)) === 1
}

// A booking whose cancellation the provider had only accepted, confirmed by
// the desk: cancelled now, its tickets' refunds ready to process. False when
// it is not (or no longer) awaiting confirmation, or outside the caller's reach.
export async function confirmCancelled(
  db: Queryable,
  bookingId: string,
  scope: { tmcId: string; clientIds: string[] | null },
): Promise<{ client_id: string } | null> {
  return maybeOne<{ client_id: string }>(db, sql`
    update bookings set status = 'cancelled', updated_at = now()
    where id = ${bookingId} and tmc_id = ${scope.tmcId} and status = 'cancel_requested'
      ${scope.clientIds ? sql`and client_id = any(${scope.clientIds})` : empty}
    returning client_id`)
}

// ── Attachments ──────────────────────────────────────────────────────────────

export const MAX_ATTACHMENTS = 10
export type AttachmentMeta = { id: string; filename: string; content_type: string; size: number; uploaded_at: string; uploaded_by_name: string | null }

export async function attachments(db: Queryable, refundId: string): Promise<AttachmentMeta[]> {
  return many<AttachmentMeta>(db, sql`
    select a.id, a.filename, a.content_type, a.size, a.uploaded_at,
           (select e.full_name from employees e where e.id = a.uploaded_by) as uploaded_by_name
    from refund_attachments a where a.refund_id = ${refundId} order by a.uploaded_at, a.id`)
}

export async function addAttachment(
  db: Queryable,
  refund: { id: string; client_id: string },
  f: { filename: string; contentType: string; bytes: Buffer; by: string },
): Promise<AttachmentMeta> {
  return one<AttachmentMeta>(db, sql`
    insert into refund_attachments (refund_id, client_id, filename, content_type, size, bytes, uploaded_by)
    values (${refund.id}, ${refund.client_id}, ${f.filename}, ${f.contentType}, ${f.bytes.length}, ${f.bytes}, ${f.by})
    returning id, filename, content_type, size, uploaded_at,
              (select e.full_name from employees e where e.id = uploaded_by) as uploaded_by_name`)
}

export async function attachmentFile(db: Queryable, refundId: string, attachmentId: string): Promise<{ filename: string; content_type: string; bytes: Buffer } | null> {
  return maybeOne(db, sql`
    select filename, content_type, bytes from refund_attachments where id = ${attachmentId} and refund_id = ${refundId}`)
}

export async function removeAttachment(db: Queryable, refundId: string, attachmentId: string): Promise<boolean> {
  return (await exec(db, sql`delete from refund_attachments where id = ${attachmentId} and refund_id = ${refundId}`)) === 1
}

// ── The credit note's parties ────────────────────────────────────────────────
// Issuer: the TMC, as registered at the client's branch (else its head
// office). Recipient: the client, with its primary GST registration.

export interface CreditNoteParties {
  issuer: { name: string; branch: string | null; gstin: string | null; gst_name: string | null; city: string | null; state: string | null; zip: string | null }
  recipient: { name: string; gstin: string | null; gst_holder: string | null; address: string | null; city: string | null; state: string | null; zip: string | null }
}

export async function creditNoteParties(db: Queryable, clientId: string): Promise<CreditNoteParties> {
  const row = await one<Record<string, string | null>>(db, sql`
    select t.name as tmc_name,
           br.name as branch, br.gst_number, br.gst_name, br.gst_city, br.gst_state, br.gst_zip,
           k.name as client_name, g.gstin, g.gst_holder,
           nullif(concat_ws(', ', nullif(g.address_1, ''), nullif(g.address_2, '')), '') as address,
           coalesce(nullif(g.city, ''), k.city) as city, coalesce(nullif(g.state, ''), k.state) as state,
           coalesce(nullif(g.zip, ''), k.pincode) as zip
    from clients k
    join tmcs t on t.id = k.tmc_id
    left join lateral (
      select * from branches b where b.tmc_id = k.tmc_id and (b.id = k.branch_id or b.is_head_office)
      order by (b.id = k.branch_id) desc limit 1) br on true
    left join lateral (
      select * from client_gst_registrations r where r.client_id = k.id
      order by r.is_primary desc, r.created_at limit 1) g on true
    where k.id = ${clientId}`)
  return {
    issuer: { name: row.tmc_name ?? '', branch: row.branch, gstin: row.gst_number, gst_name: row.gst_name, city: row.gst_city, state: row.gst_state, zip: row.gst_zip },
    recipient: { name: row.client_name ?? '', gstin: row.gstin, gst_holder: row.gst_holder, address: row.address, city: row.city, state: row.state, zip: row.zip },
  }
}

// ── Refund rules, for the Cancellation queues' "Refund rules" tab ────────────
// Read here; written through PATCH /api/tmc/clients/[id] (the same columns as
// Corporate Settings), so there is one way to change them.

export type RefundRuleRow = Pick<Row<'clients'>,
  'id' | 'name' | 'client_code' | 'status' | 'refund_markup' | 'refund_processing_fee'
  | 'tmc_cancellation_fee' | 'tmc_cancellation_fee_unit' | 'gst_rate'> & { group_name: string | null; pending: number }

export async function refundRules(
  db: Queryable,
  f: { tmcId: string; clientIds: string[] | null; search?: string | null },
  params: PageParams,
): Promise<{ rows: RefundRuleRow[]; total: number }> {
  const filter = sql`
    where k.tmc_id = ${f.tmcId}
    ${f.clientIds ? sql`and k.id = any(${f.clientIds})` : empty}
    ${searchAcross([sql`k.name`, sql`k.client_code`], f.search)}`
  const [rows, count] = await Promise.all([
    many<RefundRuleRow>(db, sql`
      select k.id, k.name, k.client_code, k.status, k.refund_markup, k.refund_processing_fee,
             k.tmc_cancellation_fee, k.tmc_cancellation_fee_unit, k.gst_rate,
             (select g.name from client_groups g where g.id = k.client_group_id) as group_name,
             (select count(*)::int from refunds r where r.client_id = k.id and r.status = 'pending') as pending
      from clients k ${filter}
      order by k.name, k.id
      ${page(params)}`),
    one<{ n: number }>(db, sql`select count(*)::int as n from clients k ${filter}`),
  ])
  return { rows, total: count.n }
}

// A booking's ticket refunds as its traveller and company may see them: the
// outcome only, never what the TMC keeps or the airline's figures.
export async function outcomeForBooking(db: Queryable, bookingId: string): Promise<{
  status: 'pending' | 'processed' | 'rejected'; refund_amount: number | null; refund_date: string | null
  credit_note_no: string | null; rejected_reason: string | null
}[]> {
  return many(db, sql`
    select status, refund_amount, refund_date, credit_note_no, rejected_reason
    from refunds where booking_id = ${bookingId} order by passenger_index`)
}
