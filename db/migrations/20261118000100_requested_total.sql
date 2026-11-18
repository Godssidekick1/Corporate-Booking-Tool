-- ── The price an approval was asked at; refreshes stay with the approver ─────
-- Problem: a refreshed fare that rose and was out of policy went back to the
-- traveller to ask again (status reapproval_needed). On 2026-11-18 that sent
-- back a booking that was already out of policy for a ₹34 rise. Decided
-- (user, 2026-11-18): a refresh never takes a booking away from the approver.
-- They see the new price, how much it moved since it was asked for, and the
-- new policy verdict, and decide.
--
-- Change:
--   1. bookings.requested_total: the sell total when approval was asked for
--      (set at add-passenger, and again when a fare rise at confirmation
--      starts a new round). A refresh changes sell_total, never this, so the
--      approver's card can show "requested at ₹X · now ₹Y (+₹Z)".
--      Backfilled from the sell total; a booking already refreshed upward and
--      sent back takes the price from its audit record.
--   2. Bookings sent back (reapproval_needed) return to their approver: the
--      steps the send-back closed are pending again. The status value stays
--      allowed (bookings_status_check) but nothing sets it any more.
-- Safe to apply twice.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.bookings add column if not exists requested_total numeric(12, 2);

update public.bookings
   set requested_total = coalesce(sell_total, total_cost)
 where requested_total is null;

-- Sent back after a rise: the price asked for is the one before the refresh.
update public.bookings b
   set requested_total = (a.metadata ->> 'previousTotal')::numeric
  from (
    select distinct on (entity_id) entity_id, metadata
      from public.audit_log
     where action = 'booking.returned_to_traveller' and metadata ? 'previousTotal'
     order by entity_id, created_at
  ) a
 where b.id = a.entity_id and b.status = 'reapproval_needed';

-- Reopen the steps the send-back closed (its note starts "The fare rose from").
update public.approvals ap
   set status = 'pending', actioned_at = null, decision_note = null
  from public.bookings b
 where b.id = ap.booking_id
   and b.status = 'reapproval_needed'
   and ap.status = 'superseded'
   and ap.decision_note like 'The fare rose from %';

update public.bookings
   set status = 'pending_approval', updated_at = now()
 where status = 'reapproval_needed';
