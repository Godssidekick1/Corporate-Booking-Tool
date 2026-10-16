import { NextRequest } from 'next/server'
import { db, transaction } from '@/app/lib/db'
import * as trips from '@/app/lib/repositories/trips'
import * as clients from '@/app/lib/repositories/clients'
import { route } from '@/app/lib/http/handler'
import { tripAccess } from '@/app/lib/trips/access'
import { startApprovalForTrip } from '@/app/lib/approval-engine/resolveApprovalTier'
import type { Verdict } from '@/app/lib/rule-engine/evaluateBooking'

// ── POST /api/trips/[tripId]/submit ──────────────────────────────────────────
// Sends a finished trip for sign-off. Not air approval: each flight was
// approved, if it needed to be, when it was booked. This is the company
// signing off the trip as a whole, once, when everything in it is booked --
// the approver sees those flights and the trip's details and approves or
// rejects the trip. (Hotels and cabs approved inside the sign-off are a later
// feature: docs/future-changes.md.)
//
// The traveller, or whoever may book for them (the desk, an admin colleague),
// submits. Refused unless:
//   - the company signs trips off (clients.trip_approval_mode),
//   - the trip is open or active, and not already awaiting or past sign-off,
//   - it has at least one live booking, and every one of them is booked
//     (held or ticketed) -- nothing still waiting on air approval or on the
//     airline.
// A rejected trip can be edited and submitted again; its earlier steps stay
// as the record.
// ─────────────────────────────────────────────────────────────────────────────

type Ctx = { params: Promise<{ tripId: string }> }

const BOOKED = new Set(['held', 'ticketed'])
const VERDICT_RANK: Record<Verdict, number> = { green: 0, amber: 1, red: 2 }

export const POST = route(async (req: NextRequest, { params }: Ctx) => {
  const { tripId } = await params
  const access = await tripAccess(tripId, 'submit')
  if (access.error) return access.error
  const { trip, user } = access

  const modes = await clients.approvalModes(db, trip.client_id)
  if (modes?.trip_approval_mode !== 'on_submit') {
    return Response.json({ error: 'This company does not sign trips off.' }, { status: 409 })
  }
  if (trip.status !== 'open' && trip.status !== 'active') {
    return Response.json({ error: `This trip is ${trip.status}.` }, { status: 409 })
  }
  if (trip.approval_status === 'pending') {
    return Response.json({ error: 'This trip is already awaiting sign-off.' }, { status: 409 })
  }
  if (trip.approval_status === 'approved') {
    return Response.json({ error: 'This trip is already signed off.' }, { status: 409 })
  }

  const live = await trips.liveBookings(db, tripId)
  if (live.length === 0) {
    return Response.json({ error: 'Add at least one booking before submitting the trip.' }, { status: 409 })
  }
  const unfinished = live.filter(b => !BOOKED.has(b.status)).length
  if (unfinished > 0) {
    return Response.json({
      error: `${unfinished} booking${unfinished === 1 ? ' is' : 's are'} not booked yet -- finish ${unfinished === 1 ? 'it' : 'them'} first.`,
    }, { status: 409 })
  }

  // Routed on the worst verdict among its bookings: a step a company keeps for
  // red spends still sees a trip holding one.
  const verdict = live.reduce<Verdict>((worst, b) => {
    const v = (b.policy_verdict as Verdict | null) ?? 'green'
    return (VERDICT_RANK[v] ?? 0) > VERDICT_RANK[worst] ? v : worst
  }, 'green')
  const reason = `Trip sign-off: ${live.length} booking${live.length === 1 ? '' : 's'}, ` +
    `${trip.currency} ${Math.round(trip.total_cost).toLocaleString('en-IN')}` +
    (trip.budget_amount != null ? ` of a ${trip.currency} ${trip.budget_amount.toLocaleString('en-IN')} budget` : '')

  const result = await transaction(async (tx) => {
    await trips.setApprovalStatus(tx, tripId, 'pending')
    const outcome = await startApprovalForTrip(tx, {
      tripId, clientId: trip.client_id, employeeId: trip.created_by, verdict, reason,
    })
    // Mirrors a booking (add-passenger): nothing to route -> signed off; a step
    // that needs someone but resolved to nobody -> flagged, not left waiting.
    if (!outcome.requiresApproval) {
      await trips.setApprovalStatus(tx, tripId, 'approved')
      return { approvalStatus: 'approved' as const }
    }
    if (!outcome.approverId) {
      await trips.setApprovalStatus(tx, tripId, 'misconfigured')
      return { approvalStatus: 'misconfigured' as const }
    }
    return { approvalStatus: 'pending' as const, tier: outcome.tier }
  }, { userId: user.id })

  return Response.json({ ok: true, ...result })
})
