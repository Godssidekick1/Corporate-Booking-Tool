-- ─────────────────────────────────────────────────────────────────────────────
-- Keep employees in step with their band when the band is edited.
--
-- employees.band_code and employees.band_rank are denormalised copies of the
-- bands row, kept so dashboard and profile reads don't need a join. Nothing
-- re-synced them, which was harmless only because bands could never change:
-- they were hardcoded L1..L5 at company creation with no API to edit them.
--
-- Band management makes them editable, and that turns the stale copy into a
-- real fault: resolveEffectivePolicy looks up bands by
-- (company_id, employee.band_code), so renaming L3 -> A3 would leave every
-- employee pointing at a band code that no longer exists. They would resolve
-- to `no_band` and their bookings would stop being policy-checked silently.
--
-- Doing this in a trigger rather than the route handler means it holds for any
-- writer — bulk import, a future admin tool, or a manual dashboard edit.
-- ─────────────────────────────────────────────────────────────────────────────

begin;

create or replace function sync_employees_on_band_change()
returns trigger
language plpgsql
as $$
begin
  if new.code is distinct from old.code or new.rank is distinct from old.rank then
    -- Match on band_id where it is set, and fall back to the old code for rows
    -- written by paths that only populated the denormalised columns.
    update employees
       set band_code = new.code,
           band_rank = new.rank
     where company_id = new.company_id
       and (
         band_id = new.id
         or (band_id is null and band_code = old.code)
       );
  end if;

  return new;
end;
$$;

drop trigger if exists bands_sync_employees on bands;
create trigger bands_sync_employees
  after update on bands
  for each row
  execute function sync_employees_on_band_change();

commit;
