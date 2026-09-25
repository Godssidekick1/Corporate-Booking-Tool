-- ── Commercial rules: markup, discount and processing fee ───────────────────
--
-- The product's first real pricing pipeline. Until now nothing anywhere
-- computed a price the client pays that differs from the airline fare:
-- bookings.total_cost was written verbatim from the browser, and the only
-- arithmetic performed on money in the whole codebase was adding seat fees.
--
-- WHAT EACH OF THE THREE DOES
--   discount        VISIBLE to the traveller, its own line, reduces the total
--   markup          HIDDEN, embedded inside the fare line, never itemised
--   processing_fee  VISIBLE, its own line, increases the total
--
-- Deal codes and forms of payment already resolve but move no money -- deal
-- codes because we cannot transmit a tour code to the aggregator, forms of
-- payment because there is no payment gateway yet. The pipeline declares a
-- slot for both, contributing zero, so wiring them later is a value change
-- rather than a structural one.
--
-- ONE TABLE, NOT THREE. The three share twelve fields and differ in three,
-- but the reason is not column overlap -- it is that they must COMPOSE, in a
-- fixed order, into a single sell price. Three tables would put that order in
-- whatever happened to call all three. One table means one resolver doing one
-- query, one pure composition function, and a real foreign key on the
-- assignment table instead of a polymorphic one.
--
-- WHAT IS DELIBERATELY NOT HERE
--   No uniqueness across the scope columns. Two overlapping rules are a normal
--   negotiating reality; precedence is the ladder alone (client > bucket >
--   client_group, then category, then airline specificity, then RBD breadth,
--   then newest). Overlap surfaces as `ambiguous`, it is not refused.
--
--   No CHECK on which calc_on values each kind may use. That list lives in
--   app/lib/commercials/calcOnByKind.ts, for the same reason permissionKeys.ts
--   gives: adding one should not require a migration.
-- ─────────────────────────────────────────────────────────────────────────────

begin;

-- ── 1. The rules ─────────────────────────────────────────────────────────────

create table if not exists commercial_rules (
  id           uuid primary key default gen_random_uuid(),
  tmc_id       uuid not null references tmcs(id) on delete cascade,

  kind         text not null check (kind in ('markup', 'discount', 'processing_fee')),

  -- Trip x Product x settlement, already seeded DOMAIRBSP / DOMAIRLCC /
  -- INTAIRBSP / INTAIRLCC by 20260905000000. The old screen asked for Trip,
  -- Product and Category as three separate fields; the category code already
  -- encodes all three, so there is one field here and not three.
  --
  -- This is also what makes deal_code_categories live: nothing has ever read
  -- it. A booking's category is derivable -- classifyFlight() gives
  -- domestic/international and FlatFlightResult.isLcc gives BSP vs LCC -- so
  -- rules can match on it for real.
  category_id  uuid not null references deal_code_categories(id) on delete restrict,

  -- null = every airline. Never the literal string 'ALL'.
  airline_code text,
  -- The cabin, NOT the booking class. One cabin holds many RBDs.
  cabin        text check (cabin is null or cabin in ('Y', 'W', 'C', 'F')),
  -- Booking classes, parsed by app/lib/fop/rbdSpec.ts. null = any class.
  rbd_spec     text,

  -- The old discount screen carried four rate columns side by side (Retail,
  -- Corporate, SOO, Side Trip). One fare_type per rule instead, so every kind
  -- has the same shape and the resolver only ever returns one rate -- four
  -- different rates is four rows.
  fare_type    text not null
               check (fare_type in ('all', 'retail', 'corporate', 'soo', 'side_trip')),

  calc_type    text not null check (calc_type in ('percent', 'fixed')),

  -- The superset. bf = base fare, yq = fuel/insurance surcharge, yr = the
  -- carrier-imposed misc fee (YQ's sibling -- both are filed in the tax box
  -- rather than the fare, and airlines use them somewhat interchangeably,
  -- which is exactly why bf_yq and bf_yq_yr are different arrangements worth
  -- money), tf = total fare, other_tax = everything else.
  calc_on      text not null
               check (calc_on in ('bf', 'yq', 'yr', 'bf_yq', 'bf_yq_yr', 'tf', 'other_tax')),

  -- Percent when calc_type = 'percent', an absolute amount when 'fixed'.
  rate         numeric(12,4) not null check (rate >= 0),

  -- ── processing_fee only ────────────────────────────────────────────────────
  -- Passengers ALWAYS multiply -- a fee is per ticket and each passenger gets
  -- one. calc_basis decides whether sectors multiply as well, so a 250 fee on
  -- a 3-passenger 2-sector booking is 750 per_transaction and 1500 per_sector.
  calc_basis        text check (calc_basis in ('per_transaction', 'per_sector')),
  -- Tax CODES, not amounts, and an array rather than the old screen's
  -- comma-separated string so the engine never parses user input at
  -- calculation time.
  exclude_tax_codes text[],
  include_ssr       boolean,

  valid_from   date,
  valid_to     date,
  active       boolean not null default true,
  notes        text,
  created_by   uuid references employees(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint commercial_rules_window_ordered
    check (valid_from is null or valid_to is null or valid_from <= valid_to),

  -- THE PRICE OF THE SINGLE-TABLE CHOICE, and the constraint that keeps it
  -- honest. The fee-only columns must be present for the one kind that uses
  -- them and absent for the other two -- otherwise a discount row quietly
  -- carries a calc_basis nothing will ever read, and "one table" degrades into
  -- "one table holding three half-filled shapes".
  constraint commercial_rules_fee_fields_match_kind check (
    (kind = 'processing_fee'
      and calc_basis is not null
      and exclude_tax_codes is not null
      and include_ssr is not null)
    or
    (kind <> 'processing_fee'
      and calc_basis is null
      and exclude_tax_codes is null
      and include_ssr is null)
  )
);

create index if not exists commercial_rules_tmc_kind_idx
  on commercial_rules (tmc_id, kind);

create index if not exists commercial_rules_airline_idx
  on commercial_rules (tmc_id, airline_code)
  where airline_code is not null;

comment on table commercial_rules is
  'Markup, discount and processing fee in one table. They compose in a fixed order (discount, markup, fee) into one sell price, which is why they are not three tables.';

comment on column commercial_rules.rate is
  'Percent when calc_type = percent, an absolute amount when fixed. For processing_fee it is then multiplied by passengers, and by sectors when calc_basis = per_sector.';

-- ── 2. Who each rule reaches ─────────────────────────────────────────────────
-- A copy of deal_code_assignments (20260905000000, section 4), with a real
-- foreign key rather than a polymorphic one -- there is a single rule table to
-- point at, which is one more thing the single-table choice buys.

create table if not exists commercial_rule_assignments (
  id              uuid primary key default gen_random_uuid(),
  tmc_id          uuid not null references tmcs(id) on delete cascade,
  rule_id         uuid not null references commercial_rules(id) on delete cascade,

  kind            text not null check (kind in ('client', 'client_group', 'bucket')),
  client_id       uuid references clients(id)       on delete cascade,
  client_group_id uuid references client_groups(id) on delete cascade,
  bucket_id       uuid references buckets(id)       on delete cascade,

  created_by      uuid references employees(id) on delete set null,
  created_at      timestamptz not null default now(),

  constraint commercial_rule_assignments_target_matches_kind check (
    (kind = 'client'       and client_id is not null       and client_group_id is null and bucket_id is null) or
    (kind = 'client_group' and client_group_id is not null and client_id is null       and bucket_id is null) or
    (kind = 'bucket'       and bucket_id is not null       and client_id is null       and client_group_id is null)
  )
);

-- Three PARTIAL unique indexes, not one composite. A composite over three
-- nullable columns constrains nothing, because NULLs never compare equal --
-- (rule, NULL, NULL, bucketA) twice would satisfy it.
create unique index if not exists commercial_rule_assignments_client_uniq
  on commercial_rule_assignments (rule_id, client_id) where client_id is not null;

create unique index if not exists commercial_rule_assignments_group_uniq
  on commercial_rule_assignments (rule_id, client_group_id) where client_group_id is not null;

create unique index if not exists commercial_rule_assignments_bucket_uniq
  on commercial_rule_assignments (rule_id, bucket_id) where bucket_id is not null;

create index if not exists commercial_rule_assignments_rule_idx
  on commercial_rule_assignments (rule_id);

create index if not exists commercial_rule_assignments_tmc_idx
  on commercial_rule_assignments (tmc_id);

-- ── 3. What a booking is actually sold for ───────────────────────────────────
--
-- total_cost KEEPS ITS CURRENT MEANING -- what the airline charges. Nothing
-- existing breaks, and /api/tmc/stats keeps reporting airline spend until
-- somebody deliberately changes it.

alter table bookings
  add column if not exists sell_total  numeric(12,2),
  add column if not exists commercials jsonb;

comment on column bookings.sell_total is
  'What the corporate is invoiced: airline total + markup - discount + processing fee. Distinct from total_cost, which stays the airline figure.';

comment on column bookings.commercials is
  'The frozen pricing pipeline: airline components, an ORDERED array of adjustments, and the totals. An array rather than named keys so deal codes and forms of payment slot in later without a shape change.';

-- ── 4. Per-client switch ─────────────────────────────────────────────────────
-- discount_active and processing_fee_active already exist from
-- 20260915000000, where they were recorded-only. They stop being inert with
-- this migration. markup_active joins them for symmetry.

alter table clients
  add column if not exists markup_active boolean not null default true;

comment on column clients.markup_active is
  'Off: no markup is applied to this client''s fares, and they see the airline figure. Siblings discount_active and processing_fee_active, added recorded-only in 20260915000000, become live with this migration.';

-- ── 5. price_quotes: taking price authority away from the browser ────────────
--
-- app/book/details/[flightKey]/page.tsx computes the grand total CLIENT-SIDE
-- and add-passenger forwards that number to Amadeus as both TotalAmount and
-- GrandTotalFare. With a marked-up figure in the browser that would quote our
-- own markup to the airline -- and the fix cannot be to send the true fare to
-- the browser, because the true fare is precisely what has to stay hidden.
--
-- So the server persists the quote at price time and recovers the airline
-- figure at booking time. Better than re-pricing at add-passenger: no extra
-- provider call, no risk of the fare moving in between, and it doubles as the
-- audit record of what was quoted and why. amadeus_session is the precedent
-- for a server-side cache table.

create table if not exists price_quotes (
  id                 uuid primary key default gen_random_uuid(),
  client_id          uuid not null references clients(id) on delete cascade,
  employee_id        uuid not null references employees(id) on delete cascade,

  -- Identifies the quote. The Amadeus Key and ReferenceNo pair is what
  -- add-passenger already carries forward, so nothing new travels through the
  -- browser to look this up.
  amadeus_key        text not null,
  reference_no       text not null,
  pricing_key        text not null,
  provider           text not null,
  result_index       text,

  -- base, taxLines[], fuelSurcharge, total -- the numbers the browser must
  -- never see.
  airline_components jsonb not null,
  commercials        jsonb not null,
  sell_total         numeric(12,2) not null,

  created_at         timestamptz not null default now(),
  expires_at         timestamptz not null,

  unique (amadeus_key, reference_no)
);

create index if not exists price_quotes_expiry_idx on price_quotes (expires_at);

comment on table price_quotes is
  'The airline-side figures for one priced itinerary, held server-side so the browser never learns the true fare and never decides what we charge. Disposable; expires_at exists for a sweep that is not yet written.';

-- ── 6. Deny-by-default RLS, as everywhere else in this schema ────────────────
-- Every route reaches these through the service-role client, which bypasses
-- RLS. Enabling it with no policy closes direct anon-key PostgREST access.

alter table commercial_rules            enable row level security;
alter table commercial_rule_assignments enable row level security;
alter table price_quotes                enable row level security;

commit;
