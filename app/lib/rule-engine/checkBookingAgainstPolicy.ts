import { createServiceClient } from '@/utils/supabase/service'
import { resolveEffectivePolicy } from './resolveEffectivePolicy'
import { evaluateBooking, VerdictResult } from './evaluateBooking'

type ServiceClient = ReturnType<typeof createServiceClient>

export interface BookingCheckInput {
  employeeId: string
  travelType: string
  totalCost: number
  numericValues: Partial<Record<string, number>>
  booleanValues: Partial<Record<string, boolean>>
  tierValues?: Partial<Record<string, number>>
}

export type RuleEngineResult =
  | { ok: true; policyGroupName: string; bandCode: string } & VerdictResult
  | { ok: false; reason: 'no_policy_group' | 'no_policy_rules'; message: string }

// ── checkBookingAgainstPolicy ─────────────────────────────────────────────────
// The Rule Engine's single entry point. Resolves the employee's effective
// policy, then evaluates the proposed booking against it.
//
// A missing/unconfigured policy is a system gap and blocks (ok: false) —
// but once a real policy exists, this NEVER blocks; it only classifies
// severity (green/amber/red) for the Approval Engine to route accordingly.
// ─────────────────────────────────────────────────────────────────────────────

export async function checkBookingAgainstPolicy(
  service: ServiceClient,
  input: BookingCheckInput
): Promise<RuleEngineResult> {
  const policy = await resolveEffectivePolicy(service, input.employeeId, input.travelType)

  if (!policy.ok) {
    return { ok: false, reason: policy.reason, message: policy.message }
  }

  const result = evaluateBooking(policy, {
    totalCost: input.totalCost,
    numericValues: input.numericValues,
    booleanValues: input.booleanValues,
    tierValues: input.tierValues,
  })

  return {
    ok: true,
    policyGroupName: policy.policyGroupName,
    bandCode: policy.bandCode,
    ...result,
  }
}