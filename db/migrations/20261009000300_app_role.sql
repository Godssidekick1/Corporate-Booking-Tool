-- ── A restricted role for the application ────────────────────────────────────
-- Problem: the application connects as the owner of every table. Anything that
-- ran code inside the app -- a dependency gone bad, a bug that let SQL text
-- through -- could drop or alter tables, create functions, disable row-level
-- security or rewrite the migration history.
--
-- Change: `cbt_app`, a role that can read and write rows and nothing else.
--   * SELECT/INSERT/UPDATE/DELETE on the tables and views, USAGE on sequences,
--     EXECUTE on functions -- now and for everything migrations create later
--     (default privileges of the role that runs migrations);
--   * no DDL, owns nothing, no access to schema_migrations;
--   * NOLOGIN: the login that uses it is created per environment, with a
--     password that never appears in the repository (docs/database-roles.md):
--       create role cbt_app_login login password '…' in role cbt_app;
--
-- Row-level security is on for every table with no policies (deny by
-- default), which a non-owner obeys: without a policy cbt_app would see no
-- rows at all. Each table gets an `app_access` policy for cbt_app that allows
-- everything -- the same access it has today -- and is the place tenant rules
-- replace it table by table. tests/schema.test.ts fails if a table is missing
-- it, so a new table cannot silently become invisible to the app.
--
-- The owner (migrations) still bypasses row-level security. Safe to apply
-- twice.
-- ─────────────────────────────────────────────────────────────────────────────

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'cbt_app') then
    create role cbt_app nologin noinherit;
  end if;
end $$;

grant usage on schema public to cbt_app;
grant select, insert, update, delete on all tables in schema public to cbt_app;
grant usage, select on all sequences in schema public to cbt_app;
grant execute on all functions in schema public to cbt_app;
revoke all on public.schema_migrations from cbt_app;

alter default privileges in schema public grant select, insert, update, delete on tables to cbt_app;
alter default privileges in schema public grant usage, select on sequences to cbt_app;
alter default privileges in schema public grant execute on functions to cbt_app;

do $$
declare t record;
begin
  for t in
    select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity and c.relname <> 'schema_migrations'
  loop
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t.relname and policyname = 'app_access') then
      execute format('create policy app_access on public.%I to cbt_app using (true) with check (true)', t.relname);
    end if;
  end loop;
end $$;
