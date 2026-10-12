-- ── The dashboard's booking index carries the tenant too ─────────────────────
-- Problem: the TMC dashboard counts were answered from
-- bookings_client_created_idx (20261011000100) without reading booking rows.
-- Row-level security now also checks each booking's tmc_id
-- (20261012000100_tenant_columns), which that index does not hold, so every
-- count read all the booking rows again: 1.7 s at 60,000 bookings as the
-- app's own login (npm run scale).
--
-- Change: the same index, with tmc_id included. Safe to apply twice.
-- ─────────────────────────────────────────────────────────────────────────────

drop index if exists public.bookings_client_created_idx;
create index bookings_client_created_idx
  on public.bookings (client_id, created_at) include (total_cost, tmc_id);
