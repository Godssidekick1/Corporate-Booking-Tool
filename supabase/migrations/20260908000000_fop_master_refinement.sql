-- ============================================================================
-- FOP master: the fields the real screen carries
--
-- The first cut modelled what a form of payment IS. This adds how the industry
-- actually identifies and instructs one:
--
--   FOP Code      a short identifier the TMC assigns (1, 2, 3) and refers to
--                 everywhere else. Not a UUID - it is what a counsellor says
--                 out loud and what the mapping screen lists.
--   GDS Entry     the entry actually made: CC puts a real card element on the
--                 ticket so the AIRLINE charges it (pass-through), INVAGT
--                 settles the ticket as an agency invoice and the agency
--                 charges the card separately (non pass-through). This is the
--                 distinction "Master Pass Through" vs "Amex Non Pass Through"
--                 is naming, and it is not the same question as WHOSE money it
--                 is - a non pass-through Amex may belong to the corporate or
--                 to the traveller. That is why `payer` stays alongside it.
--   Payment Type  the commercial form: CC credit card, CL credit limit.
--
-- Both code lists are TABLES, not enums. A TMC adding a payment type should not
-- need a migration and a deploy - the same call already made for deal code
-- categories.
--
-- "ALL" STAYS NULL. The old screen writes the literal string into Airline, Card
-- Type and RBD. Stored as NULL here and displayed as "ALL", because the literal
-- forces every reader to special-case it, and the same screen already mixes the
-- two shapes: row 1 has RBD "R" beside Card Type "ALL".
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. Code lists
-- ----------------------------------------------------------------------------
create table if not exists fop_gds_entries (
  id         uuid primary key default gen_random_uuid(),
  tmc_id     uuid not null references tmcs(id) on delete cascade,
  code       text not null,
  label      text not null,
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  unique (tmc_id, code)
);

create table if not exists fop_payment_types (
  id         uuid primary key default gen_random_uuid(),
  tmc_id     uuid not null references tmcs(id) on delete cascade,
  code       text not null,
  label      text not null,
  -- Whether this payment type needs card details. The single source of truth
  -- for that question: forms_of_payment.fop_type is derived from it by the
  -- route rather than chosen separately, so the two can never disagree.
  requires_card boolean not null default false,
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  unique (tmc_id, code)
);

create index if not exists fop_gds_entries_tmc_idx   on fop_gds_entries (tmc_id);
create index if not exists fop_payment_types_tmc_idx on fop_payment_types (tmc_id);

-- ----------------------------------------------------------------------------
-- 2. The master's own additions
-- ----------------------------------------------------------------------------
alter table forms_of_payment
  add column if not exists fop_code        text,
  add column if not exists gds_entry_id    uuid references fop_gds_entries(id) on delete restrict,
  add column if not exists payment_type_id uuid references fop_payment_types(id) on delete restrict;

comment on column forms_of_payment.fop_code is
  'Short identifier the TMC assigns and refers to elsewhere. Unique per TMC.';

-- Unique only where present: existing rows have no code yet, and several NULLs
-- must not collide.
create unique index if not exists fop_code_uniq
  on forms_of_payment (tmc_id, fop_code) where fop_code is not null;

-- RESTRICT rather than CASCADE on both lookups: deleting a payment type that
-- forms of payment still reference should fail loudly, not silently strip the
-- instruction off every one of them.

-- ----------------------------------------------------------------------------
-- 3. A mapping can be switched off without deleting it
--
-- Separate from forms_of_payment.active on purpose: the old screen carries
-- Is Active on the MAPPING row, so one client can be taken off a form of
-- payment while it keeps working for everyone else.
-- ----------------------------------------------------------------------------
alter table fop_assignments
  add column if not exists is_active boolean not null default true;

-- ----------------------------------------------------------------------------
-- 4. Seed
--
-- Every existing TMC gets the two lists. New TMCs are seeded on first read by
-- GET /api/tmc/fop-codes, the same pattern as deal code categories - a trigger
-- would hide the behaviour from anyone reading the signup path.
-- ----------------------------------------------------------------------------
insert into fop_gds_entries (tmc_id, code, label)
select t.id, seed.code, seed.label
from tmcs t
cross join (values
  ('CC',     'Credit card - passed through to the airline'),
  ('INVAGT', 'Agency invoice - agency settles, card charged separately')
) as seed(code, label)
on conflict (tmc_id, code) do nothing;

insert into fop_payment_types (tmc_id, code, label, requires_card)
select t.id, seed.code, seed.label, seed.requires_card
from tmcs t
cross join (values
  ('CC', 'Credit card',  true),
  ('CL', 'Credit limit', false)
) as seed(code, label, requires_card)
on conflict (tmc_id, code) do nothing;

-- ----------------------------------------------------------------------------
-- 5. RLS - enabled with no policies, as everywhere else.
-- ----------------------------------------------------------------------------
alter table fop_gds_entries   enable row level security;
alter table fop_payment_types enable row level security;

commit;
