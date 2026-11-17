import type { Queryable } from '@/app/lib/db'
import { setQuoteFareRules } from '@/app/lib/repositories/bookings'
import { fetchFareRules, type FareRulesOutcome, type FareRulesResult } from '@/app/lib/book/fetchFareRules'
import type { FareRules } from '@/app/lib/book/fareRules'

// ── A fare's rules: started early, kept on the quote ─────────────────────────
// The airline's fare-rule answer is slow (7-22 s on the test system), so it is
// asked as early as possible: /api/book/price starts it beside the pricing
// call (startFareRules), and /api/book/fare-rules then picks up that same
// call instead of starting a second one (rulesForQuote). Whichever finishes
// it keeps the rules on the quote, which add-passenger copies onto the booking.
//
// The calls in flight are held in this server's memory, keyed by the fare. On
// a host where the two requests land on different servers, the fare-rules
// request simply asks the airline itself: slower, never wrong.
//
// Every key comes from the price request (which the airline validates) or from
// the saved quote, never from the fare-rules request.
// ─────────────────────────────────────────────────────────────────────────────

// Long enough for the airline's fare-rule answer: 7-12 s on the test system on
// 16 Nov, 13-23 s on 17 Nov. The price is already on screen, so waiting costs
// only the rules panel.
export const FARE_RULES_WAIT_MS = 45_000
// A good answer is reused for this long (the same fare opened again).
const KEEP_OK_MS = 2 * 60_000

export interface FareKeys { key: string; pricingKey: string; resultIndex: string; provider: string }

const inFlight = new Map<string, Promise<FareRulesResult>>()
const idOf = (k: FareKeys) => [k.key, k.pricingKey, k.resultIndex, k.provider].join('|')

// Starts the airline call for a fare, or joins the one already running.
// A failed or empty answer is forgotten at once, so asking again tries again.
export function startFareRules(keys: FareKeys): Promise<FareRulesResult> {
  const id = idOf(keys)
  const running = inFlight.get(id)
  if (running) return running
  const call = fetchFareRules(keys, FARE_RULES_WAIT_MS).then(result => {
    if (result.outcome === 'ok') {
      const t = setTimeout(() => { if (inFlight.get(id) === call) inFlight.delete(id) }, KEEP_OK_MS)
      t.unref?.()
    } else if (inFlight.get(id) === call) {
      inFlight.delete(id)
    }
    return result
  })
  inFlight.set(id, call)
  return call
}

// Tests only: every test starts with nothing in flight.
export function forgetFareRulesInFlight(): void {
  inFlight.clear()
}

export interface QuoteKeys {
  id: string
  search_key: string | null
  pricing_key: string
  provider: string
  result_index: string | null
  fare_rules: FareRules | null
}

export type QuoteRulesOutcome = FareRulesOutcome | 'kept' | 'no_search_key'

export async function rulesForQuote(
  db: Queryable, quote: QuoteKeys, timeoutMs = FARE_RULES_WAIT_MS,
): Promise<{ rules: FareRules | null; outcome: QuoteRulesOutcome }> {
  if (quote.fare_rules) return { rules: quote.fare_rules, outcome: 'kept' }
  // A quote priced before the search key was kept: nothing to ask with.
  if (!quote.search_key) return { rules: null, outcome: 'no_search_key' }

  const call = startFareRules({
    key: quote.search_key, pricingKey: quote.pricing_key, provider: quote.provider, resultIndex: String(quote.result_index ?? ''),
  })
  // The caller's own limit (add-passenger waits less than the fare page).
  let timer: ReturnType<typeof setTimeout> | undefined
  const result = await Promise.race([
    call,
    new Promise<FareRulesResult>(resolve => { timer = setTimeout(() => resolve({ rules: null, outcome: 'timeout' }), timeoutMs) }),
  ])
  if (timer) clearTimeout(timer)

  if (result.rules) {
    try {
      await setQuoteFareRules(db, quote.id, result.rules)
    } catch (error) {
      // Shown anyway; add-passenger will ask again if they were not kept.
      console.error('[fare rules] could not keep them on the quote', error)
    }
  }
  return result
}
