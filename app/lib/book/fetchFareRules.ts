import { amadeus, type FareRuleRequest } from '@/app/lib/amadeus/client'
import { parseFareRules, type FareRules } from '@/app/lib/book/fareRules'

// ── Ask the airline for a fare's rules, never at the cost of the booking ─────
// The rules are worth showing, not worth failing for: a provider error, a
// timeout or an answer that cannot be read all come back as null, and the
// caller carries on (the page then says the airline gave no rules).
// ─────────────────────────────────────────────────────────────────────────────

export const FARE_RULE_TIMEOUT_MS = 8000

export async function fetchFareRules(req: FareRuleRequest, timeoutMs = FARE_RULE_TIMEOUT_MS): Promise<FareRules | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const timeout = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), timeoutMs) })
    const response = await Promise.race([amadeus.fareRule(req), timeout])
    if (!response) {
      console.warn('[fare rules] the airline did not answer in time')
      return null
    }
    return parseFareRules(response)
  } catch (error) {
    console.warn('[fare rules] not available:', error instanceof Error ? error.message : error)
    return null
  } finally {
    if (timer) clearTimeout(timer)
  }
}
