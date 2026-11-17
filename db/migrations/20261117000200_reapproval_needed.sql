-- ── A booking sent back to the traveller to ask for approval again ───────────
-- Problem: an approver's "Refresh fare" can find the fare has risen beyond the
-- traveller's policy (past its grace). The approver should not decide on a
-- price the traveller never asked for; the traveller must ask again, with a
-- reason, or choose another flight (user, 2026-11-17).
--
-- Change: bookings.status gains 'reapproval_needed'. The open approval steps
-- are superseded; the traveller's "Ask for approval again" starts a new round
-- (pending_approval), and choosing another flight leaves this one behind.
-- Safe to apply twice.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.bookings drop constraint if exists bookings_status_check;
alter table public.bookings add constraint bookings_status_check
  check (status = any (array['pending_approval', 'approved', 'approval_misconfigured', 'rejected', 'priced',
    'passenger_added', 'held', 'ticketed', 'cancel_requested', 'cancelled', 'failed', 'reapproval_needed']));
