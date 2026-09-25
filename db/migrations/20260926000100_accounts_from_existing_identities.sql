-- ============================================================================
-- One account per existing identity, and the two foreign keys moved from
-- auth.users to accounts (Stage 3, phase 3)
--
-- WHERE SUPABASE HOSTS THIS DATABASE, auth.users is right here, in the same
-- database. So the import is an INSERT ... SELECT, not an export: ids,
-- emails, confirmation times and the bcrypt password hashes come across as
-- they are. People keep their passwords. Only people the application knows are
-- imported (an employees row or a platform_admins row points at them). GoTrue
-- users that nothing references are orphans and stay behind.
--
--   - must_set_password comes from user_metadata, where GoTrue kept it. From
--     here on it is must_change_password, a column only the server writes.
--   - A banned GoTrue user, or one with no password yet (an invite not
--     accepted), gets no password hash. They need a new invite or a reset.
--
-- WHERE IT DOES NOT (a local restore), auth.users is absent. Every employee
-- with an auth_user_id, and every platform admin, gets an account with no
-- password. Setting one is "Forgot password" on the sign-in page. In
-- development the email is printed to the server console.
--
-- Sessions are NOT carried over. Everyone signs in once after the switch.
--
-- Idempotent: every insert is ON CONFLICT DO NOTHING, and the constraints are
-- dropped before they are added.
-- ============================================================================

do $$
begin
  if to_regclass('auth.users') is not null then
    execute $import$
      insert into public.accounts
        (id, email, password_hash, must_change_password, email_verified_at, last_sign_in_at, created_at)
      select
        u.id,
        lower(btrim(u.email)),
        case
          when u.banned_until is not null and u.banned_until > now() then null
          else nullif(u.encrypted_password, '')
        end,
        coalesce((u.raw_user_meta_data ->> 'must_set_password')::boolean, false),
        u.email_confirmed_at,
        u.last_sign_in_at,
        coalesce(u.created_at, now())
      from auth.users u
      where u.email is not null
        and u.deleted_at is null
        and (
          exists (select 1 from public.employees e where e.id = u.id or e.auth_user_id = u.id)
          or exists (select 1 from public.platform_admins p where p.user_id = u.id)
        )
      order by u.created_at, u.id
      on conflict do nothing
    $import$;
  end if;
end $$;

-- Identities with no auth.users row to copy from: a local restore.
insert into public.accounts (id, email, created_at)
select e.auth_user_id, lower(btrim(e.email)), e.created_at
from public.employees e
where e.auth_user_id is not null and e.email is not null
order by e.created_at, e.id
on conflict do nothing;

insert into public.accounts (id, email, created_at)
select p.user_id, lower(btrim(p.email)), p.created_at
from public.platform_admins p
where p.email is not null
order by p.created_at, p.user_id
on conflict do nothing;

-- employees.id already equals the account id wherever an account exists (both
-- were the GoTrue user id). Older invites left auth_user_id null even so.
update public.employees e
   set auth_user_id = e.id
 where e.auth_user_id is null
   and exists (select 1 from public.accounts a where a.id = e.id);

-- ── employees.auth_user_id: auth.users -> accounts ───────────────────────────
alter table public.employees drop constraint if exists employees_auth_user_id_fkey;

update public.employees e
   set auth_user_id = null
 where e.auth_user_id is not null
   and not exists (select 1 from public.accounts a where a.id = e.auth_user_id);

alter table public.employees
  add constraint employees_auth_user_id_fkey
  foreign key (auth_user_id) references public.accounts (id) on delete set null;

-- ── platform_admins.user_id: auth.users -> accounts ──────────────────────────
alter table public.platform_admins drop constraint if exists platform_admins_user_id_fkey;

do $$
declare
  missing text;
begin
  select string_agg(p.user_id::text, ', ') into missing
    from public.platform_admins p
   where not exists (select 1 from public.accounts a where a.id = p.user_id);
  if missing is not null then
    raise exception 'platform admin(s) with no account and no email to create one from: %', missing;
  end if;
end $$;

alter table public.platform_admins
  add constraint platform_admins_user_id_fkey
  foreign key (user_id) references public.accounts (id) on delete cascade;
