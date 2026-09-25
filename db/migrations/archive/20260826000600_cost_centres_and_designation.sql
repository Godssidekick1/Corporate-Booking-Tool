-- ─────────────────────────────────────────────────────────────────────────────
-- Cost centres as a managed list, and a designation on the employee.
--
-- employees.cost_centre and .department were free text typed per employee, so
-- "Sales", "sales" and "Sales " were three different cost centres as far as any
-- report was concerned, and nothing could offer a list to pick from.
--
-- cost_centres gives each client a real list to choose from. employees.cost_centre
-- keeps holding the CODE as text rather than becoming a foreign key: CSV import
-- matches on it, and a hard FK would reject a whole roster upload over one
-- unrecognised value. The traveler-profile screen validates against the list
-- instead, which can report the bad rows and still accept the good ones.
--
-- designation is the job title ("Head of IT"), which is separate from role
-- (permissions) and band (policy). Nothing recorded it before.
-- ─────────────────────────────────────────────────────────────────────────────

begin;

create table if not exists cost_centres (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  code       text not null,
  name       text not null,
  created_at timestamptz not null default now(),

  constraint cost_centres_company_id_code_key unique (company_id, code)
);

create index if not exists cost_centres_company_idx on cost_centres (company_id);

alter table employees
  add column if not exists designation text;

comment on column employees.designation is
  'Job title, e.g. Head of IT. Distinct from role (permissions) and band (policy limits).';

-- Deny-by-default, consistent with the other TMC-managed tables: every route
-- reaches this through the service-role client, which bypasses RLS.
alter table cost_centres enable row level security;

commit;
