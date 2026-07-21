import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { requireTmcPermission } from '@/app/lib/permissions/requireTmcPermission'
import { checkBookingAgainstPolicy } from '@/app/lib/rule-engine/checkBookingAgainstPolicy'
import { NextRequest } from 'next/server'

// ── POST /api/rule-engine/test ───────────────────────────────────────────────
// TMC-side sandbox for the Rule Engine. Takes a mock booking (employee +
// travel type + cost + candidate numeric/boolean values) and runs it through
// checkBookingAgainstPolicy, returning the same verdict shape a real booking
// flow would get. No booking or search is created — this only exists so a
// TMC/TC can verify the policy they configured behaves as expected.
// ─────────────────────────────────────────────────────────────────────────────

interface TestBody {
  employeeId: string
  travelType: string
  totalCost: number
  numericValues?: Partial<Record<string, number>>
  booleanValues?: Partial<Record<string, boolean>>
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const service = createServiceClient()
  const body: TestBody = await req.json()
  const { employeeId, travelType, totalCost, numericValues, booleanValues } = body

  if (!employeeId || !travelType) {
    return Response.json({ error: 'employeeId and travelType are required' }, { status: 400 })
  }

  if (totalCost === undefined || totalCost === null || Number.isNaN(Number(totalCost))) {
    return Response.json({ error: 'totalCost is required and must be a number' }, { status: 400 })
  }

  // Resolve the employee's company first — the permission check (and the
  // rest of the Rule Engine) is scoped by company, but the client only sends
  // employeeId, same as /api/tmc/employee-assignments POST.
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

  const result = await checkBookingAgainstPolicy(service, {
    employeeId,
    travelType,
    totalCost: Number(totalCost),
    numericValues: numericValues ?? {},
    booleanValues: booleanValues ?? {},
  })

  return Response.json({ ok: true, result })
}