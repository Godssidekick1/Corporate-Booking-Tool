-- ============================================================================
-- Deal code master
--
-- Negotiated airline codes -- tour codes, private fares, deal, tracking and
-- promotion codes -- held once by the TMC and assigned to many clients.
--
-- THE SHAPE, AND WHY
--   The Amadeus screen this replaces puts the corporate code on the deal row
--   itself. That single decision is what forces one-at-a-time assignment and
--   makes "give this deal to a group of corporates" impossible. Here the
--   definition and the assignment are separate objects, so reaching forty
--   clients is one row, not forty deals.
--
-- WHAT THIS DELIBERATELY DOES NOT DO
--   No overlap trigger. policy_groups enforces non-overlap with a constraint
--   trigger that raises; copying that here would be wrong. Overlapping deals
--   are the normal case -- an airline-wide deal alongside a route-specific one
--   -- so this is a resolution problem, not an integrity problem, and it is
--   settled by a pure function at read time instead.
--
--   No priority column. Precedence is the ladder alone: client, then bucket,
--   then client group; then flight-specific over airline-wide; then narrower
--   spec; then most recent.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. Categories
--
-- A 2x2 of geography (DOM/INT) and settlement (BSP/LCC). Settlement is the half
-- that carries behaviour: BSP content settles through the GDS and has a
-- tour-code field, LCC direct-connect largely does not.
--
-- A table rather than an enum because a TMC must be able to add its own without
-- a migration -- the same "configurable per TMC" rule the rest of this platform
-- follows.
-- ----------------------------------------------------------------------------
create table if not exists deal_code_categories (
  id         uuid primary key default gen_random_uuid(),
  tmc_id     uuid not null references tmcs(id) on delete cascade,
  code       text not null,
  label      text not null,
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  unique (tmc_id, code)
);

create index if not exists deal_code_categories_tmc_idx
  on deal_code_categories (tmc_id);

-- Which code types a category permits. Stored as data so the rule can be
-- corrected without a deploy: this is a starting default drawn from how BSP and
-- LCC content normally behave, not settled fact about every aggregator.
create table if not exists deal_code_category_types (
  category_id uuid not null references deal_code_categories(id) on delete cascade,
  code_type   text not null check (code_type in ('TC', 'PF', 'DC', 'TR', 'PC')),
  allowed     boolean not null default true,
  primary key (category_id, code_type)
);

-- ----------------------------------------------------------------------------
-- 2. The deals themselves
--
-- Two validity windows, not one. Airline deals carry a sales period and a
-- travel period and they differ -- "book by 31 Mar, travel by 31 Dec" is the
-- ordinary shape, and a single range cannot express it. This is the field the
-- screen being replaced most clearly gets wrong.
--
-- flight_spec is null for "any flight". Never the literal string 'ALL', which
-- is what the old screen stores and which then has to be special-cased at every
-- read. Parsed by app/lib/deal-codes/flightSpec.ts, which accepts a single
-- number, a comma-separated list, and hyphenated ranges.
-- ----------------------------------------------------------------------------
create table if not exists deal_codes (
  id           uuid primary key default gen_random_uuid(),
  tmc_id       uuid not null references tmcs(id) on delete cascade,
  category_id  uuid not null references deal_code_categories(id) on delete restrict,
  airline_code text not null,
  code         text not null,
  code_type    text not null check (code_type in ('TC', 'PF', 'DC', 'TR', 'PC')),
  flight_spec  text,
  sales_from   date,
  sales_to     date,
  travel_from  date,
  travel_to    date,
  active       boolean not null default true,
  notes        text,
  -- These are contractual instruments; attribution is not optional. SET NULL
  -- rather than CASCADE: a deal must outlive the person who entered it.
  created_by   uuid references employees(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint deal_codes_sales_window_ordered
    check (sales_from is null or sales_to is null or sales_from <= sales_to),
  constraint deal_codes_travel_window_ordered
    check (travel_from is null or travel_to is null or travel_from <= travel_to)
);

create index if not exists deal_codes_tmc_idx     on deal_codes (tmc_id);
create index if not exists deal_codes_airline_idx on deal_codes (tmc_id, airline_code);

-- ----------------------------------------------------------------------------
-- 3. Buckets -- sets of CLIENTS
--
-- Deliberately not "a set of deal codes". A bucket is an arbitrary, curated
-- grouping of clients that cuts across client_groups: client_groups is the org
-- hierarchy a client belongs to, a bucket is a distribution decision someone
-- made on purpose ("Tier 1 corporates", "North India desk").
--
-- Named generically and given its own master because forms of payment and
-- markup will target the same table. Building it deal-code-specific would mean
-- a second, identical concept in three months.
-- ----------------------------------------------------------------------------
create table if not exists buckets (
  id          uuid primary key default gen_random_uuid(),
  tmc_id      uuid not null references tmcs(id) on delete cascade,
  name        text not null,
  code        text,
  description text,
  created_by  uuid references employees(id) on delete set null,
  created_at  timestamptz not null default now(),
  unique (tmc_id, name)
);

create index if not exists buckets_tmc_idx on buckets (tmc_id);

create table if not exists bucket_clients (
  bucket_id  uuid not null references buckets(id) on delete cascade,
  client_id  uuid not null references clients(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (bucket_id, client_id)
);

create index if not exists bucket_clients_client_idx on bucket_clients (client_id);

-- ----------------------------------------------------------------------------
-- 4. Assignment -- the column that used to live on the deal
--
-- One row per (deal, target). `kind` names which target column carries the
-- value, and the CHECK holds the two in agreement: without it a row could claim
-- kind='client' while carrying only a bucket_id, and every reader would then
-- need its own defensive branch.
-- ----------------------------------------------------------------------------
create table if not exists deal_code_assignments (
  id              uuid primary key default gen_random_uuid(),
  tmc_id          uuid not null references tmcs(id) on delete cascade,
  deal_code_id    uuid not null references deal_codes(id) on delete cascade,
  kind            text not null check (kind in ('client', 'client_group', 'bucket')),
  client_id       uuid references clients(id) on delete cascade,
  client_group_id uuid references client_groups(id) on delete cascade,
  bucket_id       uuid references buckets(id) on delete cascade,
  created_by      uuid references employees(id) on delete set null,
  created_at      timestamptz not null default now(),

  constraint deal_code_assignments_target_matches_kind check (
    (kind = 'client'       and client_id is not null and client_group_id is null and bucket_id is null) or
    (kind = 'client_group' and client_group_id is not null and client_id is null and bucket_id is null) or
    (kind = 'bucket'       and bucket_id is not null and client_id is null and client_group_id is null)
  )
);

-- Partial uniques rather than one composite: a composite over three nullable
-- columns does not constrain anything, because NULLs never compare equal.
create unique index if not exists deal_code_assignments_client_uniq
  on deal_code_assignments (deal_code_id, client_id) where client_id is not null;
create unique index if not exists deal_code_assignments_group_uniq
  on deal_code_assignments (deal_code_id, client_group_id) where client_group_id is not null;
create unique index if not exists deal_code_assignments_bucket_uniq
  on deal_code_assignments (deal_code_id, bucket_id) where bucket_id is not null;

create index if not exists deal_code_assignments_deal_idx on deal_code_assignments (deal_code_id);
create index if not exists deal_code_assignments_tmc_idx  on deal_code_assignments (tmc_id);

-- ----------------------------------------------------------------------------
-- 5. What was resolved at booking time
--
-- Frozen on the booking rather than re-derived later: assignments change, and a
-- booking made in March must still show the code that applied in March. Also
-- the only place a counsellor can read the code to key into the GDS, since the
-- aggregator API has no field to carry it.
-- ----------------------------------------------------------------------------
alter table bookings
  add column if not exists resolved_deal_codes jsonb;

comment on column bookings.resolved_deal_codes is
  'Deal codes resolved when this booking was created, one winner per airline per code type. Recorded for manual GDS entry and reconciliation - nothing is transmitted to the aggregator.';

-- ----------------------------------------------------------------------------
-- 6. Seed
--
-- Every existing TMC gets the four categories and the default type matrix.
-- ON CONFLICT DO NOTHING so re-running is harmless and so a TMC that has
-- already edited its own categories is left alone.
--
-- New TMCs are seeded on demand by GET /api/tmc/deal-code-categories rather
-- than by a trigger here: a trigger would be invisible to anyone reading the
-- signup path, and the route already has to handle the empty case anyway.
-- ----------------------------------------------------------------------------
insert into deal_code_categories (tmc_id, code, label)
select t.id, seed.code, seed.label
from tmcs t
cross join (values
  ('DOMAIRBSP', 'Domestic - BSP settled'),
  ('DOMAIRLCC', 'Domestic - LCC direct connect'),
  ('INTAIRBSP', 'International - BSP settled'),
  ('INTAIRLCC', 'International - LCC direct connect')
) as seed(code, label)
on conflict (tmc_id, code) do nothing;

-- BSP content has a tour-code field and supports filed private fares; LCC
-- direct-connect largely has neither, so TC and PF are disallowed there. Deal,
-- tracking and promotion codes apply to both.
insert into deal_code_category_types (category_id, code_type, allowed)
select cat.id, matrix.code_type, matrix.allowed
from deal_code_categories cat
join (values
  ('DOMAIRBSP', 'TC', true ), ('DOMAIRBSP', 'PF', true ), ('DOMAIRBSP', 'DC', true ), ('DOMAIRBSP', 'TR', true ), ('DOMAIRBSP', 'PC', true ),
  ('INTAIRBSP', 'TC', true ), ('INTAIRBSP', 'PF', true ), ('INTAIRBSP', 'DC', true ), ('INTAIRBSP', 'TR', true ), ('INTAIRBSP', 'PC', true ),
  ('DOMAIRLCC', 'TC', false), ('DOMAIRLCC', 'PF', false), ('DOMAIRLCC', 'DC', true ), ('DOMAIRLCC', 'TR', true ), ('DOMAIRLCC', 'PC', true ),
  ('INTAIRLCC', 'TC', false), ('INTAIRLCC', 'PF', false), ('INTAIRLCC', 'DC', true ), ('INTAIRLCC', 'TR', true ), ('INTAIRLCC', 'PC', true )
) as matrix(cat_code, code_type, allowed) on matrix.cat_code = cat.code
on conflict (category_id, code_type) do nothing;

-- ----------------------------------------------------------------------------
-- 7. RLS
--
-- Enabled with no policies, matching every other table here: deny by default,
-- and route handlers reach these through the service client after checking
-- authn, authz and tenancy themselves.
-- ----------------------------------------------------------------------------
alter table deal_code_categories     enable row level security;
alter table deal_code_category_types enable row level security;
alter table deal_codes               enable row level security;
alter table buckets                  enable row level security;
alter table bucket_clients           enable row level security;
alter table deal_code_assignments    enable row level security;

commit;
