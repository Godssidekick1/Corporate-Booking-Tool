import { createServiceClient } from '@/utils/supabase/service'

type ServiceClient = ReturnType<typeof createServiceClient>

export interface TmcCallerCheck {
  authorized: boolean
  role?: string
  tmcId?: string | null
  error?: string
  status?: number
}

// ── requireTmcPermission ─────────────────────────────────────────────────────
// Server-side authorization check for TMC-side routes. tmc_admin always
// passes. A 'tc' caller must have the given permission key, and — if a
// companyId is provided — must also have explicit access to that company.
// Always queries fresh; never trust a permissions array passed in from
// the client.
// ─────────────────────────────────────────────────────────────────────────────

export async function requireTmcPermission(
  service: ServiceClient,
  userId: string,
  permissionKey: string,
  companyId?: string
): Promise<TmcCallerCheck> {
  const { data: caller, error: callerError } = await service
    .from('employees')
    .select('role, tmc_id, status')
    .eq('id', userId)
    .single()

  if (callerError || !caller) {
    return { authorized: false, error: 'Employee record not found', status: 404 }
  }

  if (caller.status === 'deactivated') {
    return { authorized: false, error: 'This account has been deactivated', status: 403 }
  }

  if (!caller.tmc_id || (caller.role !== 'tmc_admin' && caller.role !== 'tc')) {
    return { authorized: false, error: 'Forbidden', status: 403 }
  }

  if (caller.role === 'tmc_admin') {
    return { authorized: true, role: caller.role, tmcId: caller.tmc_id }
  }

  // caller.role === 'tc' — must have the specific permission
  const { data: perm } = await service
    .from('employee_permissions')
    .select('permission_key')
    .eq('employee_id', userId)
    .eq('permission_key', permissionKey)
    .maybeSingle()

  if (!perm) {
    return { authorized: false, error: `Missing permission: ${permissionKey}`, status: 403 }
  }

  if (companyId) {
    const { data: access } = await service
      .from('employee_company_access')
      .select('company_id')
      .eq('employee_id', userId)
      .eq('company_id', companyId)
      .maybeSingle()

    if (!access) {
      return { authorized: false, error: 'No access to this company', status: 403 }
    }
  }

  return { authorized: true, role: caller.role, tmcId: caller.tmc_id }
}

// ── getAccessibleCompanyIds ──────────────────────────────────────────────────
// For list endpoints: returns the company IDs a caller is allowed to see.
// tmc_admin gets null (meaning "all companies for their TMC", no filter needed).
// tc gets the explicit list from employee_company_access (possibly empty).

export async function getAccessibleCompanyIds(
  service: ServiceClient,
  userId: string,
  role: string
): Promise<string[] | null> {
  if (role === 'tmc_admin') return null

  const { data: access } = await service
    .from('employee_company_access')
    .select('company_id')
    .eq('employee_id', userId)

  return (access ?? []).map(a => a.company_id)
}