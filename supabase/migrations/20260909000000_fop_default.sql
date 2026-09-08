-- ============================================================================
-- Forms of payment: a CHOSEN default, replacing an INFERRED one
--
-- The rule until now was implicit: a form of payment with no assignment was the
-- default for its scope. That was reasonable while there was no screen showing
-- the mappings — a booking resolving to no payment method at all tells a
-- counsellor nothing, so something had to fill the gap.
--
-- It stops being reasonable the moment the mappings are visible. Under the old
-- rule, "this client matches nothing" was silently papered over by whichever
-- form of payment happened to be unassigned, and adding the first assignment to
-- a card quietly removed it as everyone else's fallback. Both of those are
-- action at a distance: editing one row changed how unrelated clients settle.
--
-- So the fallback becomes a flag somebody sets on purpose. A client matching
-- nothing is then a VISIBLE gap an admin can fix, not an invisible one the
-- system guesses its way around.
--
-- NO BACKFILL, AND THAT IS DELIBERATE
-- Picking a default here would mean this migration guessing which card a TMC
-- meant, and guessing wrong is a wrongly-settled ticket. After this runs, no TMC
-- has a default until someone chooses one, and bookings that would previously
-- have resolved through the implicit rule now resolve to nothing and say so.
-- That is the intended outcome, not an oversight.
-- ============================================================================

begin;

alter table forms_of_payment
  add column if not exists is_default boolean not null default false;

comment on column forms_of_payment.is_default is
  'The fallback when nothing else reaches a client. At most one per TMC, chosen '
  'explicitly — it replaces the older implicit rule that an unassigned form of '
  'payment was the default for its scope.';

-- Partial unique index, the same shape as branches.is_head_office: uniqueness is
-- only meaningful among the rows that claim the flag, and a plain unique
-- constraint over (tmc_id, is_default) would let each TMC have exactly one
-- NON-default form of payment, which is the opposite of the rule.
create unique index if not exists fop_one_default_per_tmc
  on forms_of_payment (tmc_id) where is_default;

-- The API clears the previous default before setting a new one, so marking a
-- second is a swap rather than a constraint violation the user has to decode.
-- The index is the backstop for anything writing directly to the table.

commit;
