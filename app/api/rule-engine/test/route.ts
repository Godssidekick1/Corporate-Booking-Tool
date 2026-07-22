import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { checkBookingAgainstPolicy } from '@/app/lib/rule-engine/checkBookingAgainstPolicy'
import { requireTmcPermission } from '@/app/lib/permissions/requireTmcPermission'
import { NextRequest } from 'next/server'

// ── POST /api/rule-engine/test ────────────────────────────────────────────────
// Directly invokes the Rule Engine with manually-supplied booking values —
// no real search or booking involved. Exists to verify resolveEffectivePolicy
// + evaluateBooking work correctly before Amadeus integration exists.
//
// TMC-side only for now (same people configuring policy should be the ones
// testing it against real employees).
// ─────────────────────────────────────────────────────────────────────────────

interface TestRequestBody {
  employeeId: string
  travelType: string
  totalCost: number
  numericValues: Record<string, number>
  booleanValues: Record<string, boolean>
  tierValues?: Record<string, number>
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const service = createServiceClient()
  const body: TestRequestBody = await req.json()
  const { employeeId, travelType, totalCost, numericValues, booleanValues, tierValues } = body

  if (!employeeId || !travelType || totalCost === undefined) {
    return Response.json({ error: 'employeeId, travelType, and totalCost are required' }, { status: 400 })
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

  const result = await checkBookingAgainstPolicy(service, {
    employeeId,
    travelType,
    totalCost,
    numericValues: numericValues ?? {},
    booleanValues: booleanValues ?? {},
    tierValues: tierValues ?? {},
  })

  return Response.json({ ok: true, result })
}