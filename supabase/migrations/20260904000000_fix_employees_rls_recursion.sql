-- ============================================================================
-- Fix: infinite recursion in the employees RLS policies
--
-- THE FAULT
--   Both policies on `employees` answered "who am I?" with a subquery against
--   `employees`. Evaluating the policy therefore required evaluating the
--   policy, and Postgres refuses:
--
--     42P17  infinite recursion detected in policy for relation "employees"
--
--   This was not latent. Every anon-key SELECT on employees returned that
--   error, which means proxy.ts -- the only anon-client reader of the table --
--   never once got a row back. It destructures `data` alone, so the error was
--   discarded and `first_login_completed` came back undefined on every
--   request. The onboarding gate tests `=== false`, and `undefined === false`
--   is false, so new users were never redirected to complete their profile.
--
-- THE FIX
--   Answer "who am I?" from a SECURITY DEFINER function instead. It executes
--   as its owner, who bypasses RLS on the tables it touches, so reading
--   `employees` inside it does not re-enter the policy. This is the standard
--   resolution for self-referential RLS.
--
--   Two helpers rather than one, because BOTH halves of the admin policy
--   consulted `employees`: the client scope and the role check. Fixing only
--   the scope would have moved the recursion, not removed it.
--
-- SEMANTICS ARE UNCHANGED
--   Deliberately a repair, not a redesign. The rule stays "an authenticated
--   user may read every employee at their own client, and an admin may update
--   them". The old admin policy compared against a subquery that returned NULL
--   for non-admins, denying by NULL; the explicit role test below denies the
--   same callers, just legibly.
--
-- ON SECURITY DEFINER
--   search_path is pinned. Without it the function resolves `employees`
--   through the caller's search_path, which lets any caller who can create a
--   schema shadow the table and have privileged code read theirs instead.
--   STABLE (not VOLATILE) lets the planner evaluate it once per statement
--   rather than once per row.
-- ============================================================================

begin;

create or replace function current_client_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select client_id from employees where id = auth.uid()
$$;

comment on function current_client_id() is
  'The calling user''s client_id. SECURITY DEFINER so that RLS policies on employees can scope by client without recursing into themselves.';

create or replace function current_employee_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role from employees where id = auth.uid()
$$;

comment on function current_employee_role() is
  'The calling user''s role. Exists for the same reason as current_client_id(): a role check written as a subquery on employees re-enters the employees policy.';

drop policy if exists "Employees: read own client" on employees;

create policy "Employees: read own client"
  on employees
  for select
  using (client_id = current_client_id());

drop policy if exists "Employees: admin update client" on employees;

create policy "Employees: admin update client"
  on employees
  for update
  using (
    client_id = current_client_id()
    and current_employee_role() = 'admin'
  );

commit;
