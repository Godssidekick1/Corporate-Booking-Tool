import { NextRequest } from 'next/server'
import { requireUser } from '@/app/lib/auth/session'
import { db } from '@/app/lib/db'
import * as employees from '@/app/lib/repositories/employees'
import * as bookingsRepo from '@/app/lib/repositories/bookings'
import { route } from '@/app/lib/http/handler'
import { onBehalf, refuse } from '@/app/lib/book/bookingActor'
import { travellerItinerary } from '@/app/lib/book/travellerView'

// ── GET /api/book/travellers/[id] ────────────────────────────────────────────
// The person chosen in "Who's travelling?": who they are, what applies when
// booking them, their recent bookings, and their travel profile to fill the
// passenger form -- passport included, which the airline needs for a trip
// abroad. Only for someone the caller may book for (bookingActor.onBehalf); a
// person they may not is answered as one who does not exist.
//
// policy: 'guidance' when the desk books at a CBT-only client (verdict shown,
// amber or red needs a reason, no approval chain), otherwise 'approvals' --
// the traveller's own chain decides, exactly as if they had booked.
// ─────────────────────────────────────────────────────────────────────────────

export const GET = route(async (_req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const user = await requireUser()
  const { id } = await params

  const r = await onBehalf(db, user, id)
  if (!r.ok) return refuse(r)
  const { traveller, via, bookingMode } = r.actor

  const [summary, record, recent] = await Promise.all([
    employees.bookableList(db, { clientId: traveller.client_id! }, { ids: [traveller.id] }),
    employees.travellerRecord(db, traveller.id),
    bookingsRepo.recentFor(db, [traveller.id], 5),
  ])
  const person = summary.rows[0]
  if (!person || !record) return refuse({ status: 404, error: 'Traveller not found' })

  return Response.json({
    ok: true,
    traveller: person,
    policy: via === 'tmc' && bookingMode === 'cbt' ? 'guidance' : 'approvals',
    profile: record.traveler_profile ?? null,
    recentBookings: recent.map(b => ({
      id: b.id, status: b.status, pnr: b.pnr, total_cost: b.total_cost, created_at: b.created_at,
      itinerary: travellerItinerary(b.itinerary),
    })),
  })
})
