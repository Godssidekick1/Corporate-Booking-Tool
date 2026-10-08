-- ── Indexes for "what reaches this client" ───────────────────────────────────
-- Problem: pricing a booking asks which deal codes, forms of payment and
-- commercial rules reach the traveller's client -- assigned to the client, its
-- client group, or a bucket it is in. The three assignment tables were indexed
-- only by tenant and by the thing assigned (deal_code_id / fop_id / rule_id),
-- so the code read every assignment of the TMC and filtered in JavaScript:
-- 121 ms per pricing request at 50,000 deal-code assignments, growing with the
-- whole TMC (tests/scale, `npm run scale`).
--
-- Change: a partial index per target column on each table, for the lookup
-- that now asks for exactly those rows (app/lib/db/fragments.ts `reaching`).
-- Partial, because each column is only filled for its own kind of target.
--
-- Safe to apply twice (if not exists). Plain CREATE INDEX (not CONCURRENTLY):
-- the runner applies each file in a transaction, and these tables are small
-- enough today that the brief write lock does not matter.
-- ─────────────────────────────────────────────────────────────────────────────

create index if not exists deal_code_assignments_client_idx on public.deal_code_assignments (client_id) where client_id is not null;
create index if not exists deal_code_assignments_group_idx  on public.deal_code_assignments (client_group_id) where client_group_id is not null;
create index if not exists deal_code_assignments_bucket_idx on public.deal_code_assignments (bucket_id) where bucket_id is not null;

create index if not exists fop_assignments_client_idx on public.fop_assignments (client_id) where client_id is not null;
create index if not exists fop_assignments_group_idx  on public.fop_assignments (client_group_id) where client_group_id is not null;
create index if not exists fop_assignments_bucket_idx on public.fop_assignments (bucket_id) where bucket_id is not null;

create index if not exists commercial_rule_assignments_client_idx on public.commercial_rule_assignments (client_id) where client_id is not null;
create index if not exists commercial_rule_assignments_group_idx  on public.commercial_rule_assignments (client_group_id) where client_group_id is not null;
create index if not exists commercial_rule_assignments_bucket_idx on public.commercial_rule_assignments (bucket_id) where bucket_id is not null;
