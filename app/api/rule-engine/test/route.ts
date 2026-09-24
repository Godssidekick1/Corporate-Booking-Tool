import { createClient } from '@/utils/supabase/server'
import * as employees from '@/app/lib/repositories/employees'
import * as clients from '@/app/lib/repositories/clients'
import { route } from '@/app/lib/http/handler'
import { checkBookingAgainstPolicy } from '@/app/lib/rule-engine/checkBookingAgainstPolicy'
import { requireTmcPermission } from '@/app/lib/permissions/requireTmcPermission'
import { NextRequest } from 'next/server'
import { db } from '@/app/lib/db'

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

export const POST = route(async (req: NextRequest) => {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const body: TestRequestBody = await req.json()
  const { employeeId, travelType, totalCost, numericValues, booleanValues, tierValues } = body

  if (!employeeId || !travelType || totalCost === undefined) {
    return Response.json({ error: 'employeeId, travelType, and totalCost are required' }, { status: 400 })
  }

  const employee = await employees.policySubject(db, employeeId)

  if (!employee) {
    return Response.json({ error: 'Employee not found' }, { status: 404 })
  }

  const auth = await requireTmcPermission(db, user.id, 'manage_policy', employee.client_id ?? undefined)
  if (!auth.authorized) {
    return Response.json({ error: auth.error }, { status: auth.status ?? 403 })
  }

  // A tmc_admin passes the check above for any client, so the traveller's
  // client must be this TMC's -- or any TMC could read anyone's policy by
  // employee id. Answered like a missing employee.
  const client = employee.client_id ? await clients.tenancy(db, employee.client_id) : null

  if (!client || client.tmc_id !== auth.tmcId) {
    return Response.json({ error: 'Employee not found' }, { status: 404 })
  }

  const result = await checkBookingAgainstPolicy(db, {
    employeeId,
    travelType,
    totalCost,
    numericValues: numericValues ?? {},
    booleanValues: booleanValues ?? {},
    tierValues: tierValues ?? {},
  })

  return Response.json({ ok: true, result })
})
