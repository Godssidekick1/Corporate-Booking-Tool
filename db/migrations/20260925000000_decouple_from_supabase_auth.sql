-- ============================================================================
-- Remove the schema's dependencies on Supabase auth (Stage 3, phase 1)
--
-- 1. The 17 row-level-security policies. None of them has ever applied to the
--    application: it connects as the tables' owner, which bypasses RLS. They
--    were also stale.
--      - 12 read current_setting('app.current_company_id'), a setting nothing
--        has set since the company -> client rename.
--      - 5 call auth.uid() (directly, or through the two helper functions
--        below), which exists only on Supabase.
--    Real tenant RLS is a later stage, written against our own session and not
--    Supabase's JWT.
--
-- 2. current_client_id() and current_employee_role(). Only those policies
--    called them. Both read auth.uid().
--
-- 3. Row level security STAYS ENABLED on every table, now with no policies.
--    That means deny-by-default for every role except the owner, which is the
--    one the application uses.
--
-- 4. Every privilege anon, authenticated and service_role held on public, now
--    and by default for new objects. While Supabase hosts this database, its
--    Data API (PostgREST) serves public to anyone holding the anon key, which
--    was shipped to browsers. Nothing in the application uses that API any
--    more (Stage 2). Until now the only thing standing between it and the data
--    was the policies above, and the new auth tables would have been exposed
--    the moment they were created. The roles exist only on Supabase and in a
--    local restore, so this step is skipped wherever they are absent.
--
-- employees.auth_user_id and platform_admins.user_id still reference auth.users
-- on Supabase. Those two constraints move to the application's own accounts
-- table in the migration that creates it.
-- ============================================================================

drop policy if exists rls_approvals on public.approvals;
drop policy if exists rls_audit_log on public.audit_log;
drop policy if exists rls_bands on public.bands;
drop policy if exists rls_bookings on public.bookings;
drop policy if exists "branches: tmc staff read" on public.client_groups;
drop policy if exists rls_companies on public.clients;
drop policy if exists "Employees: admin update client" on public.employees;
drop policy if exists "Employees: read own client" on public.employees;
drop policy if exists "Employees: update own row" on public.employees;
drop policy if exists rls_employees on public.employees;
drop policy if exists "trip_expenses: delete own client" on public.trip_expenses;
drop policy if exists "trip_expenses: insert own client" on public.trip_expenses;
drop policy if exists "trip_expenses: read own client" on public.trip_expenses;
drop policy if exists "trip_expenses: update own client" on public.trip_expenses;
drop policy if exists "trips: insert own client" on public.trips;
drop policy if exists "trips: read own client" on public.trips;
drop policy if exists "trips: update own client" on public.trips;

drop function if exists public.current_client_id();
drop function if exists public.current_employee_role();

do $$
declare
  r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select from pg_roles where rolname = r) then
      execute format('revoke all on all tables in schema public from %I', r);
      execute format('revoke all on all sequences in schema public from %I', r);
      execute format('revoke all on all functions in schema public from %I', r);
      execute format('alter default privileges in schema public revoke all on tables from %I', r);
      execute format('alter default privileges in schema public revoke all on sequences from %I', r);
      execute format('alter default privileges in schema public revoke all on functions from %I', r);
    end if;
  end loop;
end $$;
