import { NextRequest } from 'next/server'
import { requireUser } from '@/app/lib/auth/session'
import { db } from '@/app/lib/db'
import * as bookingsRepo from '@/app/lib/repositories/bookings'
import * as employees from '@/app/lib/repositories/employees'
import { route } from '@/app/lib/http/handler'
import { parsePageParams, pagedResponse } from '@/app/lib/pagination'
import { onBehalf, reach, refuse, isUuid } from '@/app/lib/book/bookingActor'
import { travellerItinerary } from '@/app/lib/book/travellerView'

// ── GET /api/book/history ────────────────────────────────────────────────────
// Bookings, for whoever books for other people. One of:
//   ?traveller=<id>   that person's bookings -- for a corporate admin, anyone
//                     at their own client (CBT included: they see everyone's
//                     bookings even where the desk books); for the desk,
//                     anyone it may book for
//   ?bookedBy=me      the ones the caller made for others
//   ?scope=desk       everything booked on someone's behalf within the
//                     caller's reach (the TMC, or a counsellor's portfolio),
//                     optionally &clientId=
// Paged, newest first, sell-side (the figure the company is invoiced).
// ─────────────────────────────────────────────────────────────────────────────

export const GET = route(async (req: NextRequest) => {
  const user = await requireUser()
  const q = req.nextUrl.searchParams
  const params = parsePageParams(q)

  let filter: bookingsRepo.HistoryFilter
  const traveller = q.get('traveller')
  if (traveller) {
    const sameClientAdmin = user.employee?.role === 'admin' && isUuid(traveller) &&
      (await employees.traveller(db, traveller))?.client_id === user.employee.clientId
    if (!sameClientAdmin) {
      const r = await onBehalf(db, user, traveller)
      if (!r.ok) return refuse(r)
    }
    filter = { traveller }
  } else if (q.get('bookedBy') === 'me') {
    filter = { bookedBy: user.id }
  } else if (q.get('scope') === 'desk') {
    const r = await reach(db, user, 'history')
    if (!r.ok) return refuse(r)
    if (!('tmcId' in r)) return refuse({ status: 403, error: 'Only the travel desk has a desk history.' })
    const clientId = q.get('clientId')
    filter = { tmcId: r.tmcId, clientIds: r.clientIds, clientId: isUuid(clientId) ? clientId : null }
  } else {
    return refuse({ status: 400, error: 'Ask for traveller=<id>, bookedBy=me or scope=desk.' })
  }

  const { rows, total } = await bookingsRepo.history(db, filter, params)
  return Response.json(pagedResponse(
    rows.map(b => ({ ...b, itinerary: travellerItinerary(b.itinerary) })),
    total,
    params
  ))
})
