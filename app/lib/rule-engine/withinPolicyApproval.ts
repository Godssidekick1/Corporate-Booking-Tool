import type { Queryable } from '@/app/lib/db'
import { loadClientGates } from '@/app/lib/clients/clientGates'
import { resolveEffectivePolicy } from './resolveEffectivePolicy'

// ── withinPolicyApprovalFor ──────────────────────────────────────────────────
// Whether a within-policy booking goes for approval, for this traveller:
//   1. the company's Corporate Setting, when it has one (it overrides);
//   2. otherwise the traveller's policy group (within_policy_approval:
//      0 approved automatically, 1 sent for approval);
//   3. otherwise approved automatically.
// The group is read only where policy is in force: a client with policy
// control off has no policy to ask, so 3 applies.
// Needs-approval and out-of-policy bookings always go, whatever this says.
// ─────────────────────────────────────────────────────────────────────────────

export type WithinPolicyApproval = 'auto' | 'required'

export async function withinPolicyApprovalFor(
  db: Queryable,
  travellerId: string,
  clientId: string,
  companySetting: string | null | undefined,
): Promise<WithinPolicyApproval> {
  if (companySetting === 'auto' || companySetting === 'required') return companySetting

  const gates = await loadClientGates(db, clientId)
  if (!gates.policyControlling) return 'auto'
  const policy = await resolveEffectivePolicy(db, travellerId, 'flight')
  if (!policy.ok) return 'auto'
  return Number(policy.limits['within_policy_approval']) === 1 ? 'required' : 'auto'
}
