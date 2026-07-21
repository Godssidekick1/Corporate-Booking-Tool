import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { requireTmcPermission } from '@/app/lib/permissions/requireTmcPermission'
import { NextRequest } from 'next/server'

// ── GET /api/tmc/employee-assignments?companyId=<uuid> ───────────────────────
// Lists all employees for a company with their current policy group (if any).
//
// ── POST /api/tmc/employee-assignments ───────────────────────────────────────
// Assigns one employee to one policy group. Enforces the one-group-per-
// employee rule at the application layer (schema supports many-to-many,
// deliberately unused per an earlier decision) — any existing assignment
// for this employee is deleted before the new one is inserted.
// ─────────────────────────────────────────────────────────────────────────────

interface AssignBody {
  employeeId: string
  policyGroupId: string
}

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const service = createServiceClient()
  const companyId = req.nextUrl.searchParams.get('companyId')

  if (!companyId) {
    return Response.json({ error: 'companyId is required' }, { status: 400 })
  }

  const auth = await requireTmcPermission(service, user.id, 'manage_policy', companyId)
  if (!auth.authorized) {
    return Response.json({ error: auth.error }, { status: auth.status ?? 403 })
  }

  const { data: employees, error } = await service
    .from('employees')
    .select('id, full_name, email, band_code, status')
    .eq('company_id', companyId)
    .order('full_name')

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  const employeeIds = (employees ?? []).map(e => e.id)
  let assignmentByEmployee = new Map<string, { policy_group_id: string }>()

  if (employeeIds.length > 0) {
    const { data: assignments } = await service
      .from('employee_policy_groups')
      .select('employee_id, policy_group_id')
      .in('employee_id', employeeIds)

    for (const a of assignments ?? []) {
      assignmentByEmployee.set(a.employee_id, { policy_group_id: a.policy_group_id })
    }
  }

  const enriched = (employees ?? []).map(e => ({
    ...e,
    policyGroupId: assignmentByEmployee.get(e.id)?.policy_group_id ?? null,
  }))

  return Response.json({ ok: true, employees: enriched })
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const service = createServiceClient()
  const { employeeId, policyGroupId }: AssignBody = await req.json()

  if (!employeeId || !policyGroupId) {
    return Response.json({ error: 'employeeId and policyGroupId are required' }, { status: 400 })
  }

  const { data: employee } = await service
    .from('employees')
    .select('company_id')
    .eq('id', employeeId)
    .maybeSingle()

  if (!employee) {
    return Response.json({ error: 'Employee not found' }, { status: 404 })
  }

  const auth = await requireTmcPermission(service, user.id, 'manage_policy', employee.company_id)
  if (!auth.authorized) {
    return Response.json({ error: auth.error }, { status: auth.status ?? 403 })
  }

  const { data: group } = await service
    .from('policy_groups')
    .select('id')
    .eq('id', policyGroupId)
    .eq('company_id', employee.company_id)
    .maybeSingle()

  if (!group) {
    return Response.json({ error: 'Policy group not found for this company' }, { status: 404 })
  }

  // Enforce one-group-per-employee: clear any existing assignment first.
  await service.from('employee_policy_groups').delete().eq('employee_id', employeeId)

  const { error } = await service.from('employee_policy_groups').insert({
    employee_id: employeeId,
    policy_group_id: policyGroupId,
    assigned_by: user.id,
  })

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  return Response.json({ ok: true })
}