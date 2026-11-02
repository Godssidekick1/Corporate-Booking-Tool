-- ── The sign-in tables answer to the system scope only ──────────────────────
-- Problem: accounts, sessions, auth_tokens, auth_attempts, platform_admins
-- and rate_limits were left allow-all to the app role
-- (20261012000000_tenant_policies, "shared"): they hold no tenant's rows, and
-- only app/lib/auth read them. But allow-all meant any query in a tenant's
-- request could read every account's password hash and every live session,
-- across tenants, had one been written to.
--
-- Change: each admits rows only when app.scope is 'system'. The app reaches
-- them only through app/lib/repositories/{accounts,rateLimits}.ts and
-- tmcs.platformAdmin, which run every statement as the system
-- (app/lib/db/systemScope.ts), including inside a tenant's transaction.
--
-- One tenant-side question remains -- "can this person sign in?", a column of
-- the people lists -- and it gets one narrow answer: account_can_sign_in()
-- says yes or no for one id, and nothing else. It runs as the owner (security
-- definer) with a fixed search_path, so it cannot be redirected to another
-- table. The id it is asked about comes from an employees row the caller can
-- already see.
--
-- The owner bypasses row-level security: migrations and scripts unaffected.
-- Safe to apply twice.
-- ─────────────────────────────────────────────────────────────────────────────

do $$
declare
  t text;
begin
  foreach t in array array['accounts', 'sessions', 'auth_tokens', 'auth_attempts', 'platform_admins', 'rate_limits']
  loop
    execute format('drop policy if exists app_access on public.%I', t);
    execute format(
      'create policy app_access on public.%I to cbt_app
         using (public.app_scope() = ''system'')
         with check (public.app_scope() = ''system'')', t);
  end loop;
end $$;

create or replace function public.account_can_sign_in(employee uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.accounts a where a.id = employee and a.password_hash is not null)
$$;

revoke all on function public.account_can_sign_in(uuid) from public;
grant execute on function public.account_can_sign_in(uuid) to cbt_app;
