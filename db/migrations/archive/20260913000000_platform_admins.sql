-- ============================================================================
-- Platform admins: the identity above every tenant
--
-- Onboarding a TMC has been a Postman call carrying INTERNAL_API_SECRET. That
-- works, but it cannot become a screen, and the reason is worth stating plainly:
-- A BROWSER CANNOT HOLD THAT SECRET. Anything shipped to a page is public, so a
-- UI over the existing route would mean publishing the key that creates tenants.
--
-- So this surface needs a real identity, and specifically one that a compromised
-- tmc_admin cannot reach — it creates TMCs and their first admins, which is
-- strictly above every existing role.
--
-- WHY NOT A ROLE ON `employees`
-- `employees` is tenant-scoped: every row belongs to a tmc_id or a client_id,
-- and its `role` column already holds the lowest privileges in the system.
-- Putting the highest one in the same column is how privilege escalation
-- happens — one missed check on a role string and a TC becomes a platform
-- admin. A separate table means the check is a different query against a
-- different table, and no amount of confusion about `role` can grant it.
--
-- Keyed on auth.users rather than employees for the same reason: a platform
-- admin is Amadeus staff, not a member of any TMC, and giving them an employees
-- row would force them into a tenant they do not belong to.
--
-- NO SELF-SERVE PATH, AND NO UI THAT GRANTS THIS.
-- Rows are inserted by hand, from the SQL editor, by someone who already has
-- database access. There is deliberately no endpoint that writes to this table:
-- an "add platform admin" button is a privilege-escalation target, and the
-- population is small enough that a manual insert is not a burden.
-- ============================================================================

begin;

create table if not exists platform_admins (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  -- Denormalised copy of the email, for display on the platform screen without
  -- reaching into auth.users on every render. Not the identity — user_id is.
  email      text,
  -- Who this is and why they have it. Free text, and worth filling in: a bare
  -- list of UUIDs is unauditable.
  note       text,
  created_at timestamptz not null default now()
);

comment on table platform_admins is
  'Amadeus staff who can create TMCs and invite their first admins. Above every '
  'tenant role, seeded by hand only — no endpoint writes to this table. Not a '
  'value on employees.role, deliberately: that column is tenant-scoped and '
  'holds the lowest privileges in the system.';

-- Deny-by-default, like every other table here. Every read goes through the
-- service-role client after the route has checked authn itself, so no policy is
-- needed — and NOT having one is what keeps the list of platform admins
-- unreadable with an anon key.
alter table platform_admins enable row level security;

-- ----------------------------------------------------------------------------
-- Seeding, by hand
--
-- Left commented rather than executed: this migration must not decide who runs
-- the platform. Run the insert yourself, with your own auth user id.
--
--   insert into platform_admins (user_id, email, note)
--   select id, email, 'Initial platform admin'
--   from auth.users
--   where email = 'you@example.com'
--   on conflict (user_id) do nothing;
--
-- Until at least one row exists, /platform returns 404 for everyone, which is
-- the correct closed state rather than a lockout to work around.
-- ----------------------------------------------------------------------------

commit;
