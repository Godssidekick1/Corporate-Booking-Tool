-- ─────────────────────────────────────────────────────────────────────────────
-- Distinguish "nobody above them" from "not set up yet".
--
-- A null manager_id meant both, so the owner of a company was permanently
-- reported as a misconfiguration nobody could clear — the warning was correct
-- for an unconfigured employee and wrong for the person at the top, and
-- nothing could tell them apart.
--
-- The flag makes it explicit. It also gives the approval engine something to
-- act on: a step routing to "the traveller's own manager" has genuinely
-- nowhere to go for the person at the top, and that is a legitimate outcome
-- rather than a configuration error to report.
-- ─────────────────────────────────────────────────────────────────────────────

begin;

alter table employees
  add column if not exists top_of_hierarchy boolean not null default false;

comment on column employees.top_of_hierarchy is
  'True when nobody is above this person. Distinguishes an intentionally empty manager_id from one never configured.';

-- Being at the top and reporting to someone are contradictory. Enforced here
-- rather than in the route so it holds for bulk import and any future writer.
alter table employees
  drop constraint if exists employees_top_of_hierarchy_ck;

alter table employees
  add constraint employees_top_of_hierarchy_ck
  check (not (top_of_hierarchy and manager_id is not null));

commit;
