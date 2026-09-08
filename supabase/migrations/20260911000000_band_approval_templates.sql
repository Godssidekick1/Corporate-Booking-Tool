-- ============================================================================
-- The missing rung: assign an approval chain to a BAND
--
-- Routing has had two levels since approvals-per-employee landed:
--
--   employee_approval_templates       this person, explicitly
--   client_default_approval_templates everyone else at this client
--
-- Which makes the critique fair: if a template has to be attached person by
-- person, the template IS the indirection and direct mapping wins. A template
-- only earns its keep when one assignment covers many people, and nothing
-- between "one person" and "the entire client" existed.
--
-- So the ladder becomes:
--
--   employee  ->  band  ->  client default
--
-- Most specific wins. Set a band's chain once and it covers everyone in it;
-- direct mapping stays as the per-person override, which is the thing it is
-- genuinely good at.
--
-- THIS IS NOT A REVERT OF 20260826000300.
-- That migration removed approval_template_band_ranks, which was a COVERAGE
-- model: templates declared rank sets, and constraint triggers had to stop two
-- templates claiming the same rank. This is a plain assignment map — one row
-- says "band X at client Y routes through template Z" — so a conflict is
-- impossible by construction rather than by trigger, and the primary key is the
-- whole enforcement.
--
-- KEYED ON band_code, NOT band_rank.
-- Employees carry band_code, and bands are per-client, so (client_id,
-- band_code) is the pair that resolution already has in hand. Rank is a
-- property of the band, not the identity of one — two clients using rank 3 for
-- different things is normal, and this table is per-client anyway.
-- ============================================================================

begin;

create table if not exists band_approval_templates (
  client_id   uuid not null references clients(id) on delete cascade,
  band_code   text not null,
  category    text not null,
  template_id uuid not null references approval_chain_templates(id) on delete cascade,
  assigned_at timestamptz not null default now(),
  assigned_by uuid references employees(id) on delete set null,
  -- One template per band per category, enforced by the key rather than by
  -- validation — the same shape as the two tables it sits between.
  primary key (client_id, band_code, category)
);

comment on table band_approval_templates is
  'Approval chain for every employee in one band at one client. The middle rung '
  'of employee -> band -> client default; most specific wins.';

-- Deleting a template should not silently strip routing: the FK above cascades,
-- so the row goes and the employee falls through to the client default, which
-- is the same behaviour the per-employee table already has.
create index if not exists band_approval_templates_template_idx
  on band_approval_templates (template_id);

-- Referential integrity against the band itself, but only if `bands` actually
-- carries a unique (client_id, code) to point at. Added conditionally rather
-- than assumed: the bands table predates these migrations, its constraints are
-- not declared in this directory, and a migration that fails on an assumption
-- about someone else's schema is worse than one that degrades to a documented
-- soft reference. Without the FK a renamed or deleted band leaves a row that
-- simply matches nothing, and resolution falls through to the client default.
do $$
begin
  if exists (
    select 1
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public'
      and t.relname = 'bands'
      and c.contype in ('p', 'u')
      and (
        select array_agg(a.attname order by a.attname)
        from unnest(c.conkey) as k(attnum)
        join pg_attribute a on a.attrelid = t.oid and a.attnum = k.attnum
      ) = array['client_id', 'code']
  ) and not exists (
    select 1 from pg_constraint
    where conname = 'band_approval_templates_band_fk'
  ) then
    alter table band_approval_templates
      add constraint band_approval_templates_band_fk
      foreign key (client_id, band_code)
      references bands (client_id, code)
      on delete cascade
      on update cascade;
  end if;
end $$;

-- Deny-by-default, consistent with every other table here: routes reach this
-- through the service-role client, which bypasses RLS, and enabling it with no
-- policy closes direct anon-key PostgREST access.
alter table band_approval_templates enable row level security;

commit;
