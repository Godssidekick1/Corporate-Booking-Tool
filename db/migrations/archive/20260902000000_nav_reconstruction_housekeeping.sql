-- ─────────────────────────────────────────────────────────────────────────────
-- Housekeeping alongside the navigation reconstruction. Two unrelated fixes,
-- both no-ops against the current live database.
-- ─────────────────────────────────────────────────────────────────────────────

begin;

-- ── 1. employees.branch_id -> client_group_id ────────────────────────────────
-- The column is a foreign key to client_groups.id, so "branch_id" names the
-- wrong thing entirely: a client group is a grouping of the TMC's CLIENTS, not
-- one of the TMC's own offices.
--
-- That mattered as soon as a real Branch Master was planned — the TMC's offices
-- need a branches table, and employees would then have two columns called
-- branch-something meaning opposite things.
--
-- Verified zero references anywhere in the application before renaming, so this
-- is purely a name change. Frees branch_id for the real thing later.
alter table employees rename column branch_id to client_group_id;

comment on column employees.client_group_id is
  'The client group this employee''s company belongs to. Not a TMC branch — that is a separate concept, not yet built.';

-- ── 2. Check in the permission tables ────────────────────────────────────────
-- requireTmcPermission() reads both of these on every gated request, but
-- neither has ever had DDL in this repo — they were created directly in the
-- Supabase dashboard. Anyone rebuilding from migrations got an application that
-- compiles, runs, and denies every travel counsellor everything, with no
-- obvious cause.
--
-- IF NOT EXISTS so this is inert against the live database. Shapes match what
-- is actually there today.

create table if not exists employee_permissions (
  employee_id    uuid not null references employees(id) on delete cascade,
  -- No enum or check constraint deliberately: the valid set lives in
  -- app/lib/permissions/permissionKeys.ts, and adding a key should not require
  -- a migration. The routes validate against it before writing.
  permission_key text not null,
  granted_by     uuid references employees(id) on delete set null,
  granted_at     timestamptz not null default now(),

  primary key (employee_id, permission_key)
);

create table if not exists employee_company_access (
  employee_id uuid not null references employees(id) on delete cascade,
  company_id  uuid not null references companies(id) on delete cascade,
  granted_by  uuid references employees(id) on delete set null,
  granted_at  timestamptz not null default now(),

  primary key (employee_id, company_id)
);

-- Both are looked up by employee on every permission check.
create index if not exists employee_permissions_employee_idx
  on employee_permissions (employee_id);

create index if not exists employee_company_access_employee_idx
  on employee_company_access (employee_id);

-- Deny-by-default, matching every other table in this schema: the routes reach
-- these through the service-role client, which bypasses RLS. Enabling it closes
-- direct anon-key access to who-can-do-what.
alter table employee_permissions     enable row level security;
alter table employee_company_access  enable row level security;

commit;
