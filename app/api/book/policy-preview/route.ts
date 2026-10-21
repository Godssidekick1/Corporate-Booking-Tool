import { resolveActor, refuse } from '@/app/lib/book/bookingActor'
import { requireUser } from '@/app/lib/auth/session'
import { db } from '@/app/lib/db'
import { route } from '@/app/lib/http/handler'
import { NextRequest } from 'next/server'
import { checkBookingAgainstPolicy } from '@/app/lib/rule-engine/checkBookingAgainstPolicy'
import { buildPolicyInputsFromFlight } from '@/app/lib/rule-engine/buildPolicyInputs'
import { buildReason } from '@/app/lib/approval-engine/resolveApprovalTier'
import * as bookings from '@/app/lib/repositories/bookings'
import type { FlatFlightResult, PenaltyLine } from '@/app/lib/book/types'

// ── POST /api/book/policy-preview ────────────────────────────────────────────
// Read-only verdict check, called from /book/details/[flightKey] — BEFORE
// add-passenger, so no bookings row exists yet. Fires on a debounce as the
// employee fills in details/picks seats, so the stoplight banner updates
// live rather than only appearing after they submit. Lets the UI show a
// green/amber/red verdict with the breach reason before they commit.
//
// This is a preview only — it does NOT create an approvals row or persist
// anything. The real, authoritative verdict is computed again (and stored)
// in add-passenger, since seats/fare could still change between here and
// submission. Never trust this route's output for gating a real booking.
// ─────────────────────────────────────────────────────────────────────────────

interface PreviewBody {
  travellerId?: string // booking for someone else: THEIR policy is previewed
  flight: FlatFlightResult
  totalFare: number
  // The price the company pays (with markup, discount and fee), which is what
  // add-passenger judges. Older pages sent only totalFare, the airline's.
  sellTotal?: number
  isRefundable: boolean
  cancelPenalties?: PenaltyLine[]
  selectedSeatFees?: string[]
  // The search it came from and the fare chosen, for the lowest logical fare.
  searchKey?: string
  pricingKey?: string
}

export const POST = route(async (req: NextRequest) => {
  const user = await requireUser()

  const body: PreviewBody = await req.json()

  // The traveller's policy, not the booker's. Booking for oneself keeps its
  // refusals: a CBT-only client's people are refused here.
  const actor = await resolveActor(db, user, body.travellerId)
  if (!actor.ok) return refuse(actor)
  const employee = actor.actor.traveller
  const { flight, totalFare, sellTotal, isRefundable, selectedSeatFees, cancelPenalties, searchKey, pricingKey } = body

  if (!flight || totalFare === undefined) {
    return Response.json({ error: 'flight and totalFare are required' }, { status: 400 })
  }

  const inputs = buildPolicyInputsFromFlight({
    flight, totalFare: sellTotal ?? totalFare, isRefundable, selectedSeatFees, cancelPenalties,
  })
  const shown = searchKey && pricingKey ? await bookings.searchFares(db, searchKey, employee.id) : null
  const result = await checkBookingAgainstPolicy(db, {
    employeeId: employee.id,
    travelType: inputs.travelType,
    totalCost: inputs.totalCost,
    numericValues: inputs.numericValues,
    booleanValues: inputs.booleanValues,
    tierValues: inputs.tierValues,
    search: shown && pricingKey ? { flights: shown, flightKey: flight.flightKey, pricingKey } : undefined,
  })

  if (!result.ok) {
    // No policy configured — not an error the fare-selection UI needs to
    // alarm the employee about; just tell it there's nothing to preview.
    return Response.json({ ok: false, reason: result.reason, message: result.message })
  }

  return Response.json({
    ok: true,
    verdict: result.verdict,
    breaches: result.breaches,
    reason: buildReason(result.breaches),
  })
})