-- ============================================================================
-- Drop indexes that duplicate another index or a primary key
--
-- Found by comparing every index in the public schema by table, columns,
-- predicate and uniqueness (Stage 2 cleanup). Each one below is fully covered
-- by an index that stays, so dropping it changes no query plan's ability to
-- use an index -- it only stops paying for the duplicate on every write.
-- No data is touched; any of these can be recreated if ever wanted.
--
--   policy_groups (tmc_id, code) WHERE code IS NOT NULL
--     idx_policy_groups_code_per_tmc duplicates policy_groups_tmc_id_code_key,
--     which 20260824000000_policy_master.sql creates and the code relies on.
--     The duplicate predates the migration set. While both existed, a clash on
--     code was reported under whichever PostgreSQL checked first, so the
--     policy-group routes had to accept either name.
--
--   employees (client_id)
--     idx_employees_company duplicates idx_employees_company_id.
--
--   employee_permissions (employee_id)
--   employee_client_access (employee_id)
--     Both single-column indexes on each table are redundant with the primary
--     key, (employee_id, permission_key) and (employee_id, client_id): a
--     b-tree answers "employee_id = ?" from its leading column. Two copies
--     each existed -- one from 20260902000000_nav_reconstruction_housekeeping,
--     one from before the migration set.
-- ============================================================================

drop index if exists public.idx_policy_groups_code_per_tmc;

drop index if exists public.idx_employees_company;

drop index if exists public.employee_permissions_employee_idx;
drop index if exists public.idx_employee_permissions_employee;

drop index if exists public.employee_company_access_employee_idx;
drop index if exists public.idx_employee_company_access_employee;
