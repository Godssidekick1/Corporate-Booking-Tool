-- ── The leftover auth schema goes ──────────────────────────────────────────
-- Problem: every database restored from the old schema capture carries an
-- `auth` schema holding one function, auth.uid(): a stand-in the old restore
-- script created so that policies written for the previous hosted platform
-- would load. Those policies went in 20260925000000; nothing has called the
-- function since (tests/schema.test.ts checks no policy, function or view in
-- public refers to auth), and sign-in has its own tables (accounts, sessions).
--
-- Change: drop the function, then the schema if that leaves it empty. Only
-- the stand-in: a schema that also holds a users table is a real
-- authentication service's, and is left alone. Safe to apply twice.
-- ─────────────────────────────────────────────────────────────────────────────

do $$
begin
  if to_regnamespace('auth') is null or to_regclass('auth.users') is not null then
    return;
  end if;
  drop function if exists auth.uid();
  if not exists (select 1 from pg_class where relnamespace = 'auth'::regnamespace)
     and not exists (select 1 from pg_proc where pronamespace = 'auth'::regnamespace)
     and not exists (select 1 from pg_type where typnamespace = 'auth'::regnamespace) then
    drop schema auth;
  end if;
end $$;
