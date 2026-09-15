-- ============================================================================
-- Discount and processing fee switch ON by default
--
-- 20260915000000 added clients.discount_active and clients.processing_fee_active
-- with `default false`, under a comment reading "RECORDED ONLY. No engine
-- computes either yet". False was correct for a switch nothing read.
--
-- 20260918000000 gave them an engine, and added markup_active `default true`
-- alongside them. That left the three siblings disagreeing about their own
-- default for no reason other than the order they were written in: a markup
-- assigned to a client applies immediately, while a discount or fee assigned
-- the same way does nothing until somebody also finds the Controls tab.
--
-- The assignment IS the deliberate act. A rule reaches a client only because a
-- TC put it there, so the switch belongs where markup already has it: an
-- explicit opt-OUT for the client who negotiated their way out of a fee, not a
-- second confirmation of a decision already made.
-- ============================================================================

alter table clients
  alter column discount_active       set default true,
  alter column processing_fee_active set default true;

-- Backfill every existing row.
--
-- Unconditional, and worth being explicit about why: while these columns were
-- recorded-only, false was what every row got on insert and the screen told
-- whoever looked at it that nothing was computed from the value. A `false`
-- sitting in the column today is therefore indistinguishable from never having
-- been touched, and treating it as a deliberate "no discount for this client"
-- would be reading intent into a default. Anyone who genuinely wants either
-- kind off can switch it off on the Controls tab, where it now means something.
--
-- Nothing starts charging as a result of this on its own: a fee applies only
-- where a processing_fee rule has been assigned and reaches the client.
update clients
   set discount_active       = true,
       processing_fee_active = true;

comment on column clients.discount_active is
  'Off: no discount is applied to this client, even where a discount rule reaches them. Defaults on — the assignment is the deliberate act. Sibling of markup_active and processing_fee_active.';

comment on column clients.processing_fee_active is
  'Off: no processing fee is charged to this client, even where a fee rule reaches them. Defaults on — the assignment is the deliberate act. Sibling of markup_active and discount_active.';
