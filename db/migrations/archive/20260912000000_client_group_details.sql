-- ============================================================================
-- Client groups: a code, a contact, and a bill-to address
--
-- client_groups has been four useful columns (name, city, country) since it was
-- company_groups. The screen it replaces carries a group code, a named contact,
-- and a full address -- and the moment a group has an address and a contact it
-- stops being a label and starts being a party you send an invoice to.
--
-- WHICH SIDE OF THE INVOICE EACH ONE SITS ON
-- `branches` is already the billing entity on the TMC side: GST registration,
-- registered address, the identity printed on the invoice the TMC RAISES. A
-- client group is the other end -- who RECEIVES it. That is why the address here
-- is named bill_to_* rather than "address": complementary, not overlapping, and
-- naming it after its purpose is what keeps the two from drifting into each
-- other over time.
--
-- NO GST NUMBER HERE, DELIBERATELY.
-- The client's GSTIN lives on `clients` (clients.gst_number) because that is the
-- entity that contracts and is invoiced. A second GST field on the group would
-- be a second answer to the same question, and the two would disagree.
--
-- DEFERRED, NOT FORGOTTEN
-- Distribution Channel and "No Billing Industry Model" are both on the old
-- screen and both left out. The first wants a configurable code list and nobody
-- has said what the channel set is; the second is a label neither of us could
-- read, and modelling it on a guess is worse than leaving it off.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. Identity
-- ----------------------------------------------------------------------------
alter table client_groups
  add column if not exists group_code text;

comment on column client_groups.group_code is
  'Short reference the TMC assigns and uses elsewhere. Unique per TMC where set.';

-- Unique only where present: existing groups have no code, and several NULLs
-- must not collide. A plain unique constraint would permit them anyway (NULLs
-- never compare equal), but the partial index states the intent out loud.
create unique index if not exists client_groups_code_uniq
  on client_groups (tmc_id, group_code) where group_code is not null;

-- ----------------------------------------------------------------------------
-- 2. The named contact
--
-- Split into first and last rather than one `contact_name`, matching the old
-- screen and matching `employees`. A single field cannot be sorted or addressed
-- correctly, and splitting one later means guessing where the boundary was.
-- ----------------------------------------------------------------------------
alter table client_groups
  add column if not exists contact_first_name text,
  add column if not exists contact_last_name  text,
  add column if not exists contact_email      text,
  add column if not exists contact_mobile     text;

comment on column client_groups.contact_email is
  'Who to reach about this group commercially. NOT a login - it grants nothing '
  'and no auth path reads it.';

-- ----------------------------------------------------------------------------
-- 3. Bill-to address
--
-- `city` and `country` already exist and are kept as they are: renaming live
-- columns would break every reader for a naming improvement. The new lines are
-- prefixed bill_to_ so the pair below reads as one address rather than a set of
-- loose fields, and so nobody later adds a second "address" beside it.
-- ----------------------------------------------------------------------------
alter table client_groups
  add column if not exists bill_to_address_1 text,
  add column if not exists bill_to_address_2 text,
  add column if not exists bill_to_state     text,
  add column if not exists bill_to_pincode   text;

comment on column client_groups.city is
  'Part of the bill-to address. Predates the bill_to_ prefix and kept under its '
  'original name rather than renamed, which would break every existing reader.';

-- ----------------------------------------------------------------------------
-- 4. Write the distinction down where a reader will hit it
--
-- "Client group vs bucket" has lived only in commit messages, which is to say
-- nowhere a new reader would find it. Both screens carry a note too; this is the
-- copy that survives someone reading the schema on its own.
-- ----------------------------------------------------------------------------
comment on table client_groups is
  'The client''s OWN org structure - Acme Group above Acme India and Acme UK. A '
  'hierarchical fact about who a client is, and a client belongs to at most one. '
  'Not a bucket: a bucket is an arbitrary curated set used for distribution, and '
  'a client can be in many. Not a branch either - a branch is one of the TMC''s '
  'own offices.';

comment on table buckets is
  'An arbitrary curated set of clients, made for distribution - "Tier 1 '
  'corporates", "North India desk". Cuts across client_groups on purpose, a '
  'client can be in several, and the same bucket serves deal codes and forms of '
  'payment at once. Not a client group: that is the client''s own org hierarchy.';

commit;
