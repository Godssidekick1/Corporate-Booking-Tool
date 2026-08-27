import { createServiceClient } from '@/utils/supabase/service'

type ServiceClient = ReturnType<typeof createServiceClient>

// Deep enough for any real org chart, shallow enough that a cycle which
// already exists in the data (from some other bug) can't hang the request in
// an unbounded walk.
const MAX_CHAIN_DEPTH = 50

export type ManagerValidation =
  | { ok: true; managerId: string | null }
  | { ok: false; error: string; status: number }

// ── validateManagerAssignment ────────────────────────────────────────────────
// Checks that making `managerId` the manager of `employeeId` is legal:
//
//   - nobody manages themselves
//   - the proposed manager works at the same company
//   - the assignment doesn't close a reporting loop
//
// Extracted from the corporate users route so the TMC-side route can enforce
// exactly the same rules. The cycle walk is the non-obvious part and must not
// be reimplemented: A managing B while B manages A makes resolveApproverForTier
// loop forever chasing manager_id.
//
// Passing null clears the manager, which is always allowed — an employee with
// no manager simply has no 'manager' approver to resolve to, which the approval
// engine already reports rather than silently approving.
// ─────────────────────────────────────────────────────────────────────────────

export async function validateManagerAssignment(
  service: ServiceClient,
  employeeId: string,
  companyId: string,
  managerId: string | null
): Promise<ManagerValidation> {
  if (managerId === null) {
    return { ok: true, managerId: null }
  }

  if (managerId === employeeId) {
    return { ok: false, error: 'An employee cannot be their own manager.', status: 400 }
  }

  const { data: proposedManager } = await service
    .from('employees')
    .select('id, company_id, manager_id')
    .eq('id', managerId)
    .eq('company_id', companyId)
    .maybeSingle()

  if (!proposedManager) {
    return { ok: false, error: 'Proposed manager not found in this company', status: 422 }
  }

  // Walk the proposed manager's own chain upward. If it reaches this employee,
  // the assignment would close a loop.
  let cursor: string | null = proposedManager.manager_id
  let depth = 0

  while (cursor && depth < MAX_CHAIN_DEPTH) {
    if (cursor === employeeId) {
      return {
        ok: false,
        error: 'This would create a circular reporting chain (the proposed manager already reports up to this employee).',
        status: 400,
      }
    }

    const { data: next } = await service
      .from('employees')
      .select('manager_id')
      .eq('id', cursor)
      .maybeSingle()

    cursor = next?.manager_id ?? null
    depth++
  }

  return { ok: true, managerId }
}
