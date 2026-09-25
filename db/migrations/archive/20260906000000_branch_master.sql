-- ============================================================================
-- Branch Master
--
-- A TMC is not one office. A travel management company with desks in Delhi,
-- Mumbai and Bangalore holds a separate GST registration per state, settles
-- separately, and staffs each branch with its own counsellors.
--
-- WHAT A BRANCH ACTUALLY IS HERE
--   Every address field on the screen this replaces is GST-prefixed, and that
--   is not decoration: in India GST registers PER STATE, so each branch is a
--   distinct registered place of business raising its own tax invoices. The
--   address stored is the one printed on the invoice, and gst_name is the legal
--   name on the certificate -- routinely different from the working name
--   ("Delhi - CP" vs "Acme Travel Services Private Limited").
--
-- THIS EXISTS BEFORE AGENCY FOP ON PURPOSE
--   An agency form of payment settles against a specific branch's IATA office:
--   the card lodged in Delhi is not the one Mumbai tickets on. Building FOP
--   first would have meant building it wrong and migrating it later.
--
-- WHAT IT IS NOT
--   Not a permission boundary. Which clients a counsellor can reach is
--   employee_client_access, which already exists; putting somebody in the Delhi
--   branch grants them nothing.
--
--   Not a client group. A client group groups the TMC's CLIENTS; a branch is one
--   of the TMC's OWN offices. Those were one confused column until
--   20260902000000 renamed employees.branch_id to client_group_id -- freeing
--   branch_id for exactly this table, with a comment saying so.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. Branches
-- ----------------------------------------------------------------------------
create table if not exists branches (
  id                 uuid primary key default gen_random_uuid(),
  tmc_id             uuid not null references tmcs(id) on delete cascade,

  -- Identity as the desk thinks of it.
  name               text not null,
  branch_no          text,
  profit_centre_code text,

  -- Registered GST details. The invoice identity, not a postal address.
  gst_number         text,
  gst_name           text,
  gst_email          text,
  gst_contact        text,
  gst_address_1      text,
  gst_address_2      text,
  country            text not null default 'India',
  gst_state          text,
  gst_city           text,
  gst_zip            text,

  -- Settlement. RECORDED, NOT ROUTED: AMADEUS_CLIENT_CODE is a single env var
  -- used on every call, so the whole application is one GDS office today.
  -- These are the settlement identity Agency FOP will key against, and nothing
  -- in the UI may imply that setting them changes where a booking is ticketed.
  iata_number        text,
  office_id          text,

  is_head_office     boolean not null default false,

  -- A closed branch keeps its invoice and booking history, so retiring one is a
  -- status change and never a delete.
  status             text not null default 'active' check (status in ('active', 'inactive')),

  -- A branch outlives whoever created it.
  created_by         uuid references employees(id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  unique (tmc_id, name)
);

create index if not exists branches_tmc_idx on branches (tmc_id);

-- Unique only where present: branch_no is optional, and several NULLs must not
-- collide. A plain unique constraint would allow them anyway (NULLs never
-- compare equal), but stating it as a partial index says the intent out loud.
create unique index if not exists branches_no_uniq
  on branches (tmc_id, branch_no) where branch_no is not null;

-- At most one head office per TMC. Partial, so the many `false` rows do not
-- fight each other.
create unique index if not exists branches_one_head_office
  on branches (tmc_id) where is_head_office;

-- gst_number is deliberately NOT format-checked here. The cross-check against
-- gst_state, the checksum and the PAN derivation all live in
-- app/lib/data/gstin.ts and WARN rather than reject -- the same call already
-- made for client GST numbers. This is a TMC recording its own certificate, and
-- refusing an unusual-but-real identifier is worse than storing one that needs
-- correcting. Same for iata_number and office_id.

-- ----------------------------------------------------------------------------
-- 2. Counsellors belong to a branch
--
-- The one relationship that makes this master live rather than a table nothing
-- reads -- which is the failure mode this codebase has hit repeatedly (the dead
-- RLS policies, the dead view, escalates_at).
--
-- SET NULL, never CASCADE: deleting a branch must not delete people. The route
-- additionally refuses the delete while anyone is still assigned, so this is the
-- backstop rather than the rule.
--
-- Only meaningful for TMC-side staff. Not expressed as a constraint because
-- `employees` holds both TMC and corporate rows and a CHECK spanning role and
-- branch would fire on corporate inserts that have nothing to do with branches.
-- The route enforces it.
-- ----------------------------------------------------------------------------
alter table employees
  add column if not exists branch_id uuid references branches(id) on delete set null;

comment on column employees.branch_id is
  'The TMC office this employee works out of. TMC-side staff only. Not a permission boundary - client access is employee_client_access.';

create index if not exists employees_branch_idx
  on employees (branch_id) where branch_id is not null;

-- ----------------------------------------------------------------------------
-- 3. RLS
--
-- Enabled with no policies, matching every other table here: deny by default,
-- with route handlers reaching this through the service client after checking
-- authn, authz and tenancy themselves.
-- ----------------------------------------------------------------------------
alter table branches enable row level security;

commit;
