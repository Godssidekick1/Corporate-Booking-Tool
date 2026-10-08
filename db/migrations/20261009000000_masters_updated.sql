-- ── Who last changed a bucket or a branch ────────────────────────────────────
-- Problem: the Buckets and Branches masters list when each row was last
-- changed and by whom, like the other masters. Buckets had only created_at;
-- branches had updated_at but no record of who.
--
-- Change:
--   * buckets.updated_at (now; existing rows take their created_at) and
--     buckets.updated_by -- set when the details or the member clients change,
--     from the bucket master or from a client's Allocations tab;
--   * branches.updated_by -- set with updated_at on every edit.
-- updated_by is the TMC staff member (employees), cleared if they are deleted,
-- like created_by.
--
-- Safe to apply twice (if not exists).
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.buckets add column if not exists updated_at timestamptz;
update public.buckets set updated_at = created_at where updated_at is null;
alter table public.buckets alter column updated_at set default now();
alter table public.buckets alter column updated_at set not null;

alter table public.buckets add column if not exists updated_by uuid
  references public.employees (id) on delete set null;

alter table public.branches add column if not exists updated_by uuid
  references public.employees (id) on delete set null;
