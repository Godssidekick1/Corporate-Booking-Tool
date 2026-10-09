-- ── Indexes for the lists that grow every day ────────────────────────────────
-- Problem: bookings, approvals and trips grow with every working day, and the
-- lists over them had no index matching how they are read:
--   * an approver's 30-day history (approver, decided, newest first) was
--     served by no index at all -- the only approver index is limited to
--     pending rows -- so it read every approval ever made;
--   * a traveller's trips page (owner, newest first) sorted all their trips;
--   * a traveller's bookings sorted all their bookings.
--
-- Change: one index per read, in the order the list is shown, so a page is
-- read straight off the index. idx_bookings_employee is dropped: the new
-- bookings index starts with the same column and serves every lookup it did.
-- Safe to apply twice.
-- ─────────────────────────────────────────────────────────────────────────────

create index if not exists approvals_approver_decided_idx
  on public.approvals (approver_id, actioned_at desc)
  where status in ('approved', 'rejected');

create index if not exists approvals_approver_pending_idx
  on public.approvals (approver_id, created_at)
  where status = 'pending';
-- Superseded by the one above (same rows, and also in queue order).
drop index if exists public.idx_approvals_approver_pending;

create index if not exists bookings_employee_recent_idx
  on public.bookings (employee_id, created_at desc);
drop index if exists public.idx_bookings_employee;

create index if not exists trips_owner_recent_idx
  on public.trips (created_by, created_at desc)
  where status <> 'deleted';
