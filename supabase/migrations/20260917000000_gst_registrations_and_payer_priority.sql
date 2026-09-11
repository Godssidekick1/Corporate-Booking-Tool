-- ── GST registrations, payment types and payer priority ─────────────────────
--
-- Three changes, all of them about Corporate Settings becoming the one place a
-- client is configured.
--
-- 1. GST stops being a single column. A corporate bills through several GSTINs
--    -- different cycles, different cost centres, each valid for its own stretch
--    of time -- and `clients.gst_number` could hold exactly one. Which GSTIN
--    invoices a booking is a date-and-cost-centre lookup, not a field.
--
-- 2. "Traveller pays" splits into BTA/CTA and BTA/CTA manual. In this product
--    BTA/CTA means the traveller's own card, already stored against them;
--    BTA/CTA manual means they type card details at the payment gateway and
--    nothing is stored here. Note for the next reader: the industry normally
--    uses those letters for a corporate lodged account. It does not here.
--
-- 3. Payer priority gets somewhere to live. The four booleans say who MAY pay.
--    fop_priority says who WINS when more than one may. It always carries all
--    four entries, enabled or not, which is what stops the two from ever
--    contradicting each other -- neither field is trying to express the other,
--    so disabling a payment type never rewrites an ordering nobody touched.
--
-- Also drops three columns added in 20260915000000 that nothing ever read.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. GST registrations ─────────────────────────────────────────────────────

create table if not exists client_gst_registrations (
  id                uuid primary key default gen_random_uuid(),
  client_id         uuid not null references clients(id) on delete cascade,

  -- Nullable, deliberately. A registration can be on file with a holder,
  -- address, cost centre and validity window before the number itself comes
  -- through. Requiring it would make a real row unenterable.
  gstin             text,
  gst_holder        text,
  email             text,
  contact           text,

  address_1         text,
  address_2         text,
  city              text,
  -- Has to agree with the GSTIN's first two digits. Checked in the route by
  -- gstinFinding(), which WARNS rather than rejects -- same call the branch
  -- master already makes, for the same reason: the TMC holds the certificate
  -- on paper and the software does not get to overrule it.
  state             text,
  country           text,
  zip               text,

  registration_date date,
  valid_from        date,
  -- Null means open-ended.
  valid_to          date,

  -- The old site typed a cost centre code into a text box. cost_centres is
  -- already per-client and already carries that code, so this is a real
  -- reference -- a typo can no longer point at a cost centre that never existed.
  cost_centre_id    uuid references cost_centres(id) on delete set null,

  -- The fallback when no cost centre matches the booking.
  is_primary        boolean not null default false,
  created_at        timestamptz not null default now(),

  constraint gst_validity_ordered
    check (valid_to is null or valid_from is null or valid_to >= valid_from)
);

-- Partial, because gstin is nullable: several pending registrations may sit
-- with no number, and a plain unique would allow only one of them.
create unique index if not exists client_gst_gstin_uniq
  on client_gst_registrations (client_id, gstin) where gstin is not null;

create unique index if not exists client_gst_primary_uniq
  on client_gst_registrations (client_id) where is_primary;

create index if not exists client_gst_client_idx
  on client_gst_registrations (client_id);

comment on table client_gst_registrations is
  'Every GST registration a client bills under. Which one applies to a booking is decided by cost centre and validity window, with is_primary as the fallback.';

-- Two registrations for the same cost centre whose validity windows overlap
-- make "which GSTIN invoices this" ambiguous, and the wrong answer there is a
-- wrong tax invoice. Enforced in the database because the API is not the only
-- thing that will ever write this table.
-- `when others` rather than a named list: an unavailable extension surfaces
-- differently depending on how the server was built (missing privilege, missing
-- file, unsupported feature), and guessing wrong turns a soft degrade into a
-- failed migration. The route checks for overlaps too, so losing this is a
-- weaker guarantee rather than no guarantee.
do $$
begin
  create extension if not exists btree_gist;
exception when others then
  raise notice 'btree_gist unavailable; GST overlap is enforced in the route only';
end $$;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'btree_gist')
     and not exists (
       select 1 from pg_constraint where conname = 'client_gst_no_overlap'
     )
  then
    alter table client_gst_registrations
      add constraint client_gst_no_overlap
      exclude using gist (
        client_id with =,
        coalesce(cost_centre_id, '00000000-0000-0000-0000-000000000000'::uuid) with =,
        daterange(valid_from, valid_to, '[]') with &&
      );
  end if;
end $$;

alter table client_gst_registrations enable row level security;

-- ── 2. Backfill from clients.gst_number, then drop it ────────────────────────

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_name = 'clients' and column_name = 'gst_number'
  ) then
    insert into client_gst_registrations (client_id, gstin, gst_holder, state, is_primary)
    select c.id, upper(trim(c.gst_number)), c.name, c.state, true
    from clients c
    where c.gst_number is not null
      and trim(c.gst_number) <> ''
      and not exists (
        select 1 from client_gst_registrations g where g.client_id = c.id
      );

    alter table clients drop column gst_number;
  end if;
end $$;

-- ── 3. Payment types ─────────────────────────────────────────────────────────

alter table clients
  add column if not exists bta_cta_allowed        boolean not null default true,
  add column if not exists bta_cta_manual_allowed boolean not null default false;

comment on column clients.bta_cta_allowed is
  'BTA/CTA: the traveller pays with their own card, already stored against them here.';
comment on column clients.bta_cta_manual_allowed is
  'BTA/CTA manual: the traveller types card details at the gateway. Nothing is stored here.';

-- traveller_fop_allowed was the umbrella. Keeping it alongside the two specific
-- flags would be a third thing that can disagree with the other two.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_name = 'clients' and column_name = 'traveller_fop_allowed'
  ) then
    update clients set bta_cta_allowed = traveller_fop_allowed;
    alter table clients drop column traveller_fop_allowed;
  end if;
end $$;

-- ── 4. Payer priority ────────────────────────────────────────────────────────

alter table clients
  add column if not exists fop_priority text[] not null
    default '{corporate,agency,bta_cta,bta_cta_manual}';

comment on column clients.fop_priority is
  'Preference order over all four payment types, most preferred first. Always holds all four; the *_allowed booleans decide which are in play.';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'clients_fop_priority_valid'
  ) then
    -- Contains all four AND is exactly four long, which together force each to
    -- appear exactly once. Stated this way rather than with a distinct-count
    -- subquery because CHECK constraints cannot contain subqueries at all.
    alter table clients add constraint clients_fop_priority_valid check (
      fop_priority @> array['agency','corporate','bta_cta','bta_cta_manual']::text[]
      and array_length(fop_priority, 1) = 4
    );
  end if;
end $$;

-- ── 5. Drop the bucket columns nothing read ──────────────────────────────────
--
-- Added in 20260915000000 as "which group applies for this purpose". Written by
-- the client PATCH and read by no engine anywhere. Bucket membership
-- (bucket_clients) is the mechanism that actually resolves -- stampFop and
-- stampBooking both expand client -> buckets at booking time -- and two answers
-- to "which bucket governs this client" is how the two drift apart.
alter table clients
  drop column if exists fop_bucket_id,
  drop column if exists discount_bucket_id,
  drop column if exists processing_fee_bucket_id;
