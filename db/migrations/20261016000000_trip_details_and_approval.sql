-- ── Trip details, and approving a trip as a whole ───────────────────────────
-- Problem: a trip was a name and a status. A company wants to know what a trip
-- is for before it is signed off -- domestic or abroad, billable to a client,
-- under which cost centre, within what budget -- and some companies want the
-- finished trip signed off as a whole. That sign-off is NOT air approval:
-- air approval runs per booking, at booking time (approvals.booking_id); the
-- trip sign-off runs once, when the trip is ready, over everything in it.
--
-- Change:
--   * trips: travel_type, billable, project (free text, optional), currency,
--     budget_amount, cost_centre_id; approval_status + submitted_at for the
--     sign-off (status keeps meaning open/active/completed/...). 'misconfigured':
--     a step of the chain resolved to nobody, so nobody could sign it off.
--   * approvals: a row approves EITHER a booking OR a trip -- booking_id
--     becomes nullable, trip_id is added, and a check keeps exactly one set.
--     The chain machinery (templates, tiers, approvers) is shared; a trip's
--     chain is the one assigned for category 'trip' (categories are free text
--     in the assignment tables, so no change there).
--   * approvals.status also allows 'superseded': a parallel "any one" chain
--     marks the other approvers' rows superseded once one decides, and the
--     constraint refused that write (approvals.supersede).
--   * clients.trip_approval_mode: whether a company signs trips off at all.
--     'not_required' by default: nothing changes for anyone until a TMC turns
--     it on for a client.
--
-- Safe to apply twice.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.trips
  add column if not exists travel_type text,
  add column if not exists billable boolean not null default false,
  add column if not exists project text,
  add column if not exists currency text not null default 'INR',
  add column if not exists budget_amount numeric(12,2),
  add column if not exists cost_centre_id uuid references public.cost_centres (id) on delete set null,
  add column if not exists approval_status text not null default 'none',
  add column if not exists submitted_at timestamptz;

alter table public.trips drop constraint if exists trips_travel_type_check;
alter table public.trips add constraint trips_travel_type_check
  check (travel_type is null or travel_type in ('domestic', 'international'));
alter table public.trips drop constraint if exists trips_currency_check;
alter table public.trips add constraint trips_currency_check check (currency ~ '^[A-Z]{3}$');
alter table public.trips drop constraint if exists trips_budget_amount_check;
alter table public.trips add constraint trips_budget_amount_check check (budget_amount is null or budget_amount >= 0);
alter table public.trips drop constraint if exists trips_approval_status_check;
alter table public.trips add constraint trips_approval_status_check
  check (approval_status in ('none', 'pending', 'approved', 'rejected', 'misconfigured'));

-- ── approvals: a booking's or a trip's ──────────────────────────────────────
alter table public.approvals alter column booking_id drop not null;
alter table public.approvals
  add column if not exists trip_id uuid references public.trips (id) on delete cascade;

alter table public.approvals drop constraint if exists approvals_one_subject_check;
alter table public.approvals add constraint approvals_one_subject_check
  check (num_nonnulls(booking_id, trip_id) = 1);

create index if not exists approvals_trip_tier_idx
  on public.approvals (trip_id, tier) where trip_id is not null;

alter table public.approvals drop constraint if exists approvals_status_check;
alter table public.approvals add constraint approvals_status_check
  check (status in ('pending', 'approved', 'rejected', 'superseded'));

-- ── clients: does this company sign trips off? ──────────────────────────────
alter table public.clients
  add column if not exists trip_approval_mode text not null default 'not_required';
alter table public.clients drop constraint if exists clients_trip_approval_mode_check;
alter table public.clients add constraint clients_trip_approval_mode_check
  check (trip_approval_mode in ('not_required', 'on_submit'));
