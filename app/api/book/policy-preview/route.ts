import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { NextRequest } from 'next/server'
import { checkBookingAgainstPolicy } from '@/app/lib/rule-engine/checkBookingAgainstPolicy'
import { buildPolicyInputsFromFlight } from '@/app/lib/rule-engine/buildPolicyInputs'
import { buildReason } from '@/app/lib/approval-engine/resolveApprovalTier'
import type { FlatFlightResult } from '@/app/lib/book/types'

// ── POST /api/book/policy-preview ────────────────────────────────────────────
// Read-only verdict check, called from /book/details/[flightKey] — BEFORE
// add-passenger, so no bookings row exists yet. Fires on a debounce as the
// employee fills in details/picks seats, so the stoplight banner updates
// live rather than only appearing after they submit. Lets the UI show a
// green/amber/red verdict with the breach reason before they commit.
//
// This is a preview only — it does NOT create an approvals row or persist
// anything. The real, authoritative verdict is computed again (and stored)
// in add-passenger, since seats/fare could still change between here and
// submission. Never trust this route's output for gating a real booking.
// ─────────────────────────────────────────────────────────────────────────────

interface PreviewBody {
  flight: FlatFlightResult
  totalFare: number
  isRefundable: boolean
  selectedSeatFees?: string[]
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const service = createServiceClient()
  const { data: employee } = await service
    .from('employees')
    .select('id')
    .eq('id', user.id)
    .maybeSingle()

  if (!employee) {
    return Response.json({ error: 'Employee record not found' }, { status: 404 })
  }

  const body: PreviewBody = await req.json()
  const { flight, totalFare, isRefundable, selectedSeatFees } = body

  if (!flight || totalFare === undefined) {
    return Response.json({ error: 'flight and totalFare are required' }, { status: 400 })
  }

  const inputs = buildPolicyInputsFromFlight({ flight, totalFare, isRefundable, selectedSeatFees })
  const result = await checkBookingAgainstPolicy(service, {
    employeeId: employee.id,
    travelType: inputs.travelType,
    totalCost: inputs.totalCost,
    numericValues: inputs.numericValues,
    booleanValues: inputs.booleanValues,
    tierValues: inputs.tierValues,
  })

  if (!result.ok) {
    // No policy configured — not an error the fare-selection UI needs to
    // alarm the employee about; just tell it there's nothing to preview.
    return Response.json({ ok: false, reason: result.reason, message: result.message })
  }

  return Response.json({
    ok: true,
    verdict: result.verdict,
    breaches: result.breaches,
    costTier: result.costTier,
    reason: buildReason(result.breaches, result.costTier, totalFare),
  })
}