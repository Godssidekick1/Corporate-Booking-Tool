-- ─────────────────────────────────────────────────────────────────────────────
-- Approval routing goes back to being assigned per employee.
--
-- The previous migration gave approval templates band-rank coverage, copying
-- the policy model. That was the wrong shape: a spend limit genuinely is a
-- band-level concept, but an approver is not. Two people at the same rank
-- routinely report to different managers, sit in different cost centres, or
-- need a different sign-off for the same trip. Forcing one route per rank made
-- the common case unexpressible.
--
-- What stays reusable is the SHAPE of a chain — its tiers, its mode, its
-- verdict thresholds. That remains a template. What is assigned per employee
-- is WHICH template applies to them.
--
-- Two layers, so per-employee flexibility doesn't mean per-employee drudgery:
--   employee_approval_templates        — this person, explicitly
--   company_default_approval_templates — everyone else at this company
--
-- The company default is what closes the gap the old per-employee-only model
-- had, where anyone never configured silently bypassed approval entirely. It
-- is a plain default, not a band rule.
-- ─────────────────────────────────────────────────────────────────────────────

begin;

-- ── 1. Remove band-rank coverage ─────────────────────────────────────────────
drop trigger if exists company_approval_templates_no_overlap on company_approval_templates;
drop trigger if exists approval_template_band_ranks_no_overlap on approval_template_band_ranks;
drop function if exists check_company_approval_template_overlap();
drop function if exists check_approval_template_rank_overlap();

drop table if exists approval_template_band_ranks;
drop table if exists company_approval_templates;

-- ── 2. Per-employee assignment ───────────────────────────────────────────────
-- One template per employee per category. The PK enforces that directly, so
-- there is no ambiguity about which chain applies — the thing the band-rank
-- version needed two constraint triggers to guarantee.
create table if not exists employee_approval_templates (
  employee_id uuid not null references employees(id) on delete cascade,
  category    text not null,
  template_id uuid not null references approval_chain_templates(id) on delete cascade,
  assigned_at timestamptz not null default now(),
  assigned_by uuid references employees(id) on delete set null,
  primary key (employee_id, category)
);

create index if not exists employee_approval_templates_template_idx
  on employee_approval_templates (template_id);

-- ── 3. Company default ───────────────────────────────────────────────────────
-- Applies to any employee with no explicit assignment. One per category, again
-- enforced by the PK rather than by validation.
create table if not exists company_default_approval_templates (
  company_id  uuid not null references companies(id) on delete cascade,
  category    text not null,
  template_id uuid not null references approval_chain_templates(id) on delete cascade,
  assigned_at timestamptz not null default now(),
  assigned_by uuid references employees(id) on delete set null,
  primary key (company_id, category)
);

create index if not exists company_default_approval_templates_template_idx
  on company_default_approval_templates (template_id);

-- ── 4. RLS ───────────────────────────────────────────────────────────────────
-- Deny-by-default, consistent with the other TMC-owned tables: every route
-- reaches these through the service-role client, which bypasses RLS.
alter table employee_approval_templates        enable row level security;
alter table company_default_approval_templates enable row level security;

commit;
