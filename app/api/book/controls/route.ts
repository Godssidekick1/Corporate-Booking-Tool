import { NextRequest } from 'next/server'
import { requireUser } from '@/app/lib/auth/session'
import { db } from '@/app/lib/db'
import { route } from '@/app/lib/http/handler'
import { resolveActor, refuse } from '@/app/lib/book/bookingActor'
import { loadClientGates } from '@/app/lib/clients/clientGates'
import { QUOTE_HOLD_MINUTES } from '@/app/lib/book/quoteHold'
import { bookingRightsFor } from '@/app/lib/rule-engine/bookingRights'
import * as clients from '@/app/lib/repositories/clients'

// ── GET /api/book/controls?travellerId= ──────────────────────────────────────
// How the traveller's company books (Corporate Settings), for the booking
// screens to offer only what add-passenger will accept: personal trips, guest
// bookings, whether an out-of-policy fare needs a reason or cannot be booked,
// and the duplicate check. The TRAVELLER's company, whoever is booking.
// Personal and guest also need the traveller's band to allow them
// (bookingRights): the company switch alone is not the answer.
//
// The screens are a convenience. add-passenger checks every one of these again.
// ─────────────────────────────────────────────────────────────────────────────

export const GET = route(async (req: NextRequest) => {
  const user = await requireUser()
  const actor = await resolveActor(db, user, req.nextUrl.searchParams.get('travellerId') || undefined)
  if (!actor.ok) return refuse(actor)

  const clientId = actor.actor.traveller.client_id
  const [gates, modes] = await Promise.all([
    loadClientGates(db, clientId),
    clientId ? clients.approvalModes(db, clientId) : null,
  ])
  const rights = await bookingRightsFor(db, actor.actor.traveller.id, gates)
  return Response.json({
    ok: true,
    personalAllowed: rights.personal.allowed,
    guestAllowed: rights.guest.allowed,
    reasonRequired: gates.outOfPolicyReasonRequired,
    blocksRed: gates.blockRed,
    duplicateCheck: gates.duplicateCheck,
    // Whether a within-policy booking still goes for approval (the screens
    // say so rather than promising "no approval needed").
    withinPolicyApproval: modes?.within_policy_approval === 'required' ? 'required' : 'auto',
    quoteHoldMinutes: QUOTE_HOLD_MINUTES,
  })
})
