-- ── Tenant isolation enforced by the database ────────────────────────────────
-- Problem: every table's row-level-security policy for the app role allowed
-- every row (`using (true)`, 20261009000300_app_role.sql). Tenant isolation
-- lived only in application code -- every query filtering by tenant, checked
-- by the leak sweep (tests/security). One query that forgot its filter would
-- have answered with another company's rows.
--
-- Change: each tenant table's app_access policy now admits only the rows of
-- the tenant the request runs as. The app sets three settings on every query
-- (app/lib/db/context.ts):
--   app.scope      'tenant' | 'system' | '' (nothing)
--   app.tmc_id     the TMC
--   app.client_id  the client, for a corporate user; empty for TMC staff
--
--   no scope       no tenant rows at all: forgetting to set one fails closed
--   system         every row (sign-in, link checks, the platform console)
--   tenant         TMC staff: their TMC's rows and its clients' rows
--                  corporate user: their client's rows, and their TMC's
--                  shared rows (masters, templates) that name no client
--
-- How each table finds its tenant:
--   tmc_id                       the row's own TMC
--   client_id (+ maybe tmc_id)   the client must be visible -- the clients
--                                policy decides, so the rule lives once
--   employee_id only             the employee must be visible
--   a parent row only            the parent must be visible
--
-- Shared tables keep allow-all, listed at the end and in tests/schema.test.ts:
-- reference data, and the sign-in tables (reached only by app/lib/auth).
--
-- The owner bypasses row-level security, so migrations and the owner's own
-- sessions are unaffected. Safe to apply twice.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.app_scope() returns text
language sql stable as $$ select coalesce(current_setting('app.scope', true), '') $$;

create or replace function public.app_tmc() returns uuid
language sql stable as $$ select nullif(current_setting('app.tmc_id', true), '')::uuid $$;

create or replace function public.app_client() returns uuid
language sql stable as $$ select nullif(current_setting('app.client_id', true), '')::uuid $$;

do $$
declare
  t text;
  rule text;
  -- A tenant's own rows, by how the table names its tenant.
  by_tmc        constant text := 'tmc_id = public.app_tmc()';
  by_client     constant text := 'client_id in (select id from public.clients)';
  by_either     constant text := 'case when client_id is not null then client_id in (select id from public.clients) else tmc_id = public.app_tmc() end';
  by_employee   constant text := 'employee_id in (select id from public.employees)';
begin
  for t, rule in
    select * from (values
      -- the tenant themselves
      ('tmcs',                        'id = public.app_tmc()'),
      ('clients',                     'case when public.app_client() is not null then id = public.app_client() else tmc_id = public.app_tmc() end'),
      -- a TMC's own masters
      ('branches', by_tmc), ('buckets', by_tmc), ('client_groups', by_tmc), ('commercial_rules', by_tmc),
      ('coverage_state', by_tmc), ('deal_codes', by_tmc), ('deal_code_categories', by_tmc),
      ('fop_gds_entries', by_tmc), ('fop_payment_types', by_tmc), ('forms_of_payment', by_tmc),
      ('policy_groups', by_tmc),
      -- a TMC's rows that may also name one of its clients
      ('approval_chain_templates', by_either), ('audit_log', by_either), ('commercial_coverage', by_either),
      ('commercial_rule_assignments', by_either), ('deal_code_assignments', by_either),
      ('deal_code_coverage', by_either), ('employees', by_either), ('fop_assignments', by_either),
      ('policy_rules', by_either),
      -- a client's rows
      ('approval_tier_approvers', by_client), ('approvals', by_client), ('band_approval_templates', by_client),
      ('bands', by_client), ('bookings', by_client), ('bucket_clients', by_client),
      ('client_default_approval_templates', by_client), ('client_gst_registrations', by_client),
      ('client_mandatory_info', by_client), ('client_policy_groups', by_client), ('cost_centres', by_client),
      ('employee_client_access', by_client), ('price_quotes', by_client), ('trip_expenses', by_client),
      ('trips', by_client),
      -- an employee's rows
      ('employee_approval_templates', by_employee), ('employee_permissions', by_employee),
      -- rows that belong to a parent row
      ('policy_group_band_ranks', 'policy_group_id in (select id from public.policy_groups)'),
      ('deal_code_category_types', 'category_id in (select id from public.deal_code_categories)')
    ) as v(t, rule)
  loop
    execute format('drop policy if exists app_access on public.%I', t);
    execute format(
      'create policy app_access on public.%I to cbt_app
         using (public.app_scope() = ''system'' or (public.app_scope() = ''tenant'' and (%s)))
         with check (public.app_scope() = ''system'' or (public.app_scope() = ''tenant'' and (%s)))',
      t, rule, rule);
  end loop;
end $$;

-- The audit log is written by events that belong to no tenant (a sign-in, a
-- password reset, a platform action) and must never refuse an entry, so any
-- request may ADD to it. Reading, changing and removing entries stay
-- tenant-scoped, through app_access above (a permissive policy per command:
-- an insert passes if either policy allows it).
drop policy if exists app_audit_append on public.audit_log;
create policy app_audit_append on public.audit_log for insert to cbt_app with check (true);

-- Shared, unchanged (allow-all for the app role):
--   reference   airlines, airports, cities, countries, regions, amadeus_session
--   sign-in     accounts, sessions, auth_tokens, auth_attempts, platform_admins,
--               rate_limits
--   history     schema_migrations (read only)
