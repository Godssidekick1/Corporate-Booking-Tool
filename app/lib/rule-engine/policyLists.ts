import type { Queryable } from '@/app/lib/db'
import { loadClientGates } from '@/app/lib/clients/clientGates'
import * as employees from '@/app/lib/repositories/employees'
import { resolveEffectivePolicy } from './resolveEffectivePolicy'
import { NO_LISTS, type PolicyLists } from '@/app/lib/policy/searchFilter'

// ── policyListsFor ────────────────────────────────────────────────────────────
// The traveller's blocked / preferred airlines and allowed fare types: the
// same policy group the verdict uses, resolved the same way. Whoever is
// booking, it is the TRAVELLER's policy, so a corporate admin or the desk
// booking for someone sees what that person may book.
//
// No lists (nothing filtered) when the client has policy control switched off,
// or the traveller has no policy to resolve. Those bookings are already
// "not evaluated"; hiding fares on top of that, by a policy that does not
// apply, would be the one thing worse.
// ─────────────────────────────────────────────────────────────────────────────

export async function policyListsFor(db: Queryable, travellerId: string): Promise<PolicyLists> {
  const subject = await employees.policySubject(db, travellerId)
  const gates = await loadClientGates(db, subject?.client_id)
  if (!gates.policyControlling) return NO_LISTS

  const policy = await resolveEffectivePolicy(db, travellerId, 'flight')
  if (!policy.ok) return NO_LISTS

  return {
    blockedAirlines: policy.lists['blocked_airlines'] ?? [],
    preferredAirlines: policy.lists['preferred_airlines'] ?? [],
    allowedFareTypes: policy.lists['allowed_fare_types'] ?? [],
  }
}
