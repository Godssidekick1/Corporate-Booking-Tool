-- ── What a traveller was shown by a search ───────────────────────────────────
-- Problem: "lowest logical fare" (a cheaper fare departing within N minutes
-- of the one chosen needs approval) cannot be judged at booking time: the
-- search results were sent to the browser and never kept, and the browser's
-- own copy is not something a policy check can trust.
--
-- Change: search_fares, one row per search: what the traveller was shown,
-- after the policy filter and markup, in compact form (per flight: its key,
-- outbound departure, route, a label, and each fare's pricing key and total).
-- Written by /api/book/search; read by add-passenger and the policy preview.
-- Kept only briefly: rows older than two hours are removed on each insert.
--
-- A client's rows like price_quotes: tenant column filled from the client,
-- row level security, the same app_access rule, and moved with its client.
--
-- Safe to apply twice.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.search_fares (
  id uuid primary key default gen_random_uuid(),
  search_key text not null,
  client_id uuid not null references public.clients(id) on delete cascade,
  tmc_id uuid,
  traveller_id uuid not null references public.employees(id) on delete cascade,
  created_at timestamptz not null default now(),
  flights jsonb not null
);

create index if not exists search_fares_lookup_idx on public.search_fares (search_key, traveller_id, created_at desc);
create index if not exists search_fares_created_idx on public.search_fares (created_at);
create index if not exists search_fares_tmc_idx on public.search_fares (tmc_id);
create index if not exists search_fares_traveller_idx on public.search_fares (traveller_id);

drop trigger if exists fill_tmc on public.search_fares;
create trigger fill_tmc before insert or update of client_id, tmc_id on public.search_fares
  for each row execute function public.fill_tmc_from_client();

alter table public.search_fares enable row level security;
drop policy if exists app_access on public.search_fares;
create policy app_access on public.search_fares to cbt_app
  using ((select public.app_scope()) = 'system'
    or (((select public.app_client()) is not null and client_id = (select public.app_client()))
      or ((select public.app_client()) is null and tmc_id = (select public.app_tmc()))))
  with check ((select public.app_scope()) = 'system'
    or (((select public.app_client()) is not null and client_id = (select public.app_client()))
      or ((select public.app_client()) is null and tmc_id = (select public.app_tmc()))));

-- A client moving to another TMC takes its rows with it (as 20261012000100,
-- with search_fares added).
create or replace function public.client_moved_tmc() returns trigger
language plpgsql security definer set search_path = public as $$
declare t text;
begin
  foreach t in array array[
    'approval_tier_approvers', 'approvals', 'band_approval_templates', 'bands', 'bookings', 'bucket_clients',
    'client_default_approval_templates', 'client_gst_registrations', 'client_mandatory_info',
    'client_policy_groups', 'cost_centres', 'employee_client_access', 'price_quotes', 'trip_expenses', 'trips',
    'search_fares'] loop
    execute format('update public.%I set tmc_id = $1 where client_id = $2', t) using new.tmc_id, new.id;
  end loop;
  update public.employees set tenant_tmc_id = new.tmc_id where client_id = new.id;
  return null;
end $$;
