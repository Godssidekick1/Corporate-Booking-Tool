-- ── No 'manager' role ────────────────────────────────────────────────────────
-- Problem: 'manager' was a role beside 'employee', but a manager is an employee
-- with people reporting to them. The two could disagree: someone with the role
-- and no team was offered to "any manager at or above rank X" approval steps,
-- while an employee with a whole team was not. The reporting line
-- (employees.manager_id) is the one fact that says who manages whom, so it now
-- decides alone.
--
-- Change:
--   * every 'manager' becomes 'employee'. Their reporting lines are untouched,
--     so anyone who manages people keeps approving for them;
--   * employees.role is constrained to the roles that exist, so 'manager' (or
--     any other stray value) cannot come back. Validated now: should a
--     database hold an unexpected role, this migration fails and says so
--     rather than leaving the constraint half-enforced.
--
-- Unchanged: the 'manager' and 'any_manager_at' APPROVER TYPES. They name a
-- step's approver, not a role: the traveller's own manager (via manager_id),
-- and anyone at or above a band rank who has direct reports (or is an admin).
-- ─────────────────────────────────────────────────────────────────────────────

update employees set role = 'employee' where role = 'manager';

alter table employees drop constraint if exists employees_role_check;
alter table employees add constraint employees_role_check
  check (role in ('employee', 'finance', 'admin', 'tmc_admin', 'tc'));
