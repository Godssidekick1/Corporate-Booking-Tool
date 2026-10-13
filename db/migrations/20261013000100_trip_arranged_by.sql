-- ── Trips set up for a traveller by someone else ─────────────────────────────
-- Problem: the travel desk and corporate admins book for people
-- (20261013000000_book_on_behalf), but a trip could only be created by the
-- traveller for themself, so desk bookings sat under no trip at all.
--
-- Change: trips.arranged_by -- who set the trip up when it was not the
-- traveller (the desk, or a colleague who is an admin). created_by stays the
-- trip's OWNER, the traveller: it is what their trips list, the "trip belongs
-- to the traveller" check at add-passenger and trips_owner_recent_idx read.
-- Null when the traveller created it.
--
-- Safe to apply twice.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.trips
  add column if not exists arranged_by uuid references public.employees (id) on delete set null;
