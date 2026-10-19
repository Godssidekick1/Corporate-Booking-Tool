import { NextRequest } from 'next/server'
import { requireUser } from '@/app/lib/auth/session'
import { db } from '@/app/lib/db'
import { route } from '@/app/lib/http/handler'
import { resolveActor, refuse } from '@/app/lib/book/bookingActor'
import { loadClientGates } from '@/app/lib/clients/clientGates'
import { QUOTE_HOLD_MINUTES } from '@/app/lib/book/quoteHold'

// ── GET /api/book/controls?travellerId= ──────────────────────────────────────
// How the traveller's company books (Corporate Settings), for the booking
// screens to offer only what add-passenger will accept: personal trips, guest
// bookings, whether an out-of-policy fare needs a reason or cannot be booked,
// and the duplicate check. The TRAVELLER's company, whoever is booking.
//
// The screens are a convenience. add-passenger checks every one of these again.
// ─────────────────────────────────────────────────────────────────────────────

export const GET = route(async (req: NextRequest) => {
  const user = await requireUser()
  const actor = await resolveActor(db, user, req.nextUrl.searchParams.get('travellerId') || undefined)
  if (!actor.ok) return refuse(actor)

  const gates = await loadClientGates(db, actor.actor.traveller.client_id)
  return Response.json({
    ok: true,
    personalAllowed: gates.personalBookingsAllowed,
    guestAllowed: gates.guestBookingsAllowed,
    reasonRequired: gates.outOfPolicyReasonRequired,
    blocksRed: gates.blockRed,
    duplicateCheck: gates.duplicateCheck,
    quoteHoldMinutes: QUOTE_HOLD_MINUTES,
  })
})
