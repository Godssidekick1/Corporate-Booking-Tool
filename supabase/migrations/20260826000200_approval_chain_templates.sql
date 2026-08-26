-- ─────────────────────────────────────────────────────────────────────────────
-- Approval chains become reusable TMC templates covering band ranks.
--
-- approval_chains was keyed (employee_id, category): one row per employee per
-- category, built by hand. Two consequences:
--
--   1. A 200-person client needed 400 hand-maintained rows.
--   2. startApprovalForBooking returns requiresApproval:false when no chain
--      exists, so every employee without one bypassed approval entirely. New
--      hires were silently unapproved until someone remembered them.
--
-- Same shape as the Policy Master model: TMC-owned templates covering an
-- explicit set of band ranks, linked to companies. Assign once, applies to
-- everyone at those ranks including future hires.
--
-- Adds `mode`, so a chain is either sequential (tier 1, then tier 2, ...) or
-- parallel (every approver at once). One enum rather than two flags, so the
-- two can never both be on.
-- ─────────────────────────────────────────────────────────────────────────────

begin;

-- ── 1. Templates ─────────────────────────────────────────────────────────────
create table if not exists approval_chain_templates (
  id          uuid primary key default gen_random_uuid(),
  tmc_id      uuid not null references tmcs(id) on delete cascade,
  name        text not null,
  code        text,
  description text,
  -- Routing bucket this template answers for. Deliberately unconstrained text
  -- rather than a CHECK: the bucket list is app-level config and should be
  -- extensible (routing car rentals separately from expenses, say) without a
  -- migration.
  category    text not null,
  -- sequential: walk tiers in order. parallel: create every approver at once.
  mode        text not null default 'sequential'
              check (mode in ('sequential', 'parallel')),
  -- Only meaningful when mode = 'parallel'. 'any' clears on the first
  -- approval; 'all' needs every approver. A rejection is terminal in both
  -- modes regardless — one objection stops the booking.
  quorum      text not null default 'all'
              check (quorum in ('any', 'all')),
  tiers       jsonb not null default '[]'::jsonb,
  version     integer not null default 1,
  updated_by  uuid references employees(id) on delete set null,
  created_at  timestamptz not null default now(),

  constraint approval_chain_templates_tmc_id_name_key unique (tmc_id, name)
);

create unique index if not exists approval_chain_templates_tmc_id_code_key
  on approval_chain_templates (tmc_id, code)
  where code is not null;

-- ── 2. Rank coverage ─────────────────────────────────────────────────────────
-- An explicit set, not a range, for the same reason policy groups use one:
-- a template covering ranks 1, 4 and 7 is expressible, and a template with no
-- ranks covers nobody rather than silently covering everybody.
create table if not exists approval_template_band_ranks (
  template_id uuid    not null references approval_chain_templates(id) on delete cascade,
  band_rank   integer not null check (band_rank >= 0),
  primary key (template_id, band_rank)
);

create index if not exists approval_template_band_ranks_rank_idx
  on approval_template_band_ranks (band_rank);

-- ── 3. Company links ─────────────────────────────────────────────────────────
create table if not exists company_approval_templates (
  company_id  uuid not null references companies(id) on delete cascade,
  template_id uuid not null references approval_chain_templates(id) on delete cascade,
  assigned_at timestamptz not null default now(),
  assigned_by uuid references employees(id) on delete set null,
  primary key (company_id, template_id)
);

-- ── 4. Overlap enforcement ───────────────────────────────────────────────────
-- Two templates must not cover the same rank for the same company IN THE SAME
-- CATEGORY. Unlike policy groups, category is part of the key: one template
-- for flights_hotels and another for misc at the same rank is the normal
-- arrangement, not a conflict.
--
-- Guarded from both directions, since coverage can change either by linking a
-- template or by adding a rank to an already-linked one. Advisory locks are
-- taken in sorted company order so the two triggers can't deadlock.

create or replace function check_company_approval_template_overlap()
returns trigger
language plpgsql
as $$
declare
  conflict record;
begin
  perform pg_advisory_xact_lock(hashtext('approval:' || new.company_id::text));

  select other_template.name as template_name,
         shared.band_rank    as band_rank,
         other_template.category as category
    into conflict
  from company_approval_templates link
  join approval_chain_templates other_template
    on other_template.id = link.template_id
  join approval_template_band_ranks shared
    on shared.template_id = link.template_id
  join approval_chain_templates incoming_template
    on incoming_template.id = new.template_id
   and incoming_template.category = other_template.category
  join approval_template_band_ranks incoming
    on incoming.template_id = new.template_id
   and incoming.band_rank = shared.band_rank
  where link.company_id = new.company_id
    and link.template_id <> new.template_id
  order by shared.band_rank
  limit 1;

  if conflict.template_name is not null then
    raise exception
      'Approval template overlaps with "%" at band rank % for category % at this company',
      conflict.template_name, conflict.band_rank, conflict.category
      using errcode = '23P01';
  end if;

  return new;
end;
$$;

create or replace function check_approval_template_rank_overlap()
returns trigger
language plpgsql
as $$
declare
  linked_company record;
  conflict       record;
begin
  for linked_company in
    select company_id
    from company_approval_templates
    where template_id = new.template_id
    order by company_id
  loop
    perform pg_advisory_xact_lock(hashtext('approval:' || linked_company.company_id::text));
  end loop;

  select other_template.name as template_name, link.company_id as company_id
    into conflict
  from company_approval_templates mine
  join company_approval_templates link
    on link.company_id = mine.company_id
   and link.template_id <> new.template_id
  join approval_chain_templates other_template
    on other_template.id = link.template_id
  join approval_chain_templates my_template
    on my_template.id = new.template_id
   and my_template.category = other_template.category
  join approval_template_band_ranks other_ranks
    on other_ranks.template_id = link.template_id
   and other_ranks.band_rank = new.band_rank
  where mine.template_id = new.template_id
  limit 1;

  if conflict.template_name is not null then
    raise exception
      'Band rank % is already covered by "%" in the same category for a company using this template',
      new.band_rank, conflict.template_name
      using errcode = '23P01';
  end if;

  return new;
end;
$$;

drop trigger if exists company_approval_templates_no_overlap on company_approval_templates;
create constraint trigger company_approval_templates_no_overlap
  after insert or update on company_approval_templates
  deferrable initially immediate
  for each row
  execute function check_company_approval_template_overlap();

drop trigger if exists approval_template_band_ranks_no_overlap on approval_template_band_ranks;
create constraint trigger approval_template_band_ranks_no_overlap
  after insert or update on approval_template_band_ranks
  deferrable initially immediate
  for each row
  execute function check_approval_template_rank_overlap();

-- ── 5. Point approvals at templates ──────────────────────────────────────────
-- Existing approvals rows are dummy data, so chain_id is dropped outright
-- rather than carried alongside as a dead column.
alter table approvals drop constraint if exists approvals_chain_id_fkey;
alter table approvals drop column if exists chain_id;

alter table approvals
  add column if not exists chain_template_id uuid
  references approval_chain_templates(id) on delete set null;

-- Parallel mode needs to find an approval's siblings: same booking, same tier.
create index if not exists approvals_booking_tier_idx
  on approvals (booking_id, tier);

-- ── 6. Retire per-employee chains ────────────────────────────────────────────
drop table if exists approval_chains;

-- ── 7. RLS, consistent with the other TMC-owned tables ───────────────────────
-- Deny-by-default: every route reaches these through the service-role client,
-- which bypasses RLS; this closes direct anon-key PostgREST access.
alter table approval_chain_templates     enable row level security;
alter table approval_template_band_ranks enable row level security;
alter table company_approval_templates   enable row level security;

commit;
