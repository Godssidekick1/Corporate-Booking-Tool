-- ── Finding the trips someone set up for others ─────────────────────────────
-- Problem: My trips' "Arranged for others" (trips.arrangedFor) starts from the
-- trips a person set up for a colleague -- trips.arranged_by -- which has no
-- index, so each look would read every trip.
--
-- Change: a partial index on arranged_by; most trips are the traveller's own
-- (arranged_by null) and are left out of it.
--
-- Safe to apply twice.
-- ─────────────────────────────────────────────────────────────────────────────

create index if not exists trips_arranged_by_idx
  on public.trips (arranged_by, created_at desc)
  where arranged_by is not null;
