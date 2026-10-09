-- ── Deal code coverage keeps the closest losers, and a count of the rest ──────
-- Problem: each stored row carried every deal its winner beat. At 10,000
-- clients that was 39 MB of report, almost all of it the losers, and storing
-- it took 4.9 s of a 6 s rebuild (npm run scale) -- for a table cell that
-- printed dozens of codes no one could read.
--
-- Change: the row keeps the closest losers (app/lib/coverage/dealCoverage.ts
-- says how many) and `beat_more`, how many others there were. Safe to apply
-- twice.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.deal_code_coverage add column if not exists beat_more integer not null default 0;
