-- ── cbt_app may read the migration history ───────────────────────────────────
-- Problem: 20261009000300_app_role gave the application's restricted role no
-- access to schema_migrations at all, and /api/health counts the applied
-- migrations to report whether the database is up to date (found by running
-- the test suite as that role).
--
-- Change: read only. SELECT, and a read-only `app_access` policy (the table
-- has row-level security, like every table). Writing the history stays with
-- the owner that runs migrations. Safe to apply twice.
-- ─────────────────────────────────────────────────────────────────────────────

grant select on public.schema_migrations to cbt_app;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'schema_migrations' and policyname = 'app_access') then
    create policy app_access on public.schema_migrations for select to cbt_app using (true);
  end if;
end $$;
