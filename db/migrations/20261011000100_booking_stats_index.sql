-- ── An index the TMC dashboard's counts can be answered from ─────────────────
-- Problem: the dashboard counts bookings, spend, the last 30 days and an
-- 8-week trend per client. Each needed only client_id, created_at and
-- total_cost, yet every count read the whole booking row (about 3 KB of
-- itinerary and fare JSON each): 537 ms at 60,000 bookings (npm run scale).
--
-- Change: one index holding exactly those three columns, so the counts are
-- read from the index alone. It starts with client_id, so it also serves every
-- lookup idx_bookings_company did, which is dropped. Safe to apply twice.
-- ─────────────────────────────────────────────────────────────────────────────

create index if not exists bookings_client_created_idx
  on public.bookings (client_id, created_at) include (total_cost);
drop index if exists public.idx_bookings_company;
