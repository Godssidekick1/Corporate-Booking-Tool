-- ============================================================================
-- Policy rules belong to the GROUP, not to a rank within it
--
-- policy_rules has been keyed (policy_group_id, band_rank) since the Policy
-- Master rewrite. A group covering ranks 1, 2 and 3 therefore stored THREE sets
-- of limits that were free to disagree, and the editor made you fill all three.
--
-- But a policy group already means "these ranks share a policy" — that is what
-- the rank set is FOR. Storing per-rank limits inside it says the opposite, and
-- the copy-one-rank-across-the-rest helper added earlier was a workaround for a
-- shape that should not have existed. Ranks needing different limits are, by
-- definition, a different group.
--
-- So: the rank set stays (it decides WHO the group covers), and band_rank comes
-- off the rules (they are the group's, full stop).
--
-- THIS DELETES EVERY RULE. IT IS NOT A DATA-PRESERVING MIGRATION.
-- Collapsing three disagreeing rank rows into one means choosing which values
-- survive, and there is no answer to that which is not a guess. Per the explicit
-- call that this is test data, the rules are cleared and re-entered rather than
-- guessed at. Anyone reading this later should not mistake it for a rewrite that
-- kept anything.
--
-- Coverage (policy_group_band_ranks), the overlap triggers and the groups
-- themselves are all untouched — a rank must still match exactly one group.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 0. Guard: nothing invisible may still read policy_rules.band_rank
--
-- Postgres re-points indexes, constraints and FKs by OID when a column is
-- dropped, so those take care of themselves. FUNCTION BODIES DO NOT — they are
-- stored as text and are not dependency-tracked, so a trigger function reading
-- band_rank would keep parsing fine and fail at runtime, on a write, in
-- production. That is exactly how the company->client rename bit us.
--
-- Views are checked too. They ARE dependency-tracked, so a dependent view would
-- make the drop below fail loudly rather than silently — but failing with the
-- name in hand beats decoding a generic dependency error.
-- ----------------------------------------------------------------------------
do $$
declare
  offender text;
begin
  select string_agg(name, ', ')
    into offender
  from (
    select p.proname as name
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      -- Comments stripped before matching: a commented-out reference is not a
      -- real one, and treating it as one would block the migration for nothing.
      and regexp_replace(p.prosrc, '--[^\n]*', '', 'g') ~* 'policy_rules'
      and regexp_replace(p.prosrc, '--[^\n]*', '', 'g') ~* 'band_rank'

    union all

    select v.viewname
    from pg_views v
    where v.schemaname = 'public'
      and v.definition ~* 'policy_rules'
      and v.definition ~* 'band_rank'
  ) as offenders;

  if offender is not null then
    raise exception
      'These still read policy_rules.band_rank and must be updated first: %',
      offender;
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 1. Clear the rules
--
-- delete rather than truncate: policy_rules is referenced by nothing, but
-- delete respects any trigger that might exist and does not need the table lock
-- truncate takes. The table is small either way.
-- ----------------------------------------------------------------------------
delete from policy_rules;

-- ----------------------------------------------------------------------------
-- 2. Drop the column
--
-- Any index or CHECK constraint mentioning only band_rank goes with it
-- automatically. A multi-column unique key such as
-- (policy_group_id, band_rank, travel_type, limit_key, version) is NOT dropped —
-- Postgres rewrites it without the column, leaving
-- (policy_group_id, travel_type, limit_key, version), which is precisely the
-- uniqueness the new model wants.
-- ----------------------------------------------------------------------------
alter table policy_rules drop column if exists band_rank;

comment on table policy_rules is
  'Limits belonging to a policy group. One set per group per version — the '
  'group''s rank set (policy_group_band_ranks) decides who they cover. Ranks '
  'needing different limits are a different group.';

commit;
