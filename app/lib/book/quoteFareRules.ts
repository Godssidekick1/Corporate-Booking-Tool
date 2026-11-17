import type { Queryable } from '@/app/lib/db'
import { setQuoteFareRules } from '@/app/lib/repositories/bookings'
import { fetchFareRules } from '@/app/lib/book/fetchFareRules'
import type { FareRules } from '@/app/lib/book/fareRules'

// ── A quote's fare rules: kept ones, or asked of the airline and kept ─────────
// Used by /api/book/fare-rules (the fare page, after the price is shown) and
// by add-passenger (one more try before the rules are copied onto a booking).
// Every key comes from the saved quote, never from the browser. Never throws:
// no rules is null.
// ─────────────────────────────────────────────────────────────────────────────

// Long enough for the airline's fare-rule answer, which takes 7-12 s on the
// test system (two or three at once are the slow end). The price is already
// on screen, so waiting costs only the rules panel.
export const FARE_RULES_WAIT_MS = 25_000

export interface QuoteKeys {
  id: string
  search_key: string | null
  pricing_key: string
  provider: string
  result_index: string | null
  fare_rules: FareRules | null
}

export async function rulesForQuote(db: Queryable, quote: QuoteKeys, timeoutMs = FARE_RULES_WAIT_MS): Promise<FareRules | null> {
  if (quote.fare_rules) return quote.fare_rules
  // A quote priced before the search key was kept: nothing to ask with.
  if (!quote.search_key) return null
  const rules = await fetchFareRules({
    key: quote.search_key, pricingKey: quote.pricing_key, provider: quote.provider, resultIndex: String(quote.result_index ?? ''),
  }, timeoutMs)
  if (rules) {
    try {
      await setQuoteFareRules(db, quote.id, rules)
    } catch (error) {
      // Shown anyway; add-passenger will ask again if they were not kept.
      console.error('[fare rules] could not keep them on the quote', error)
    }
  }
  return rules
}
