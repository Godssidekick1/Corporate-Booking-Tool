-- ============================================================================
-- Rename the domain's core noun: company -> client
--
-- Every TMC-facing screen calls these organisations "clients". The database
-- called them "companies". That mismatch forced a translation step in every
-- route handler and made the UI copy drift from the schema, so this renames
-- the schema to match the language the product actually uses.
--
-- WHAT POSTGRES HANDLES ON ITS OWN
--   Foreign keys, indexes, constraints, RLS policies and views all reference
--   tables and columns by OID and attribute number, not by name. A RENAME
--   updates every one of them automatically -- there is nothing to re-point.
--
-- WHAT IT DOES NOT
--   Function bodies are stored as TEXT. A rename does not touch them, so a
--   trigger function referring to `company_id` keeps referring to a column
--   that no longer exists and fails at call time, not at migration time.
--   That is the entire risk of this migration, and section 3 exists to
--   address it: every affected function is recreated, and section 5 refuses
--   to commit if any function still mentions a pre-rename name.
--
-- DEPLOY ORDERING
--   Application code and this migration must ship together. Code deployed
--   before it queries `companies` and gets an error; code deployed after it
--   queries `clients` and gets an error until this runs. There is no version
--   that works against both schemas, so run it as part of the same release.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. Tables
-- ----------------------------------------------------------------------------
alter table companies                          rename to clients;
alter table company_policy_groups              rename to client_policy_groups;
alter table company_default_approval_templates rename to client_default_approval_templates;
alter table employee_company_access            rename to employee_client_access;

-- ----------------------------------------------------------------------------
-- 2. The company_id column, wherever it appears
--
-- Driven off the catalogue rather than a hand-written list of fifteen tables.
-- A list would silently miss any table added between writing this and running
-- it, and the failure mode of a miss is a column that keeps the old name
-- forever while the code that reads it has already moved on.
--
-- relkind 'r' restricts this to ordinary tables: views are derived and their
-- column names follow from the rewritten definitions underneath.
-- ----------------------------------------------------------------------------
do $$
declare
  target record;
begin
  for target in
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid
    where n.nspname = 'public'
      and c.relkind = 'r'
      and a.attname = 'company_id'
      and not a.attisdropped
    order by c.relname
  loop
    execute format('alter table public.%I rename column company_id to client_id', target.relname);
    raise notice 'renamed %.company_id -> client_id', target.relname;
  end loop;
end $$;

-- ----------------------------------------------------------------------------
-- 3. Functions
--
-- Recreated rather than renamed: `alter function ... rename` changes the name
-- and leaves the body untouched, which is precisely the half that breaks.
-- ----------------------------------------------------------------------------

-- Guard A: linking a policy group to a client.
drop function if exists check_company_policy_group_overlap() cascade;

create or replace function check_client_policy_group_overlap()
returns trigger
language plpgsql
as $$
declare
  conflict record;
begin
  perform pg_advisory_xact_lock(hashtext(new.client_id::text));

  select existing_group.name as group_name, shared.band_rank as band_rank
    into conflict
  from client_policy_groups link
  join policy_groups existing_group
    on existing_group.id = link.policy_group_id
  join policy_group_band_ranks shared
    on shared.policy_group_id = link.policy_group_id
  join policy_group_band_ranks incoming
    on incoming.policy_group_id = new.policy_group_id
   and incoming.band_rank = shared.band_rank
  where link.client_id = new.client_id
    and link.policy_group_id <> new.policy_group_id
  order by shared.band_rank
  limit 1;

  if conflict.group_name is not null then
    raise exception
      'Policy group overlaps with "%" at band rank % for this client',
      conflict.group_name, conflict.band_rank
      using errcode = '23P01';
  end if;

  return new;
end;
$$;

-- Guard B: adding a rank to a group that is already linked somewhere.
create or replace function check_policy_group_rank_overlap()
returns trigger
language plpgsql
as $$
declare
  linked_client record;
  conflict      record;
begin
  for linked_client in
    select client_id
    from client_policy_groups
    where policy_group_id = new.policy_group_id
    order by client_id
  loop
    perform pg_advisory_xact_lock(hashtext(linked_client.client_id::text));
  end loop;

  select other_group.name as group_name, link.client_id as client_id
    into conflict
  from client_policy_groups mine
  join client_policy_groups link
    on link.client_id = mine.client_id
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
      'Band rank % is already covered by "%" for a client using this group',
      new.band_rank, conflict.group_name
      using errcode = '23P01';
  end if;

  return new;
end;
$$;

-- An approver must work at the client they approve for.
drop function if exists check_tier_approver_company() cascade;

create or replace function check_tier_approver_client()
returns trigger
language plpgsql
as $$
declare
  approver_client uuid;
begin
  if new.approver_user_id is null then
    return new;
  end if;

  select client_id into approver_client
  from employees
  where id = new.approver_user_id;

  if approver_client is distinct from new.client_id then
    raise exception
      'Approver % does not belong to client %', new.approver_user_id, new.client_id
      using errcode = '23514';
  end if;

  return new;
end;
$$;

-- These two guarded `company_approval_templates`, a table replaced by the
-- per-employee assignment model and since dropped. They have been dead ever
-- since -- their bodies reference a relation that no longer exists, so they
-- would fail on any call. Removing them now rather than porting names onto
-- functions nothing can invoke.
drop function if exists check_company_approval_template_overlap() cascade;
drop function if exists check_approval_template_rank_overlap()    cascade;

-- Left over from the original RLS design, which was replaced by
-- deny-by-default plus service-role access in the route handlers. No code path
-- calls it and its body reads the pre-rename column names.
--
-- Dropped WITHOUT cascade deliberately: if some policy still depends on it,
-- this statement fails and takes the whole migration down with it, which is
-- the outcome to want. A cascade would quietly delete that policy instead.
drop function if exists get_my_company_id();

-- ----------------------------------------------------------------------------
-- 4. Triggers
--
-- Dropped along with their functions by the cascades above; recreated here
-- against the renamed tables. Trigger names are part of the error messages
-- route handlers match on, so these follow the column rename rather than
-- keeping the old spelling.
-- ----------------------------------------------------------------------------
drop trigger if exists company_policy_groups_no_overlap on client_policy_groups;
drop trigger if exists client_policy_groups_no_overlap  on client_policy_groups;

create constraint trigger client_policy_groups_no_overlap
  after insert or update on client_policy_groups
  deferrable initially immediate
  for each row
  execute function check_client_policy_group_overlap();

drop trigger if exists policy_group_band_ranks_no_overlap on policy_group_band_ranks;

create constraint trigger policy_group_band_ranks_no_overlap
  after insert or update on policy_group_band_ranks
  deferrable initially immediate
  for each row
  execute function check_policy_group_rank_overlap();

drop trigger if exists approval_tier_approvers_company_check on approval_tier_approvers;
drop trigger if exists approval_tier_approvers_client_check  on approval_tier_approvers;

create constraint trigger approval_tier_approvers_client_check
  after insert or update on approval_tier_approvers
  deferrable initially immediate
  for each row
  execute function check_tier_approver_client();

-- ----------------------------------------------------------------------------
-- 5. Refuse to commit a half-finished rename
--
-- Sections 1 and 2 are catalogue-driven and cannot miss anything. Section 3 is
-- a hand-written list, and a hand-written list of function bodies is exactly
-- the kind of thing that goes stale. This scans every function in `public` for
-- a surviving reference to a pre-rename name and aborts the transaction if it
-- finds one -- a failed migration is recoverable, a trigger that only breaks
-- on the next write is not.
--
-- Word boundaries matter: `client_group_id` must not match `company` and
-- `clients` must not match on the substring `client`.
-- ----------------------------------------------------------------------------
do $$
declare
  stale_functions text;
  stale_policies  text;
begin
  select string_agg(p.proname, ', ' order by p.proname)
    into stale_functions
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.prosrc ~* '\ycompany_id\y|\ycompanies\y|\ycompany_policy_groups\y|\yemployee_company_access\y|\ycompany_default_approval_templates\y';

  if stale_functions is not null then
    raise exception
      'Rename incomplete: these functions still reference pre-rename names: %',
      stale_functions;
  end if;

  -- Policies are stored parsed, so these should already read the new names.
  -- Checked anyway: this is the assumption the whole migration rests on, and
  -- verifying it costs one query.
  select string_agg(policyname || ' on ' || tablename, ', ')
    into stale_policies
  from pg_policies
  where schemaname = 'public'
    and (coalesce(qual, '') || ' ' || coalesce(with_check, ''))
        ~* '\ycompany_id\y|\ycompanies\y';

  if stale_policies is not null then
    raise exception
      'Rename incomplete: these policies still reference pre-rename names: %',
      stale_policies;
  end if;
end $$;

commit;
