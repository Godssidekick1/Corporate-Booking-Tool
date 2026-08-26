-- ─────────────────────────────────────────────────────────────────────────────
-- Replace contiguous rank ranges with explicit rank sets.
--
-- min_band_rank..max_band_rank could only express a contiguous span, so a
-- policy covering band ranks 1, 4 and 7 was impossible to model. Coverage is
-- now an explicit set of ranks per group.
--
-- A set is strictly more expressive (a range is just a dense set) and makes
-- overlap detection exact: two groups collide iff their rank sets intersect,
-- which is a plain join rather than the coalesce(min, -2147483648) arithmetic
-- the range version needed to handle unbounded sides.
-- ─────────────────────────────────────────────────────────────────────────────

begin;

-- ── 1. The rank set ──────────────────────────────────────────────────────────
create table if not exists policy_group_band_ranks (
  policy_group_id uuid    not null references policy_groups(id) on delete cascade,
  band_rank       integer not null check (band_rank >= 0),
  primary key (policy_group_id, band_rank)
);

-- Overlap checks look up "which groups cover rank N", so index the reverse
-- direction too; the PK only serves group -> ranks.
create index if not exists policy_group_band_ranks_rank_idx
  on policy_group_band_ranks (band_rank);

-- ── 2. Retire the range columns ──────────────────────────────────────────────
-- Nothing to migrate: the previous migration reset policy_groups to empty, so
-- there are no ranges to expand into sets. The UI keeps a "fill 1..5" helper as
-- an authoring convenience, but a range is no longer a stored concept.
alter table policy_groups drop constraint if exists policy_groups_rank_range_check;
alter table policy_groups drop column if exists min_band_rank;
alter table policy_groups drop column if exists max_band_rank;

-- ── 3. Overlap enforcement ───────────────────────────────────────────────────
-- Two guards are needed, because coverage can now change from either side:
-- linking a group to a company, or adding a rank to an already-linked group.
--
-- Both take advisory locks on the affected company ids before checking, for
-- the same reason as before: check-then-insert races otherwise let two
-- concurrent transactions each miss the other's uncommitted row. Locks are
-- taken in sorted company order so the two triggers can never deadlock against
-- each other.

-- Guard A: linking a group to a company.
create or replace function check_company_policy_group_overlap()
returns trigger
language plpgsql
as $$
declare
  conflict record;
begin
  perform pg_advisory_xact_lock(hashtext(new.company_id::text));

  select existing_group.name as group_name, shared.band_rank as band_rank
    into conflict
  from company_policy_groups link
  join policy_groups existing_group
    on existing_group.id = link.policy_group_id
  join policy_group_band_ranks shared
    on shared.policy_group_id = link.policy_group_id
  join policy_group_band_ranks incoming
    on incoming.policy_group_id = new.policy_group_id
   and incoming.band_rank = shared.band_rank
  where link.company_id = new.company_id
    and link.policy_group_id <> new.policy_group_id
  order by shared.band_rank
  limit 1;

  if conflict.group_name is not null then
    raise exception
      'Policy group overlaps with "%" at band rank % for this company',
      conflict.group_name, conflict.band_rank
      using errcode = '23P01';
  end if;

  return new;
end;
$$;

-- Guard B: adding a rank to a group that is already linked somewhere. Without
-- this, overlap could be introduced after the fact and only surface at booking
-- time as `overlapping_policy_groups`.
create or replace function check_policy_group_rank_overlap()
returns trigger
language plpgsql
as $$
declare
  linked_company record;
  conflict       record;
begin
  for linked_company in
    select company_id
    from company_policy_groups
    where policy_group_id = new.policy_group_id
    order by company_id
  loop
    perform pg_advisory_xact_lock(hashtext(linked_company.company_id::text));
  end loop;

  select other_group.name as group_name, link.company_id as company_id
    into conflict
  from company_policy_groups mine
  join company_policy_groups link
    on link.company_id = mine.company_id
   and link.policy_group_id <> new.policy_group_id
  join policy_groups other_group
    on other_group.id = link.policy_group_id
  join policy_group_band_ranks other_ranks
    on other_ranks.policy_group_id = link.policy_group_id
   and other_ranks.band_rank = new.band_rank
  where mine.policy_group_id = new.policy_group_id
  limit 1;

  if conflict.group_name is not null then
    raise exception
      'Band rank % is already covered by "%" for a company using this group',
      new.band_rank, conflict.group_name
      using errcode = '23P01';
  end if;

  return new;
end;
$$;

drop trigger if exists company_policy_groups_no_overlap on company_policy_groups;
create constraint trigger company_policy_groups_no_overlap
  after insert or update on company_policy_groups
  deferrable initially immediate
  for each row
  execute function check_company_policy_group_overlap();

drop trigger if exists policy_group_band_ranks_no_overlap on policy_group_band_ranks;
create constraint trigger policy_group_band_ranks_no_overlap
  after insert or update on policy_group_band_ranks
  deferrable initially immediate
  for each row
  execute function check_policy_group_rank_overlap();

-- ── 4. RLS, consistent with the other policy tables ──────────────────────────
-- Deny-by-default: every route reaches this through the service-role client,
-- which bypasses RLS; this closes direct anon-key PostgREST access.
alter table policy_group_band_ranks enable row level security;

commit;
