import { createServiceClient } from '@/utils/supabase/service'
import { resolveEffectivePolicy, PolicyBlocked } from './resolveEffectivePolicy'
import { evaluateBooking, VerdictResult } from './evaluateBooking'
import { loadClientGates } from '@/app/lib/clients/clientGates'

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
  | PolicyBlocked

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
  // Corporate Settings can switch policy control off for a client entirely.
  // Checked first: resolving a policy we are then going to ignore is work for
  // nobody, and it would report a configuration gap on a client that has
  // deliberately opted out of being checked.
  const { data: employee } = await service
    .from('employees')
    .select('client_id')
    .eq('id', input.employeeId)
    .maybeSingle()

  const gates = await loadClientGates(service, employee?.client_id)

  if (!gates.policyControlling) {
    return {
      ok: false,
      reason: 'policy_disabled',
      message: 'Policy control is switched off for this client, so this booking was not checked.',
    }
  }

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