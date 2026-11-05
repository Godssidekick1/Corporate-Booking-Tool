-- ── Cancelling a booking ────────────────────────────────────────────────────
-- Until now a booking could be made but never undone from here: the
-- provider's CancelBooking call existed in the client and nothing used it.
-- POST /api/book/[bookingId]/cancel now cancels, and this records it.
--
--   bookings.cancelled_at, cancelled_by, cancellation_reason
--       who cancelled, when and why (the reason is also sent to the provider
--       as CancellationRemarks)
--   bookings.cancellation
--       what the provider answered: its cancel and change-request statuses,
--       the refund it reports, the airline's cancellation charge and the tax
--       on it, its reference numbers. Airline-side money: the desk sees all
--       of it, a traveller only the charges (the route decides).
--   bookings.cancel_started_at
--       set while a cancellation is with the provider, so a second click (or
--       a second tab) cannot send a second one. Cleared when the provider
--       refuses; one older than two minutes counts as abandoned.
--   bookings.status 'cancel_requested'
--       the provider accepted the request but has not yet confirmed it
--       cancelled (a ticketed booking may be settled by the airline later)
--   approvals.status 'withdrawn'
--       the traveller or booker cancelled a booking that was still waiting
--       for approval; its open steps close as withdrawn, not rejected
--
-- Safe to apply twice.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.bookings
  add column if not exists cancelled_at timestamptz,
  add column if not exists cancelled_by uuid references public.employees(id) on delete set null,
  add column if not exists cancellation_reason text,
  add column if not exists cancellation jsonb,
  add column if not exists cancel_started_at timestamptz;

create index if not exists bookings_cancelled_by_fk_idx on public.bookings (cancelled_by);

alter table public.bookings drop constraint if exists bookings_cancellation_reason_check;
alter table public.bookings add constraint bookings_cancellation_reason_check
  check (cancellation_reason is null or char_length(cancellation_reason) <= 500);

alter table public.bookings drop constraint if exists bookings_status_check;
alter table public.bookings add constraint bookings_status_check
  check (status = any (array['pending_approval', 'approved', 'approval_misconfigured', 'rejected', 'priced',
    'passenger_added', 'held', 'ticketed', 'cancel_requested', 'cancelled', 'failed']));

alter table public.approvals drop constraint if exists approvals_status_check;
alter table public.approvals add constraint approvals_status_check
  check (status = any (array['pending', 'approved', 'rejected', 'superseded', 'escalated', 'withdrawn']));
