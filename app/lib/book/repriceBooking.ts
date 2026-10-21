import type { Queryable } from '@/app/lib/db'
import type * as bookings from '@/app/lib/repositories/bookings'
import type { extractPricingDetails } from '@/app/api/book/price/route'
import { checkBookingAgainstPolicy } from '@/app/lib/rule-engine/checkBookingAgainstPolicy'
import { buildPolicyInputsFromFlight } from '@/app/lib/rule-engine/buildPolicyInputs'
import { buildReason } from '@/app/lib/approval-engine/resolveApprovalTier'
import { stampCommercials } from '@/app/lib/commercials/stampCommercials'
import { emptyCommercials } from '@/app/lib/commercials/composeSellPrice'
import type { FareComponents } from '@/app/lib/commercials/fareComponents'
import type { FlatFlightResult } from '@/app/lib/book/types'

// ── priceAgain ───────────────────────────────────────────────────────────────
// What a fresh airline price makes of a booking: commercials re-resolved
// (rules are date-windowed; one that lapsed since stops applying), policy
// judged again on the new SELL total, and the row to save with the new key
// (bookings.applyRefreshedFare). Nothing is written here, so a caller can
// compare before it saves. Used when an approver refreshes a fare, and when
// the booking route re-prices an expired session and the fare has risen past
// what the company lets through without a fresh approval.
// ─────────────────────────────────────────────────────────────────────────────

export type PricingDetails = NonNullable<ReturnType<typeof extractPricingDetails>>

export interface Repriced {
  fare: bookings.RefreshedFare
  totalCost: number        // airline side, seat fees included
  sellTotal: number        // what the company pays, seat fees included
  verdict: string | null
  reason: string
}

export async function priceAgain(
  db: Queryable,
  booking: bookings.RefreshTarget,
  details: PricingDetails,
): Promise<Repriced> {
  // Seats were already chosen and paid for: a re-price changes the fare only,
  // so the existing seat fees are carried into the new totals.
  const seatFees = (booking.fare_breakdown as { seatFees?: number } | null)?.seatFees ?? 0
  const flight = booking.itinerary as FlatFlightResult | null

  const components: FareComponents = {
    base: details.baseFare ?? 0,
    otherTax: details.tax ?? 0,
    fuelSurcharge: details.fuelSurcharge ?? 0,
    taxLines: details.taxLines ?? [],
    total: details.totalFare ?? 0,
  }
  const { record } = booking.client_id
    ? await stampCommercials(db, {
        clientId: booking.client_id,
        flight: flight ?? null,
        components,
        pax: Math.max(1, details.passengerBreakup?.length ?? 1),
      })
    : { record: emptyCommercials(components) }

  // The airline side keeps total_cost; the client side gets sell_total. Seat
  // fees are an airline charge and land on both, unmarked-up.
  const totalCost = (details.totalFare ?? 0) + seatFees
  const sellTotal = record.sellTotal + seatFees

  let verdict: string | null = null
  let verdictDetail: unknown = null
  let reason = 'Policy could not be re-evaluated for this booking.'
  if (flight) {
    const inputs = buildPolicyInputsFromFlight({
      flight,
      totalFare: sellTotal,
      isRefundable: details.isRefundable ?? false,
      selectedSeatFees: seatFees ? [String(seatFees)] : [],
      cancelPenalties: details.cancelPenalties,
    })
    const result = await checkBookingAgainstPolicy(db, {
      employeeId: booking.employee_id,
      travelType: inputs.travelType,
      totalCost: inputs.totalCost,
      numericValues: inputs.numericValues,
      booleanValues: inputs.booleanValues,
      tierValues: inputs.tierValues,
    })
    if (result.ok) {
      verdict = result.verdict
      verdictDetail = { breaches: result.breaches }
      reason = buildReason(result.breaches)
    } else {
      reason = result.message
    }
  }

  const fare: bookings.RefreshedFare = {
    total_cost: totalCost,
    sell_total: sellTotal,
    commercials: record,
    amadeus_key: details.key,
    policy_verdict: verdict,
    policy_verdict_detail: verdictDetail,
    fare_breakdown: {
      ...(booking.fare_breakdown as object ?? {}),
      currency: details.currency,
      isRefundable: details.isRefundable,
      fareType: details.fareType,
      passengerBreakup: details.passengerBreakup,
      seatFees,
    },
  }
  return { fare, totalCost, sellTotal, verdict, reason }
}

// ── fareRoseTooFar ───────────────────────────────────────────────────────────
// Whether a fresh airline total has risen past the company's threshold over
// the one approved (clients.fare_rise_reapproval, as a % of it or in ₹). Null
// threshold: never. A fall, or no change, never asks again.
// ─────────────────────────────────────────────────────────────────────────────

export function fareRoseTooFar(
  approved: number,
  fresh: number,
  threshold: number | null,
  unit: string | null,
): boolean {
  if (threshold === null || !(fresh > approved)) return false
  const rise = fresh - approved
  return unit === 'inr' ? rise > threshold : rise > approved * (threshold / 100)
}
