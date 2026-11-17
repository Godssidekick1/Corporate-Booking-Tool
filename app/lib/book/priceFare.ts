import { flowStorage, type PricedFare } from './flowStorage'
import type { FareOption, FlatFlightResult } from './types'
import { asFareRules, type FareRules } from './fareRules'

// ── priceFare ────────────────────────────────────────────────────────────────
// Prices one fare of one flight (POST /api/book/price) and keeps the priced
// fare for the next steps, as the fare page does. Used by the round trip's
// fare page, which prices the onward and the return side by side. The
// availability key is the one the flight was found under (each column of a
// round trip is its own search).
// ─────────────────────────────────────────────────────────────────────────────

export interface PricedLine { source: string; label: string; sign: -1 | 1; amount: number }

export type PriceOutcome =
  | { ok: true; priced: PricedFare; lines: PricedLine[]; fareRules: FareRules | null }
  | { ok: false; error: string }

export async function priceFare(flight: FlatFlightResult, fare: FareOption): Promise<PriceOutcome> {
  const availabilityKey = flowStorage.availabilityKeyFor(flight.flightKey)
  if (!availabilityKey || !fare.pricingKey) {
    return { ok: false, error: 'Missing pricing details for this flight. Please search again.' }
  }
  let data: Record<string, unknown> & { ok?: boolean; error?: string }
  try {
    const res = await fetch('/api/book/price', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        travellerId: flowStorage.travellerId(),
        key: availabilityKey,
        pricingKey: fare.pricingKey,
        provider: flight.provider,
        resultIndex: flight.itemNo,
        itinerary: flight,
      }),
    })
    data = await res.json()
  } catch {
    return { ok: false, error: 'Could not reach the server to confirm this fare. Check your connection and try again.' }
  }
  if (!data.ok) return { ok: false, error: data.error || 'This fare is no longer available. Please choose another flight.' }

  const totalFare = data.totalFare as number
  const priced: PricedFare = {
    flightKey: flight.flightKey,
    key: data.key as string,
    pricingKey: fare.pricingKey,
    provider: flight.provider,
    resultIndex: flight.itemNo,
    referenceNo: data.referenceNo as string,
    totalFare,
    baseFare: data.baseFare as number,
    tax: data.tax as number,
    lines: data.lines as PricedLine[] | undefined,
    // Falls back to the fare when no commercial rule applies, so every reader
    // can treat sellTotal as the price.
    sellTotal: (data.sellTotal as number | undefined) ?? totalFare,
    currency: data.currency as string,
    isRefundable: data.isRefundable as boolean,
    fareType: data.fareType as string,
    mealIncluded: (data.mealIncluded as boolean | undefined) ?? fare.mealIncluded,
    passengerBreakup: data.passengerBreakup,
    cancelPenalties: data.cancelPenalties as PricedFare['cancelPenalties'],
    desk: (data.desk as PricedFare['desk']) ?? undefined,
    pricedAt: Date.now(),
    isNdc: fare.isNdc ?? flight.isNdc,
    searchKey: availabilityKey,
    brandedFareName: fare.brandedFareName,
  }
  flowStorage.savePricedFare(priced)
  return {
    ok: true, priced, lines: (data.lines as PricedLine[] | undefined) ?? [],
    // Fetched separately (fetchRulesFor); the price no longer carries them.
    fareRules: asFareRules(data.fareRules),
  }
}

// The airline's fare rules for a fare just priced (POST /api/book/fare-rules),
// asked once the price is on screen: they take 7-12 s and the price does not
// wait for them. null when the airline gave none or did not answer.
export async function fetchRulesFor(priced: Pick<PricedFare, 'key' | 'referenceNo'>, signal?: AbortSignal): Promise<FareRules | null> {
  try {
    const res = await fetch('/api/book/fare-rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: priced.key, referenceNo: priced.referenceNo }),
      signal,
    })
    const data = await res.json()
    // Said in the console (the dev server's log shows it): a refusal here
    // would otherwise look exactly like "the airline gave no rules".
    if (!data.ok) console.warn('[fare rules] not shown:', res.status, data.error ?? '')
    return data.ok ? asFareRules(data.fareRules) : null
  } catch (error) {
    console.warn('[fare rules] request failed:', error instanceof Error ? error.message : error)
    return null
  }
}

export interface PolicyPreview {
  ok: boolean
  verdict?: 'green' | 'amber' | 'red'
  reason?: string
  message?: string
}

// The policy preview for a priced fare: what add-passenger will judge.
export async function previewPolicy(flight: FlatFlightResult, priced: PricedFare): Promise<PolicyPreview> {
  try {
    const res = await fetch('/api/book/policy-preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        travellerId: flowStorage.travellerId(),
        flight,
        sellTotal: priced.sellTotal ?? priced.totalFare,
        isRefundable: priced.isRefundable,
        cancelPenalties: priced.cancelPenalties,
        searchKey: priced.searchKey,
        pricingKey: priced.pricingKey,
      }),
    })
    return await res.json()
  } catch {
    return { ok: false }
  }
}
