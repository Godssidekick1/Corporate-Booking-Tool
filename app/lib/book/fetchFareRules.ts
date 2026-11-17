import { amadeus, type FareRuleRequest } from '@/app/lib/amadeus/client'
import { parseFareRules, type FareRules } from '@/app/lib/book/fareRules'

// ── Ask the airline for a fare's rules, never at the cost of the booking ─────
// The rules are worth showing, not worth failing for: nothing here throws.
// The answer says why there are no rules, so the fare page can tell "the
// airline has none" from "the airline did not answer in time":
//   ok       rules came back
//   none     the airline answered, with no rules for this fare
//   timeout  no answer within the wait
//   error    the call failed (the provider refused it, or it could not be read)
// ─────────────────────────────────────────────────────────────────────────────

export const FARE_RULE_TIMEOUT_MS = 8000

export type FareRulesOutcome = 'ok' | 'none' | 'timeout' | 'error'
export interface FareRulesResult { rules: FareRules | null; outcome: FareRulesOutcome }

export async function fetchFareRules(req: FareRuleRequest, timeoutMs = FARE_RULE_TIMEOUT_MS): Promise<FareRulesResult> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const timeout = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), timeoutMs) })
    const response = await Promise.race([amadeus.fareRule(req), timeout])
    if (!response) {
      console.warn(`[fare rules] the airline did not answer within ${Math.round(timeoutMs / 1000)} s`)
      return { rules: null, outcome: 'timeout' }
    }
    const rules = parseFareRules(response)
    return { rules, outcome: rules?.sectors.length ? 'ok' : 'none' }
  } catch (error) {
    console.warn('[fare rules] not available:', error instanceof Error ? error.message : error)
    return { rules: null, outcome: 'error' }
  } finally {
    if (timer) clearTimeout(timer)
  }
}
