-- ── Tenant policies the planner can work with ────────────────────────────────
-- Problem: the policies of 20261012000000_tenant_policies were correct and
-- slow. Measured as the app's own login (npm run scale, 10,000 clients):
-- the buckets list 20 ms -> 2.8 s, the FOP mapping list 64 ms -> 2.2 s, an
-- approver's queue 8 ms -> 530 ms. Three causes:
--   * a client-scoped row was checked with `client_id in (select id from
--     clients)`, building the TMC's whole client list for every query;
--   * app_scope()/app_tmc() ran once per ROW (each reads a setting);
--   * the CASE and nested OR left the planner unable to estimate how many rows
--     a policy keeps (75 estimated, 10,008 actual), so it chose nested loops
--     that discarded a million row pairs where a hash join was right.
--
-- Change:
--   * every client-scoped table carries its tenant itself, `tmc_id`, filled
--     from the row's client by a trigger on every insert or change of client
--     (and kept in step if a client moves TMC) -- no code path sets it, and a
--     value a writer sends is overwritten. employees gets `tenant_tmc_id` the
--     same way (its own tmc_id means "TMC staff of" and stays as it is);
--   * every policy is plain equality on the row's own columns, with each
--     setting read once per query: `(select app_tmc())`;
--   * no CASE: "a corporate user sees only their client" is
--     `app_client() is null or client_id = app_client()`.
--
-- The scope rules themselves are unchanged (20261012000000_tenant_policies
-- says what each caller sees). app.tmc_id is set only for a tenant scope, so
-- "no scope" still matches nothing. Safe to apply twice.
-- ─────────────────────────────────────────────────────────────────────────────

-- The client's TMC, read past row-level security: a trigger filling a column
-- must see the client whatever the writer's own scope.
create or replace function public.client_tmc(client uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select tmc_id from public.clients where id = client
$$;
revoke all on function public.client_tmc(uuid) from public;
grant execute on function public.client_tmc(uuid) to cbt_app;

create or replace function public.fill_tmc_from_client() returns trigger
language plpgsql as $$
begin
  new.tmc_id := public.client_tmc(new.client_id);
  return new;
end $$;

create or replace function public.fill_employee_tenant() returns trigger
language plpgsql as $$
begin
  new.tenant_tmc_id := coalesce(new.tmc_id, public.client_tmc(new.client_id));
  return new;
end $$;

do $$
declare
  t text;
  rule text;
  sys constant text := '(select public.app_scope()) = ''system''';
  tmc constant text := '(select public.app_tmc())';
  cli constant text := '(select public.app_client())';
  client_tables constant text[] := array[
    'approval_tier_approvers', 'approvals', 'band_approval_templates', 'bands', 'bookings', 'bucket_clients',
    'client_default_approval_templates', 'client_gst_registrations', 'client_mandatory_info',
    'client_policy_groups', 'cost_centres', 'employee_client_access', 'price_quotes', 'trip_expenses', 'trips'];
begin
  -- The tenant column on client-scoped tables.
  foreach t in array client_tables loop
    execute format('alter table public.%I add column if not exists tmc_id uuid', t);
    execute format('drop trigger if exists fill_tmc on public.%I', t);
    execute format('update public.%I x set tmc_id = c.tmc_id from public.clients c
                     where c.id = x.client_id and x.tmc_id is distinct from c.tmc_id', t);
    execute format('create trigger fill_tmc before insert or update of client_id, tmc_id on public.%I
                     for each row execute function public.fill_tmc_from_client()', t);
    execute format('create index if not exists %I on public.%I (tmc_id)', t || '_tmc_idx', t);
  end loop;

  -- And on employees.
  alter table public.employees add column if not exists tenant_tmc_id uuid;
  drop trigger if exists fill_tenant on public.employees;
  update public.employees e set tenant_tmc_id = coalesce(e.tmc_id, c.tmc_id)
    from public.clients c where c.id = e.client_id and e.tenant_tmc_id is distinct from coalesce(e.tmc_id, c.tmc_id);
  update public.employees set tenant_tmc_id = tmc_id where client_id is null and tenant_tmc_id is distinct from tmc_id;
  create trigger fill_tenant before insert or update of client_id, tmc_id, tenant_tmc_id on public.employees
    for each row execute function public.fill_employee_tenant();
  create index if not exists employees_tenant_tmc_idx on public.employees (tenant_tmc_id);

  -- The policies.
  for t, rule in
    select * from (values
      ('tmcs',    format('id = %s', tmc)),
      ('clients', format('id = %s or (%s is null and tmc_id = %s)', cli, cli, tmc))
    ) as v(t, rule)
    union all
    select x, format('tmc_id = %s', tmc) from unnest(array[
      'branches', 'buckets', 'client_groups', 'commercial_rules', 'coverage_state', 'deal_codes',
      'deal_code_categories', 'fop_gds_entries', 'fop_payment_types', 'forms_of_payment', 'policy_groups']) x
    union all
    -- TMC rows that may name one of its clients (tmc_id never null).
    select x, format('tmc_id = %s and (%s is null or client_id is null or client_id = %s)', tmc, cli, cli) from unnest(array[
      'approval_chain_templates', 'commercial_coverage', 'commercial_rule_assignments', 'deal_code_assignments',
      'deal_code_coverage', 'fop_assignments']) x
    union all
    -- A client's rows: by client for a corporate user (so a client with no
    -- TMC still sees its own), by TMC for TMC staff.
    select x, format('(%s is not null and client_id = %s) or (%s is null and tmc_id = %s)', cli, cli, cli, tmc) from unnest(client_tables) x
    union all
    -- People: a corporate user sees their colleagues and their TMC's staff.
    select 'employees', format(
      '(%s is not null and (client_id = %s or (client_id is null and tenant_tmc_id = %s))) or (%s is null and tenant_tmc_id = %s)',
      cli, cli, tmc, cli, tmc)
    union all
    -- An employee's rows, a parent's rows: through the parent's own policy.
    select x, 'employee_id in (select id from public.employees)' from unnest(array['employee_approval_templates', 'employee_permissions']) x
    union all
    select 'policy_group_band_ranks', 'policy_group_id in (select id from public.policy_groups)'
    union all
    select 'deal_code_category_types', 'category_id in (select id from public.deal_code_categories)'
    union all
    -- tmc_id may be null; read a few rows at a time.
    select x, format('(client_id is not null and client_id in (select id from public.clients)) or (client_id is null and tmc_id = %s)', tmc)
      from unnest(array['policy_rules', 'audit_log']) x
  loop
    execute format('drop policy if exists app_access on public.%I', t);
    execute format('create policy app_access on public.%I to cbt_app using (%s or (%s)) with check (%s or (%s))',
      t, sys, rule, sys, rule);
  end loop;
end $$;

-- A client moving to another TMC takes its rows with it.
create or replace function public.client_moved_tmc() returns trigger
language plpgsql security definer set search_path = public as $$
declare t text;
begin
  foreach t in array array[
    'approval_tier_approvers', 'approvals', 'band_approval_templates', 'bands', 'bookings', 'bucket_clients',
    'client_default_approval_templates', 'client_gst_registrations', 'client_mandatory_info',
    'client_policy_groups', 'cost_centres', 'employee_client_access', 'price_quotes', 'trip_expenses', 'trips'] loop
    execute format('update public.%I set tmc_id = $1 where client_id = $2', t) using new.tmc_id, new.id;
  end loop;
  update public.employees set tenant_tmc_id = new.tmc_id where client_id = new.id;
  return null;
end $$;
drop trigger if exists client_moved_tmc on public.clients;
create trigger client_moved_tmc after update of tmc_id on public.clients
  for each row when (old.tmc_id is distinct from new.tmc_id) execute function public.client_moved_tmc();
