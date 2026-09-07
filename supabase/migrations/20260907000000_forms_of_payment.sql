-- ============================================================================
-- Forms of payment
--
-- How a ticket is actually paid for at issuance. Until now addPassenger sent
-- Payment: {} and nothing decided what belonged in it.
--
-- NOT "AGENCY FOP"
--   The screen this replaces is agency-only, but the payer can be the agency,
--   the corporate, or the traveller, and those have different commercial
--   consequences for the TMC. Naming the master after one of the three would be
--   wrong for the other two.
--
-- TWO DIMENSIONS THE OLD SCREEN COLLAPSES INTO ONE CARD FIELD
--   fop_type  - what kind of instrument: card or cash. Cash means BSP/agency
--               settlement, which is not an edge case: airlines routinely
--               refuse card on deeply discounted fares because a ~2% merchant
--               fee does not fit the margin. That is exactly why the old screen
--               carries an RBD field.
--   payer     - whose money. agency (TMC carries the float and the credit risk,
--               earns the rebate), corporate (client's lodged card is charged
--               directly, no float and no rebate), traveller (individual pays
--               and reclaims).
--
-- WHERE THIS DIFFERS FROM DEAL CODES
--   One winner, not one per type. Deal codes resolve one per (airline, type)
--   because a private fare, a tour code and a tracking code all apply at once.
--   You pay one way.
--
--   Unassigned means DEFAULT, not dormant. An unassigned deal code reaches
--   nobody, which is safe. Every ticket must be paid somehow, so an unassigned
--   FOP is the fallback for its scope and client-specific assignments override
--   it.
--
--   No sales/travel windows. A fare agreement has them; a card's real lifecycle
--   is its own expiry date.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. The servicing branch for a client
--
-- Each client is serviced by a branch; a branch handles many clients. A column
-- rather than a join table because that relationship is one-to-many as stated -
-- a join table whose rows are always exactly one is machinery pretending to be
-- a model. If a client ever genuinely spans branches this becomes
-- client_branches with a primary flag.
--
-- SET NULL so closing a branch never deletes a client.
-- ----------------------------------------------------------------------------
alter table clients
  add column if not exists branch_id uuid references branches(id) on delete set null;

comment on column clients.branch_id is
  'The TMC branch that services this client. Drives which branch-scoped form of payment applies.';

create index if not exists clients_branch_idx
  on clients (branch_id) where branch_id is not null;

-- ----------------------------------------------------------------------------
-- 2. Forms of payment
--
-- PCI: THERE IS DELIBERATELY NO CARD NUMBER COLUMN.
-- A raw PAN in Postgres pulls this database, its backups and Supabase into
-- PCI-DSS scope. What is stored is a REFERENCE - brand, last four, expiry, and
-- optionally the alias of the card actually lodged in the GDS profile. Anyone
-- reading this later and reaching for a card_number column: that is the line.
-- ----------------------------------------------------------------------------
create table if not exists forms_of_payment (
  id             uuid primary key default gen_random_uuid(),
  tmc_id         uuid not null references tmcs(id) on delete cascade,

  label          text not null,
  fop_type       text not null check (fop_type in ('card', 'cash')),
  payer          text not null check (payer in ('agency', 'corporate', 'traveller')),

  -- AX Amex, VI Visa, CA Mastercard (NOT cash, NOT Visa - the usual trap),
  -- DC Diners.
  card_type      text check (card_type in ('AX', 'VI', 'CA', 'DC')),
  last4          text check (last4 ~ '^[0-9]{4}$'),
  expiry_month   smallint check (expiry_month between 1 and 12),
  expiry_year    smallint check (expiry_year between 2000 and 2100),
  gds_alias      text,

  -- Null means every branch. A branch-specific FOP beats a TMC-wide one.
  branch_id      uuid references branches(id) on delete set null,

  -- Whose card it is, for the payer types where that is a real question. An
  -- agency card has neither set.
  owner_client_id   uuid references clients(id) on delete cascade,
  owner_employee_id uuid references employees(id) on delete cascade,

  -- Null means any airline / any booking class.
  airline_code   text,
  rbd_spec       text,

  active         boolean not null default true,
  notes          text,
  created_by     uuid references employees(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  -- A cash FOP cannot carry a card brand, and a card must have one. Without
  -- this, "cash on Amex" is storable and every reader has to decide what it
  -- means.
  constraint fop_card_fields_match_type check (
    (fop_type = 'card' and card_type is not null) or
    (fop_type = 'cash' and card_type is null and last4 is null
       and expiry_month is null and expiry_year is null)
  ),

  -- The owner column has to agree with the payer, for the same reason: an
  -- agency card owned by a client is a contradiction, not a configuration.
  constraint fop_owner_matches_payer check (
    (payer = 'agency'    and owner_client_id is null and owner_employee_id is null) or
    (payer = 'corporate' and owner_client_id is not null and owner_employee_id is null) or
    (payer = 'traveller' and owner_employee_id is not null and owner_client_id is null)
  )
);

create index if not exists fop_tmc_idx     on forms_of_payment (tmc_id);
create index if not exists fop_branch_idx  on forms_of_payment (branch_id) where branch_id is not null;
create index if not exists fop_owner_client_idx   on forms_of_payment (owner_client_id) where owner_client_id is not null;
create index if not exists fop_owner_employee_idx on forms_of_payment (owner_employee_id) where owner_employee_id is not null;

-- ----------------------------------------------------------------------------
-- 3. Assignment
--
-- Same shape as deal_code_assignments, and reusing the same generic buckets /
-- bucket_clients tables - they were named without a deal_code_ prefix for
-- exactly this.
--
-- An FOP with NO row here is the default for its scope. That is the opposite of
-- a deal code, and deliberate: a booking with no payment method resolved tells
-- the counsellor nothing.
-- ----------------------------------------------------------------------------
create table if not exists fop_assignments (
  id              uuid primary key default gen_random_uuid(),
  tmc_id          uuid not null references tmcs(id) on delete cascade,
  fop_id          uuid not null references forms_of_payment(id) on delete cascade,
  kind            text not null check (kind in ('client', 'client_group', 'bucket')),
  client_id       uuid references clients(id) on delete cascade,
  client_group_id uuid references client_groups(id) on delete cascade,
  bucket_id       uuid references buckets(id) on delete cascade,
  created_by      uuid references employees(id) on delete set null,
  created_at      timestamptz not null default now(),

  constraint fop_assignments_target_matches_kind check (
    (kind = 'client'       and client_id is not null and client_group_id is null and bucket_id is null) or
    (kind = 'client_group' and client_group_id is not null and client_id is null and bucket_id is null) or
    (kind = 'bucket'       and bucket_id is not null and client_id is null and client_group_id is null)
  )
);

-- Partial uniques rather than one composite: a composite over three nullable
-- columns constrains nothing, because NULLs never compare equal.
create unique index if not exists fop_assignments_client_uniq
  on fop_assignments (fop_id, client_id) where client_id is not null;
create unique index if not exists fop_assignments_group_uniq
  on fop_assignments (fop_id, client_group_id) where client_group_id is not null;
create unique index if not exists fop_assignments_bucket_uniq
  on fop_assignments (fop_id, bucket_id) where bucket_id is not null;

create index if not exists fop_assignments_fop_idx on fop_assignments (fop_id);
create index if not exists fop_assignments_tmc_idx on fop_assignments (tmc_id);

-- ----------------------------------------------------------------------------
-- 4. What was resolved at booking time
--
-- Frozen alongside resolved_deal_codes, and for the same reason: assignments
-- change, and a booking made in March must still show the form of payment that
-- applied in March.
-- ----------------------------------------------------------------------------
alter table bookings
  add column if not exists resolved_fop jsonb;

comment on column bookings.resolved_fop is
  'The form of payment resolved when this booking was created. Recorded for settlement and reconciliation - nothing is transmitted to the aggregator.';

-- ----------------------------------------------------------------------------
-- 5. RLS - enabled with no policies, as everywhere else here. Route handlers
-- reach these through the service client after checking authn, authz and
-- tenancy themselves.
-- ----------------------------------------------------------------------------
alter table forms_of_payment enable row level security;
alter table fop_assignments  enable row level security;

commit;
