-- ─────────────────────────────────────────────────────────────────────────────
-- Policy Master model: finish the migration from per-employee policy groups
-- to TMC-owned group templates covering band rank ranges.
--
-- Existing policy rows are dummy data and are reset here rather than migrated.
-- ─────────────────────────────────────────────────────────────────────────────

begin;

-- ── 1. Drop dependent objects first ──────────────────────────────────────────
-- These must go before the column drop below: an RLS policy that references
-- policy_groups.company_id is a dependent object, so dropping the column while
-- the policy exists fails.
--
-- The old policies keyed on company_id and on an app.current_company_id session
-- GUC that nothing in the app ever set. Every server route reaches these tables
-- through the service-role client, which bypasses RLS entirely, and nothing
-- reads them with the anon key — so the correct posture is deny-by-default:
-- RLS enabled with no permissive policy at all.
drop policy if exists "policy_groups: admin write"      on policy_groups;
drop policy if exists "policy_groups: read own company" on policy_groups;
-- Same story on policy_rules: rls_policy_rules matched on company_id, which the
-- new writer always leaves NULL, so it already grants nothing. Drop it rather
-- than leave a policy that reads as if it were protecting something.
drop policy if exists "rls_policy_rules"                on policy_rules;

-- current_policy_rules: referenced nowhere in the codebase, and semantically
-- wrong under the new model — it filters `company_id is not null` (excluding
-- every rule the new writer produces), dedupes on band_id rather than
-- band_rank, and never filters deleted_at, so a soft-deleted row with a higher
-- version would win. Every read path builds "latest live version" by hand.
drop view if exists current_policy_rules;

-- employee_policy_groups: the old per-employee membership model. Zero code
-- references remain — assignment is company-level via company_policy_groups.
drop table if exists employee_policy_groups;

-- ── 2. Reset dummy policy data ───────────────────────────────────────────────
-- policy_rules.policy_group_id cascades from policy_groups, but company-scoped
-- rules written by the old corporate-admin path have a NULL group and would
-- survive the cascade, so clear the table explicitly first.
truncate table company_policy_groups;
delete from policy_rules;
delete from policy_groups;

-- ── 3. Tenancy on policy_groups ──────────────────────────────────────────────
-- With corporate admins read-only, every group is a TMC-owned template and
-- nothing should key off a company. Keeping company_id is what let the
-- corporate route filter groups by it and silently return an empty list.
alter table policy_groups drop column if exists company_id;

-- tmc_id is the ownership key every other route gates on
-- (auth.tmcId === group.tmc_id). A NULL here makes a group undeletable and
-- un-ruleable, and makes policy_rules inserts violate policy_rules_scope_check.
alter table policy_groups alter column tmc_id set not null;

-- Names were globally unique across all TMCs, so two TMCs could never both
-- have an "Executive" group. Uniqueness belongs per-tenant.
alter table policy_groups drop constraint if exists policy_groups_name_key;
alter table policy_groups
  add constraint policy_groups_tmc_id_name_key unique (tmc_id, name);

-- code is treated as an identifier by the search/picker path but had no
-- constraint at all. Partial index so several groups may leave it NULL.
create unique index if not exists policy_groups_tmc_id_code_key
  on policy_groups (tmc_id, code)
  where code is not null;

alter table policy_groups
  add constraint policy_groups_rank_range_check
  check (
    min_band_rank is null
    or max_band_rank is null
    or min_band_rank <= max_band_rank
  );

-- ── 4. Enforce non-overlapping rank ranges per company ───────────────────────
-- resolveEffectivePolicy treats two groups covering one employee's rank as a
-- configuration error (`overlapping_policy_groups`). The route checks for this
-- before inserting, but check-then-insert races: two concurrent links can both
-- pass and produce exactly the state the engine refuses to resolve.
--
-- An EXCLUDE constraint can't express this — the ranges live on policy_groups,
-- not on the link row being inserted. A constraint trigger can, but only
-- serialises correctly if concurrent inserts for the same company take turns,
-- hence the advisory lock: the second transaction blocks until the first
-- commits, and its trigger body then runs as a fresh statement whose snapshot
-- includes the newly committed row.
--
-- Note this relies on READ COMMITTED (PostgREST's default). Under REPEATABLE
-- READ the second transaction's snapshot predates the first commit and the
-- overlap would still slip through.
create or replace function check_company_policy_group_overlap()
returns trigger
language plpgsql
as $$
declare
  conflict_name text;
begin
  perform pg_advisory_xact_lock(hashtext(new.company_id::text));

  select existing_group.name
    into conflict_name
  from company_policy_groups link
  join policy_groups existing_group on existing_group.id = link.policy_group_id
  join policy_groups incoming_group on incoming_group.id = new.policy_group_id
  where link.company_id = new.company_id
    and link.policy_group_id <> new.policy_group_id
    -- NULL on either side means unbounded in that direction.
    and coalesce(existing_group.min_band_rank, -2147483648)
        <= coalesce(incoming_group.max_band_rank, 2147483647)
    and coalesce(incoming_group.min_band_rank, -2147483648)
        <= coalesce(existing_group.max_band_rank, 2147483647)
  limit 1;

  if conflict_name is not null then
    raise exception
      'Policy group overlaps with "%", already linked to this company', conflict_name
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

-- ── 5. Deny-by-default RLS ───────────────────────────────────────────────────
-- Enabled with no permissive policy: the service-role client used by every
-- route bypasses RLS, so this closes direct PostgREST access with the anon key
-- without needing the session GUC the old policies depended on.
alter table policy_groups         enable row level security;
alter table company_policy_groups enable row level security;
alter table policy_rules          enable row level security;

commit;
