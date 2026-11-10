-- ── Refunds for cancelled tickets ────────────────────────────────────────────
-- Problem: a cancelled ticket (20261105000000_booking_cancellation) records
-- what the provider said, and nothing more. Nobody works out what the
-- company gets back, nothing records it, and there is no credit note.
--
-- Change:
--   refunds               one row per cancelled passenger ticket, created
--                         'pending' when the booking is cancelled; the TMC
--                         processes it (the lines it settled on are frozen,
--                         a credit note number is issued) or rejects it
--   refund_attachments    documents on a refund (PDF/JPG/PNG, at most 5 MB),
--                         kept in the database so backups need nothing extra
--   credit_note_counters  the last credit note number per TMC and financial
--                         year, taken inside the processing transaction:
--                         no gaps, no duplicates
--   clients.refund_*      the TMC's refund rule for each client: whether
--                         markup and the processing fee go back, its own
--                         cancellation fee, and the GST rate on its charges
--   bookings.airline_pnr  the airline's own PNR, captured at ticketing
--
-- Tenant rows like search_fares: tmc_id filled from the client, the same
-- app_access rule, moved with the client. Safe to apply twice.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.bookings add column if not exists airline_pnr text;

alter table public.clients
  add column if not exists refund_markup boolean not null default false,
  add column if not exists refund_processing_fee boolean not null default false,
  add column if not exists tmc_cancellation_fee numeric(12,2) not null default 0,
  add column if not exists tmc_cancellation_fee_unit text not null default 'amount',
  add column if not exists gst_rate numeric(5,2) not null default 18;

alter table public.clients drop constraint if exists clients_refund_rule_check;
alter table public.clients add constraint clients_refund_rule_check check (
  tmc_cancellation_fee >= 0 and tmc_cancellation_fee_unit in ('amount', 'percent')
  and (tmc_cancellation_fee_unit = 'amount' or tmc_cancellation_fee <= 100)
  and gst_rate >= 0 and gst_rate <= 100);

create table if not exists public.refunds (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  tmc_id uuid,
  booking_id uuid not null references public.bookings(id) on delete cascade,
  passenger_index integer not null check (passenger_index >= 0),
  ticket_number text,
  status text not null default 'pending' check (status in ('pending', 'processed', 'rejected')),
  lines jsonb,
  refund_amount numeric(12,2),
  airline_refund numeric(12,2),
  tmc_retained numeric(12,2),
  credit_note_no text,
  refund_date date,
  mode text check (mode is null or mode in ('corporate_card', 'agency_credit', 'traveller_card', 'other')),
  remark text check (remark is null or char_length(remark) <= 1000),
  processed_by uuid references public.employees(id) on delete set null,
  processed_at timestamptz,
  rejected_reason text check (rejected_reason is null or char_length(rejected_reason) <= 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (booking_id, passenger_index),
  check (status <> 'processed' or (credit_note_no is not null and refund_amount is not null and lines is not null)),
  check (status <> 'rejected' or rejected_reason is not null)
);

create unique index if not exists refunds_credit_note_idx on public.refunds (tmc_id, credit_note_no)
  where credit_note_no is not null;
create index if not exists refunds_queue_idx on public.refunds (tmc_id, status, created_at desc);
create index if not exists refunds_client_id_fk_idx on public.refunds (client_id);
create index if not exists refunds_processed_by_fk_idx on public.refunds (processed_by);

create table if not exists public.refund_attachments (
  id uuid primary key default gen_random_uuid(),
  refund_id uuid not null references public.refunds(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  tmc_id uuid,
  filename text not null check (char_length(filename) between 1 and 200),
  content_type text not null check (content_type in ('application/pdf', 'image/jpeg', 'image/png')),
  size integer not null check (size > 0 and size <= 5242880),
  bytes bytea not null,
  uploaded_by uuid references public.employees(id) on delete set null,
  uploaded_at timestamptz not null default now()
);

create index if not exists refund_attachments_refund_id_fk_idx on public.refund_attachments (refund_id);
create index if not exists refund_attachments_client_id_fk_idx on public.refund_attachments (client_id);
create index if not exists refund_attachments_uploaded_by_fk_idx on public.refund_attachments (uploaded_by);
create index if not exists refund_attachments_tmc_idx on public.refund_attachments (tmc_id);

create table if not exists public.credit_note_counters (
  tmc_id uuid not null references public.tmcs(id) on delete cascade,
  financial_year text not null check (financial_year ~ '^\d{4}-\d{2}$'),
  last_no integer not null default 0 check (last_no >= 0),
  primary key (tmc_id, financial_year)
);

-- Tenant column, filled from the client; row level security as search_fares.
do $$
declare t text;
begin
  foreach t in array array['refunds', 'refund_attachments'] loop
    execute format('drop trigger if exists fill_tmc on public.%I', t);
    execute format('create trigger fill_tmc before insert or update of client_id, tmc_id on public.%I
      for each row execute function public.fill_tmc_from_client()', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists app_access on public.%I', t);
    execute format($p$create policy app_access on public.%I to cbt_app
      using ((select public.app_scope()) = 'system'
        or (((select public.app_client()) is not null and client_id = (select public.app_client()))
          or ((select public.app_client()) is null and tmc_id = (select public.app_tmc()))))
      with check ((select public.app_scope()) = 'system'
        or (((select public.app_client()) is not null and client_id = (select public.app_client()))
          or ((select public.app_client()) is null and tmc_id = (select public.app_tmc()))))$p$, t);
    execute format('grant select, insert, update, delete on public.%I to cbt_app', t);
  end loop;
end $$;

-- The counter belongs to a TMC, never to a client's own users.
alter table public.credit_note_counters enable row level security;
drop policy if exists app_access on public.credit_note_counters;
create policy app_access on public.credit_note_counters to cbt_app
  using ((select public.app_scope()) = 'system'
    or ((select public.app_client()) is null and tmc_id = (select public.app_tmc())))
  with check ((select public.app_scope()) = 'system'
    or ((select public.app_client()) is null and tmc_id = (select public.app_tmc())));
grant select, insert, update on public.credit_note_counters to cbt_app;

-- A client moving to another TMC takes its rows with it (as 20261020000200,
-- with the two refund tables added).
create or replace function public.client_moved_tmc() returns trigger
language plpgsql security definer set search_path = public as $$
declare t text;
begin
  foreach t in array array[
    'approval_tier_approvers', 'approvals', 'band_approval_templates', 'bands', 'bookings', 'bucket_clients',
    'client_default_approval_templates', 'client_gst_registrations', 'client_mandatory_info',
    'client_policy_groups', 'cost_centres', 'employee_client_access', 'price_quotes', 'trip_expenses', 'trips',
    'search_fares', 'refunds', 'refund_attachments'] loop
    execute format('update public.%I set tmc_id = $1 where client_id = $2', t) using new.tmc_id, new.id;
  end loop;
  update public.employees set tenant_tmc_id = new.tmc_id where client_id = new.id;
  return null;
end $$;

-- Tickets cancelled before this existed get their pending refunds now: one
-- per passenger of every ticketed booking already cancelled.
insert into public.refunds (client_id, booking_id, passenger_index, ticket_number)
select b.client_id, b.id, p.idx - 1, b.ticket_numbers[p.idx]
  from public.bookings b
  cross join lateral generate_series(1, greatest(1, jsonb_array_length(coalesce(b.traveler_snapshot -> 'PassengerDetails', '[]'::jsonb)))) as p(idx)
 where b.status in ('cancelled', 'cancel_requested')
   and coalesce((b.cancellation ->> 'wasTicketed')::boolean, false)
on conflict (booking_id, passenger_index) do nothing;
