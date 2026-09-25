-- ─────────────────────────────────────────────────────────────────────────────
-- Split approval-chain STRUCTURE from approver IDENTITY.
--
-- approval_chain_templates.tiers carried approver_user_id inline, but a
-- template is shared across client companies and a person only exists inside
-- one of them. A shared template naming a person is incoherent by
-- construction — and the UI shipped a dropdown option for it that could never
-- be saved, because validation demanded a user id the form never collected.
--
-- The seam now falls between the two halves:
--
--   tiers (jsonb)             structure — steps, verdict thresholds, labels
--   approval_tier_approvers   identity  — who fills each step, per company
--
-- Structure propagates when the TMC edits a template. Identity stays local and
-- can never point at another client's staff.
--
-- A chain may instead belong to a single company (company_id set). That is the
-- same machinery, just not offered elsewhere — it is what the "direct mapping"
-- flow produces, where the word "template" never appears in the UI.
-- ─────────────────────────────────────────────────────────────────────────────

begin;

-- ── 1. Templates may be shared or company-owned ──────────────────────────────
alter table approval_chain_templates
  add column if not exists company_id uuid references companies(id) on delete cascade;

comment on column approval_chain_templates.company_id is
  'NULL = shared across the TMC. Set = offered only to that company (direct mapping).';

create index if not exists approval_chain_templates_company_idx
  on approval_chain_templates (company_id)
  where company_id is not null;

-- ── 2. Identity, per company per template per step ───────────────────────────
create table if not exists approval_tier_approvers (
  company_id       uuid    not null references companies(id) on delete cascade,
  template_id      uuid    not null references approval_chain_templates(id) on delete cascade,
  tier             integer not null,
  approver_type    text    not null
                   check (approver_type in (
                     'manager', 'any_manager_at', 'finance_role',
                     'admin', 'self', 'specific_user'
                   )),
  -- Cascades on delete: if the named approver leaves, the binding goes with
  -- them and the step reads as unbound, which the engine already surfaces as
  -- an unresolved approver rather than silently approving.
  approver_user_id uuid references employees(id) on delete cascade,
  min_band_rank    integer,
  assigned_by      uuid references employees(id) on delete set null,
  assigned_at      timestamptz not null default now(),

  primary key (company_id, template_id, tier),

  -- Mirrors the shape rules validateTiers used to apply to template tiers.
  constraint approval_tier_approvers_specific_user_ck
    check (approver_type <> 'specific_user' or approver_user_id is not null),
  constraint approval_tier_approvers_rank_ck
    check (approver_type <> 'any_manager_at' or min_band_rank is not null)
);

-- ── 3. An approver must work at the company they approve for ─────────────────
-- A foreign key can't express this: approver_user_id references employees, but
-- nothing ties that employee's company_id to this row's company_id. Getting it
-- wrong routes one client's approvals to another client's staff, which is a
-- data leak rather than an inconvenience — so it is enforced in the database
-- rather than left to the route handlers.
create or replace function check_tier_approver_company()
returns trigger
language plpgsql
as $$
declare
  approver_company uuid;
begin
  if new.approver_user_id is null then
    return new;
  end if;

  select company_id into approver_company
  from employees
  where id = new.approver_user_id;

  if approver_company is distinct from new.company_id then
    raise exception
      'Approver % does not belong to company %', new.approver_user_id, new.company_id
      using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists approval_tier_approvers_company_check on approval_tier_approvers;
create constraint trigger approval_tier_approvers_company_check
  after insert or update on approval_tier_approvers
  deferrable initially immediate
  for each row
  execute function check_tier_approver_company();

-- ── 4. Reset templates to the structure-only shape ───────────────────────────
-- Existing rows are test data carrying approver_type/approver_user_id inside
-- tiers. Rewriting them in place would mean guessing which company each baked-in
-- person belonged to, so they are cleared instead. Dependent assignment rows go
-- with them via their own cascades.
delete from approval_chain_templates;

comment on column approval_chain_templates.tiers is
  'Structure only: [{ tier, min_verdict, label? }]. Who fills each step lives in approval_tier_approvers.';

-- ── 5. RLS, consistent with the other TMC-owned tables ───────────────────────
-- Deny-by-default: every route reaches this through the service-role client,
-- which bypasses RLS; this closes direct anon-key PostgREST access.
alter table approval_tier_approvers enable row level security;

commit;
