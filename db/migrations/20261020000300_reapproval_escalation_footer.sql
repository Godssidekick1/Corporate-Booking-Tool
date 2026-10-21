-- ── Corporate settings: re-approval, escalation, ticket footer ───────────────
-- Problems:
--   * An approved fare re-priced at booking (the airline session expired while
--     it waited) was booked at whatever the airline now asked, however much
--     higher than what the approver signed off.
--   * An approval could wait forever: approvals.escalates_at existed and
--     nothing set or read it.
--   * A company could not put its own words on its e-tickets.
--
-- Change, on clients:
--   * fare_rise_reapproval + fare_rise_reapproval_unit ('pct' | 'inr'): a
--     re-priced fare that rose by more than this goes back for approval
--     instead of being booked. Null: never (today's behaviour).
--   * approval_escalation_hours: an approval waiting this long passes to the
--     approver's own manager, once. Null: never.
--   * ticket_footer_text: shown at the foot of the company's e-tickets.
-- And on approvals:
--   * escalated_from: the row this one took over from;
--   * status may be 'escalated' (the row handed over; no longer decidable).
--
-- Safe to apply twice.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.clients add column if not exists fare_rise_reapproval numeric(12,2);
alter table public.clients add column if not exists fare_rise_reapproval_unit text not null default 'pct';
alter table public.clients add column if not exists approval_escalation_hours integer;
alter table public.clients add column if not exists ticket_footer_text text;

alter table public.clients drop constraint if exists clients_fare_rise_reapproval_check;
alter table public.clients add constraint clients_fare_rise_reapproval_check
  check (fare_rise_reapproval is null or fare_rise_reapproval >= 0);
alter table public.clients drop constraint if exists clients_fare_rise_reapproval_unit_check;
alter table public.clients add constraint clients_fare_rise_reapproval_unit_check
  check (fare_rise_reapproval_unit in ('pct', 'inr'));
alter table public.clients drop constraint if exists clients_approval_escalation_hours_check;
alter table public.clients add constraint clients_approval_escalation_hours_check
  check (approval_escalation_hours is null or approval_escalation_hours between 1 and 720);
alter table public.clients drop constraint if exists clients_ticket_footer_text_check;
alter table public.clients add constraint clients_ticket_footer_text_check
  check (ticket_footer_text is null or char_length(ticket_footer_text) <= 500);

alter table public.approvals add column if not exists escalated_from uuid references public.approvals(id) on delete set null;
create index if not exists approvals_escalated_from_idx on public.approvals (escalated_from);
create index if not exists approvals_escalates_at_idx on public.approvals (escalates_at)
  where status = 'pending' and escalates_at is not null;

alter table public.approvals drop constraint if exists approvals_status_check;
alter table public.approvals add constraint approvals_status_check
  check (status in ('pending', 'approved', 'rejected', 'superseded', 'escalated'));
