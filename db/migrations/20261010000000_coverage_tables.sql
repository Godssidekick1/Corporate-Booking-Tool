-- ── Coverage reports, stored ─────────────────────────────────────────────────
-- Problem: the deal code and commercial coverage screens worked out the winner
-- for EVERY client of the TMC on every request, then searched and paged the
-- result in the server: about 0.9 s per keystroke at 10,000 clients, with the
-- whole report held in memory each time.
--
-- Change: the resolved report is stored, one row per result, and the screens
-- search and page it in SQL. It is rebuilt (by the same resolver the booking
-- path uses, app/lib/coverage) only when it is out of date:
--   * a change counter per TMC and report, bumped by TRIGGERS on every table
--     the report is computed from, so no code path can forget to invalidate;
--   * the date it was built for, because deals and rules open and close by
--     date with nothing being written.
--
--   coverage_state         tmc_id, *_changes (bumped by writes),
--                          *_built_from / *_built_on (what the stored rows reflect)
--   deal_code_coverage     one row per client, airline, code type: the winner
--   commercial_coverage    one row per client: markup, discount, fee in force
--
-- `ord` is the order the resolver produced, so the screen reads exactly as it
-- did when the order was computed in the server.
--
-- Row-level security on, with the app_access policy every table carries
-- (20261009000300_app_role.sql). Safe to apply twice.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.coverage_state (
  tmc_id                  uuid primary key references public.tmcs(id) on delete cascade,
  deal_codes_changes      bigint not null default 1,
  deal_codes_built_from   bigint,
  deal_codes_built_on     date,
  commercials_changes     bigint not null default 1,
  commercials_built_from  bigint,
  commercials_built_on    date
);

create table if not exists public.deal_code_coverage (
  tmc_id       uuid not null references public.tmcs(id) on delete cascade,
  client_id    uuid not null references public.clients(id) on delete cascade,
  ord          integer not null,
  client_name  text not null,
  airline      text not null,
  code_type    text not null,
  code         text not null,
  via          text not null,
  ambiguous    boolean not null,
  beat         jsonb not null,
  primary key (tmc_id, ord)
);
create index if not exists deal_code_coverage_client_idx on public.deal_code_coverage (client_id);

create table if not exists public.commercial_coverage (
  tmc_id              uuid not null references public.tmcs(id) on delete cascade,
  client_id           uuid not null references public.clients(id) on delete cascade,
  ord                 integer not null,
  client_name         text not null,
  markup              text,
  markup_via          text,
  discount            text,
  discount_via        text,
  fee                 text,
  fee_via             text,
  net_percent         numeric,
  loss_making         boolean not null,
  ambiguous           boolean not null,
  varies_by_category  text[] not null,
  switched_off        text[] not null,
  primary key (tmc_id, ord)
);
create index if not exists commercial_coverage_client_idx on public.commercial_coverage (client_id);

alter table public.coverage_state enable row level security;
alter table public.deal_code_coverage enable row level security;
alter table public.commercial_coverage enable row level security;

do $$
declare t text;
begin
  foreach t in array array['coverage_state', 'deal_code_coverage', 'commercial_coverage'] loop
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = 'app_access') then
      execute format('create policy app_access on public.%I to cbt_app using (true) with check (true)', t);
    end if;
  end loop;
end $$;

-- ── Invalidation ─────────────────────────────────────────────────────────────
-- Bumps the change counter of the TMC a written row belongs to (both TMCs, if
-- an update moved it). TG_ARGV[0] says which reports the table feeds
-- ('deal_codes', 'commercials' or 'both'); bucket_clients carries no tmc_id,
-- so it is found through its bucket.
create or replace function public.coverage_bump(tmc uuid, feeds text) returns void
language sql as $$
  -- `exists`: while a TMC itself is being deleted its rows cascade through
  -- here, and there is no report left to invalidate.
  insert into public.coverage_state (tmc_id)
  select tmc where tmc is not null and exists (select 1 from public.tmcs where id = tmc)
  on conflict (tmc_id) do update set
    deal_codes_changes  = coverage_state.deal_codes_changes  + (case when feeds in ('deal_codes', 'both') then 1 else 0 end),
    commercials_changes = coverage_state.commercials_changes + (case when feeds in ('commercials', 'both') then 1 else 0 end);
$$;

create or replace function public.coverage_touch() returns trigger
language plpgsql as $$
declare
  tmc uuid;
begin
  -- NEW exists for insert and update, OLD for update and delete; each is read
  -- only when it exists.
  if tg_op <> 'DELETE' then
    if tg_table_name = 'bucket_clients' then
      select b.tmc_id into tmc from public.buckets b where b.id = new.bucket_id;
    else
      tmc := new.tmc_id;
    end if;
    perform public.coverage_bump(tmc, tg_argv[0]);
  end if;
  if tg_op <> 'INSERT' then
    if tg_table_name = 'bucket_clients' then
      select b.tmc_id into tmc from public.buckets b where b.id = old.bucket_id;
    else
      tmc := old.tmc_id;
    end if;
    perform public.coverage_bump(tmc, tg_argv[0]);
  end if;
  return null;
end $$;

do $$
declare
  src record;
begin
  for src in
    select * from (values
      ('deal_codes',                  'deal_codes',  null),
      ('deal_code_assignments',       'deal_codes',  null),
      ('commercial_rules',            'commercials', null),
      ('commercial_rule_assignments', 'commercials', null),
      ('buckets',                     'both',        'name'),
      ('bucket_clients',              'both',        null),
      ('client_groups',               'both',        'name'),
      ('clients',                     'both',        'name, tmc_id, client_group_id, markup_active, discount_active, processing_fee_active')
    ) as s(tbl, feeds, cols)
  loop
    execute format('drop trigger if exists coverage_touch on public.%I', src.tbl);
    -- Updates only of the columns a report reads, where that is narrower than
    -- the whole row: a client's address changing does not move its deal codes.
    execute format(
      'create trigger coverage_touch after insert or delete or update%s on public.%I
         for each row execute function public.coverage_touch(%L)',
      case when src.cols is null then '' else ' of ' || src.cols end, src.tbl, src.feeds);
  end loop;
end $$;
