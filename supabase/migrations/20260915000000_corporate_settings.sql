-- ============================================================================
-- Corporate Settings: the per-client switchboard
--
-- What a corporate user can see and do is currently decided nowhere. A client
-- either has a policy group or does not, either has a form of payment assigned
-- or does not - but there is no place to say "this client cannot book yet",
-- "hotels do not need approval here", or "personal trips are not offered".
--
-- WHY COLUMNS AND NOT clients.settings
-- That jsonb column exists and is dead: two reads across the whole codebase,
-- zero writes. app/dashboard/page.tsx tests `client.settings.approvalModel`,
-- which nothing has ever written, so that checklist item is permanently
-- incomplete for every client.
--
-- These flags gate booking. They want defaults, CHECK constraints, and a
-- compiler that knows they exist - none of which jsonb gives. `clients` goes
-- from 19 columns to about 40, which is unremarkable for Postgres.
--
-- EVERY TOGGLE BELOW EITHER GATES SOMETHING OR SAYS IT DOES NOT.
-- A switch that silently does nothing is worse than no switch - the call
-- already made about the `book_on_behalf` permission. The two reserved ones are
-- marked in their comments and labelled in the UI.
--
-- NO PAN COLUMN, DELIBERATELY. The old screen has a "Pan Card No" field, but a
-- GSTIN already contains it: 27 + AAAPC4988M + 1Z5, characters 3-12. It is
-- derived at read time by readGstin(). Two hand-typed fields holding the same
-- ten characters is a guarantee they eventually disagree, with nothing to say
-- which is right.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. Identity and external references
-- ----------------------------------------------------------------------------
alter table clients
  add column if not exists client_code       text,
  -- The client's id in the TMC's finance system. Recorded, never resolved
  -- against anything - we do not talk to SAP, and a column that merely holds a
  -- foreign identifier should not pretend otherwise.
  add column if not exists sap_customer_code text,
  add column if not exists sap_group_code    text;

comment on column clients.client_code is
  'Short reference the TMC assigns and quotes on invoices. Unique per TMC where set.';

create unique index if not exists clients_code_uniq
  on clients (tmc_id, client_code) where client_code is not null;

-- ----------------------------------------------------------------------------
-- 2. Contact and address
--
-- `registered_address` is one free-text column today. The parts are added
-- alongside rather than replacing it: the old value stays readable as a
-- fallback, and nothing has to guess where one string's commas belonged.
-- ----------------------------------------------------------------------------
alter table clients
  add column if not exists email      text,
  add column if not exists phone      text,
  add column if not exists address_1  text,
  add column if not exists address_2  text,
  add column if not exists city       text,
  add column if not exists state      text,
  add column if not exists pincode    text,
  -- Who chases payment. Distinct from managed_by (the account manager) and from
  -- the corporate admin: on a real account these are three different people.
  add column if not exists collections_name   text,
  add column if not exists collections_email  text,
  add column if not exists collections_mobile text;

comment on column clients.registered_address is
  'Legacy single-line address, kept as a fallback display. New writes use '
  'address_1/address_2/city/state/pincode.';

-- ----------------------------------------------------------------------------
-- 3. Booking controls - what the corporate user can actually do
--
-- Defaults are permissive because every existing client is already booking; a
-- restrictive default would switch off a live account the moment this migration
-- ran. The two opt-in flags below default false for the opposite reason.
-- ----------------------------------------------------------------------------
alter table clients
  -- Enforced in /api/book/booking, before a PNR is created.
  add column if not exists booking_activation boolean not null default true,
  -- Also /api/book/booking. A PNR without a ticket IS a hold, which is why
  -- booking and ticketing are two separate routes in this app.
  add column if not exists hold_activation    boolean not null default true,
  -- Enforced in /api/book/ticket, split by classifyTrip().
  add column if not exists dom_ticketing      boolean not null default true,
  add column if not exists intl_ticketing     boolean not null default true,
  -- RESERVED: no auto-issue path exists to gate. Labelled as such in the UI.
  add column if not exists hold_auto_issue    boolean not null default false,
  -- RESERVED: who may ticket under self-booking is a rule nobody has stated,
  -- and guessing it would be worse than leaving the switch honest.
  add column if not exists sbt_ticketing      boolean not null default true,
  -- Enforced in checkBookingAgainstPolicy: off means bookings come back
  -- unevaluated rather than green. Those are different things, and reporting an
  -- unchecked booking as compliant would be a lie.
  add column if not exists policy_controlling boolean not null default true,
  -- Whether the booking UI offers a personal trip at all.
  --
  -- NOT the same as the policy field `personal_trips_allowed`, which decides
  -- which BANDS may take one. This is feature availability; that is
  -- entitlement. Off by default: a corporate travel tool offering personal
  -- trips unasked is a surprise, not a feature.
  add column if not exists personal_bookings_allowed boolean not null default false;

-- ----------------------------------------------------------------------------
-- 4. Financial
--
-- The three payer flags are the per-client filter predicted when forms of
-- payment were built: "a per-client filter over the payer dimension, not a new
-- field on the FOP". They become one check in resolveFop - a candidate whose
-- payer is not allowed here drops out before ranking, and nothing about the FOP
-- master changes.
-- ----------------------------------------------------------------------------
alter table clients
  add column if not exists agency_fop_allowed    boolean not null default true,
  add column if not exists corporate_fop_allowed boolean not null default true,
  add column if not exists traveller_fop_allowed boolean not null default true,

  -- Discount and processing fee are RECORDED ONLY. No engine computes either
  -- yet; these exist so the arrangement is configurable now and the data model
  -- is right when the Discounts master lands under Commercials.
  add column if not exists discount_active       boolean not null default false,
  add column if not exists processing_fee_active boolean not null default false;

-- The old screen calls these "Groups". They are buckets - the same curated
-- client sets that already serve deal codes and forms of payment. A third
-- grouping concept would have been a third thing to keep in step.
alter table clients
  add column if not exists fop_bucket_id            uuid references buckets(id) on delete set null,
  add column if not exists discount_bucket_id       uuid references buckets(id) on delete set null,
  add column if not exists processing_fee_bucket_id uuid references buckets(id) on delete set null;

-- ----------------------------------------------------------------------------
-- 5. Approval mode, per product
--
-- Separate from WHICH template applies (client_default_approval_templates), so
-- approval can be switched off for a product without losing the chain that was
-- configured for it. Same reasoning as policy_controlling.
-- ----------------------------------------------------------------------------
alter table clients
  add column if not exists air_approval_mode   text not null default 'before_booking',
  add column if not exists hotel_approval_mode text not null default 'before_booking';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'clients_air_approval_mode_check') then
    alter table clients add constraint clients_air_approval_mode_check
      check (air_approval_mode in ('before_booking', 'not_required'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'clients_hotel_approval_mode_check') then
    alter table clients add constraint clients_hotel_approval_mode_check
      check (hotel_approval_mode in ('before_booking', 'not_required'));
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 6. Mandatory information
--
-- Per-client entries a counsellor must supply at booking, and the GDS command
-- they go in. RECORDED, NOT TRANSMITTED - like deal codes and forms of payment,
-- nothing here is sent to the aggregator, and no copy in the UI may imply it is.
-- ----------------------------------------------------------------------------
create table if not exists client_mandatory_info (
  id           uuid primary key default gen_random_uuid(),
  client_id    uuid not null references clients(id) on delete cascade,
  code         text not null,
  description  text,
  -- What kind of value is expected (free text, a date, a cost centre...). A
  -- free column rather than an enum: TMCs will invent types, and a migration
  -- per type is the wrong shape.
  type         text,
  -- The GDS entry it is written into, e.g. an OSI or SSR command.
  gds_entry    text,
  value_prefix text,
  is_mandatory boolean not null default true,
  created_at   timestamptz not null default now(),
  unique (client_id, code)
);

create index if not exists client_mandatory_info_client_idx
  on client_mandatory_info (client_id);

comment on table client_mandatory_info is
  'Entries a booking for this client must carry, and the GDS command they go '
  'into. Recorded for manual entry and reconciliation - nothing here is sent to '
  'the aggregator.';

alter table client_mandatory_info enable row level security;

commit;
