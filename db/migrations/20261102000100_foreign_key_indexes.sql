-- ── Every foreign key gets an index ─────────────────────────────────────────
-- Problem: 41 foreign-key columns had no index (24 of them pointing at
-- employees: created_by, assigned_by, granted_by, confirmed_by...). PostgreSQL
-- indexes the referenced side, never the referencing one, so deleting one
-- employee or client checks each referring table by reading it whole -- a
-- cost that grows with the data. Not visible yet: on the 2026-10-22 dump,
-- removing the whole 2,000-client demo TMC took 0.6 s without these indexes
-- and 0.5 s with them (one bulk delete per table amortises the scans). The
-- indexes are for the single-row deletes at scale, and the guard below.
--
-- Change: an index on the columns of every foreign key that no index leads
-- with, named <table>_<columns>_fk_idx. Found here, from the catalog, rather
-- than listed by hand: the same answer on every database this runs on, and
-- nothing to miss. tests/schema.test.ts keeps it that way: a new foreign key
-- without an index fails the suite.
--
-- Plain (not concurrent) creation, inside the migration's transaction: the
-- tables are small (the largest, bookings, about 30 MB). Safe to apply twice.
-- ─────────────────────────────────────────────────────────────────────────────

do $$
declare
  fk record;
  idx text;
begin
  for fk in
    select c.conrelid::regclass as tbl, c.conrelid as relid, c.conkey,
           array_agg(a.attname order by k.ord) as cols
      from pg_constraint c
      cross join lateral unnest(c.conkey) with ordinality k(attnum, ord)
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
     where c.contype = 'f' and c.connamespace = 'public'::regnamespace
       and not exists (
         select 1 from pg_index i
          where i.indrelid = c.conrelid
            and (i.indkey::int2[])[0:array_length(c.conkey, 1) - 1] @> c.conkey
            and (i.indkey::int2[])[0:array_length(c.conkey, 1) - 1] <@ c.conkey)
     group by c.oid, c.conrelid, c.conkey
     order by 1, 4
  loop
    idx := left(format('%s_%s_fk_idx', (select relname from pg_class where oid = fk.relid), array_to_string(fk.cols, '_')), 63);
    execute format('create index if not exists %I on %s (%s)', idx, fk.tbl,
      (select string_agg(quote_ident(col), ', ') from unnest(fk.cols) as col));
  end loop;
end $$;
