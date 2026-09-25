-- ============================================================================
-- Approvals: split 'flights_hotels' into 'air' and 'hotel'
--
-- categoryForTravelType collapses every flight and every hotel into one routing
-- bucket, so a client cannot say "flights need approval before booking, hotels
-- do not". That is a real arrangement - it is what the screen this replaces
-- shows on a live account - and today it is inexpressible.
--
-- Categories become: air | hotel | misc.
--
-- ROUTING IS PRESERVED, NOT RESET. Every existing flights_hotels assignment is
-- duplicated into an air row and a hotel row pointing at the same template, so
-- a client routing through a chain before this migration still routes through
-- it for both afterwards. Nobody has to reconfigure anything; they now merely
-- CAN split the two.
--
-- AND category COMES OFF approval_chain_templates.
-- A template is a chain of steps with verdict thresholds. Nothing about it is
-- air-specific or hotel-specific - the category is a property of the ASSIGNMENT
-- ("this client routes hotels through this chain"), not of the chain.
--
-- Leaving it on the template would force every existing template to be
-- duplicated into an air copy and a hotel copy, which then drift the first time
-- someone edits one and forgets the other. Moving it also retires the
-- "That template routes X, not Y" check, which only ever existed to police a
-- column that was on the wrong table.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 0. Clear the way
--
-- The base DDL for two of these tables predates this migrations directory, so
-- any CHECK pinning category to the old two values is not visible here. Found
-- and dropped by inspection rather than by name - a hardcoded constraint name
-- that turns out not to exist would make this migration fail on a technicality.
-- ----------------------------------------------------------------------------
do $$
declare
  victim record;
begin
  for victim in
    select t.relname as table_name, c.conname as constraint_name
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public'
      and c.contype = 'c'
      and pg_get_constraintdef(c.oid) like '%flights_hotels%'
  loop
    execute format('alter table %I drop constraint %I', victim.table_name, victim.constraint_name);
    raise notice 'dropped check constraint % on %', victim.constraint_name, victim.table_name;
  end loop;
end $$;

-- ----------------------------------------------------------------------------
-- 1. Duplicate, then rename
--
-- Order matters: the hotel copies are inserted while the originals still say
-- flights_hotels. Renaming first would leave the select finding nothing, and
-- every client would silently lose hotel routing.
-- ----------------------------------------------------------------------------
insert into client_default_approval_templates (client_id, category, template_id, assigned_at, assigned_by)
select client_id, 'hotel', template_id, assigned_at, assigned_by
from client_default_approval_templates
where category = 'flights_hotels'
on conflict do nothing;

update client_default_approval_templates set category = 'air' where category = 'flights_hotels';

insert into band_approval_templates (client_id, band_code, category, template_id, assigned_at, assigned_by)
select client_id, band_code, 'hotel', template_id, assigned_at, assigned_by
from band_approval_templates
where category = 'flights_hotels'
on conflict do nothing;

update band_approval_templates set category = 'air' where category = 'flights_hotels';

insert into employee_approval_templates (employee_id, category, template_id, assigned_at, assigned_by)
select employee_id, 'hotel', template_id, assigned_at, assigned_by
from employee_approval_templates
where category = 'flights_hotels'
on conflict do nothing;

update employee_approval_templates set category = 'air' where category = 'flights_hotels';

-- ----------------------------------------------------------------------------
-- 2. Retire the column that was on the wrong table
-- ----------------------------------------------------------------------------
alter table approval_chain_templates drop column if exists category;

comment on table approval_chain_templates is
  'A reusable chain of approval steps. Deliberately has NO category: which kind '
  'of spend a chain routes is decided where it is assigned, not by the chain '
  'itself, so one chain can serve air, hotel and misc without being duplicated.';

commit;
