import type { Queryable } from '@/app/lib/db'
import type { FlatFlightResult } from '@/app/lib/book/types'
import { loadClientGates } from '@/app/lib/clients/clientGates'
import { resolveEffectivePolicy } from '@/app/lib/rule-engine/resolveEffectivePolicy'
import { evaluateBooking } from '@/app/lib/rule-engine/evaluateBooking'
import { buildPolicyInputsFromFlight } from '@/app/lib/rule-engine/buildPolicyInputs'
import type { ShownFlight } from './lowestLogicalFare'

// ── judgeSearchResults ───────────────────────────────────────────────────────
// Each fare in a search gets the traveller's policy verdict, for the chip on
// the result card ("Within policy" / "Needs approval" / "Out of policy").
//
// The same judgement the policy preview and add-passenger make: the fare's
// sell estimate (what the company pays), its refundability and cancellation
// fees, its cabin and carrier, and the lowest logical fare against what this
// same search showed. The policy is resolved ONCE (both domestic and
// international flights read the 'flight' rules); every fare after that is
// judged in memory, so thirty results cost the same few queries as one.
//
// No verdict at all when the client has policy control off or the traveller
// has no policy (no band, no group, no rules): a card then shows no chip, as
// the fare page shows no stoplight. A failure here is logged and the results
// go out without chips: a chip is guidance, never a reason to fail a search.
// The authoritative verdict is still add-passenger's.
// ─────────────────────────────────────────────────────────────────────────────

export async function judgeSearchResults(
  db: Queryable,
  traveller: { id: string; client_id: string | null },
  results: FlatFlightResult[],
  shown: ShownFlight[],
): Promise<FlatFlightResult[]> {
  if (results.length === 0) return results
  try {
    const gates = await loadClientGates(db, traveller.client_id)
    if (!gates.policyControlling) return results
    const policy = await resolveEffectivePolicy(db, traveller.id, 'flight')
    if (!policy.ok) return results

    return results.map(flight => ({
      ...flight,
      fareOptions: flight.fareOptions.map(fare => {
        const amount = fare.sellEstimate ?? fare.totalFare
        if (typeof amount !== 'number') return fare
        const inputs = buildPolicyInputsFromFlight({
          flight, totalFare: amount, isRefundable: fare.refundable ?? false, cancelPenalties: fare.cancelPenalties,
        })
        const { verdict } = evaluateBooking(policy, {
          ...inputs,
          search: { flights: shown, flightKey: flight.flightKey, pricingKey: fare.pricingKey },
        })
        return { ...fare, policy: verdict }
      }),
    }))
  } catch (err) {
    console.error('[search] could not judge the results against policy; sent without chips', err)
    return results
  }
}
