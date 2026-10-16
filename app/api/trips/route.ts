import { canSelfBook, SELF_BOOKING_OFF } from '@/app/lib/clients/clientGates'
import { requireUser } from '@/app/lib/auth/session'
import { NextRequest } from 'next/server'
import { db } from '@/app/lib/db'
import * as employees from '@/app/lib/repositories/employees'
import * as trips from '@/app/lib/repositories/trips'
import { route } from '@/app/lib/http/handler'
import { parsePageParams, pagedResponse } from '@/app/lib/pagination'
import { onBehalf, refuse } from '@/app/lib/book/bookingActor'
import * as clients from '@/app/lib/repositories/clients'
import { parseTripDetails } from '@/app/lib/trips/details'

// ── /api/trips ──────────────────────────────────────────────────────────────
// A trip is a named container an employee creates to group everything for
// one journey — flights, hotels, misc expenses — built by repurposing the
// existing booking_groups table (originally scoped to multi-traveler group
// bookings; broadened here to cover both that case and single-traveler
// multi-service trips, since the shape is identical either way).
//
// Scoped to "my trips" only (created_by = current employee) — not every
// trip in the client. A manager wanting visibility into a report's trips
// is a different, later feature (would need its own permission check, not
// just relaxing this filter).
//
// travellerId: someone booking for that traveller (the travel desk, or an
// admin colleague -- app/lib/book/bookingActor.ts) lists and creates THEIR
// trips, by the same rules as booking for them. The trip is the traveller's
// (created_by), so it is in their trips; arranged_by records who set it up.
// ─────────────────────────────────────────────────────────────────────────────

// The New trip form also sends the trip's details (app/lib/trips/details.ts):
// travelType, billable, project, currency, budgetAmount, costCentreId. A
// trip made from the trip picker sends a name only, and they can be added on
// the trip page.
interface CreateTripBody extends Record<string, unknown> {
  name: string
  travellerId?: string
}

export const GET = route(async (req: NextRequest) => {
  const user = await requireUser()

  const travellerId = req.nextUrl.searchParams.get('travellerId')
  let employee: { id: string; client_id: string | null } | null
  if (travellerId && travellerId !== user.id) {
    const r = await onBehalf(db, user, travellerId)
    if (!r.ok) return refuse(r)
    employee = r.actor.traveller
  } else {
    employee = await employees.traveller(db, user.id)
  }

  if (!employee) {
    return Response.json({ error: 'Employee record not found' }, { status: 404 })
  }

  // One page, most recently touched first.
  const params = parsePageParams(req.nextUrl.searchParams)
  const { rows, total } = await trips.mine(db, employee.client_id, employee.id, params)
  const paging = pagedResponse(rows, total, params)
  return Response.json({
    ok: true, trips: rows,
    page: paging.page, pageSize: paging.pageSize, total: paging.total, totalPages: paging.totalPages,
  })
})

export const POST = route(async (req: NextRequest) => {
  const user = await requireUser()
  const body: CreateTripBody = await req.json()
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  const parsed = parseTripDetails(body)
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 })
  // A cost centre is one of the traveller's company's -- never another's.
  const costCentreOk = async (clientId: string | null) =>
    !parsed.details.cost_centre_id || (clientId !== null && await clients.costCentreBelongs(db, parsed.details.cost_centre_id, clientId))

  // A trip for someone else: theirs, set up by the caller. The desk does this
  // at a CBT-only client too -- that is where it books.
  if (body.travellerId && body.travellerId !== user.id) {
    const r = await onBehalf(db, user, body.travellerId)
    if (!r.ok) return refuse(r)
    if (!name) {
      return Response.json({ error: 'Trip name is required' }, { status: 400 })
    }
    const t = r.actor.traveller
    if (!(await costCentreOk(t.client_id))) {
      return Response.json({ error: 'That cost centre is not one of this company\'s' }, { status: 422 })
    }
    const trip = await trips.create(db, {
      client_id: t.client_id!, created_by: t.id, arranged_by: user.id, name, ...parsed.details,
    })
    return Response.json({ ok: true, trip })
  }

  // A CBT-only client's people sign in to see their trips, but the travel desk
  // books for them (clientGates.selfBooking).
  if (!(await canSelfBook(db, user.employee?.clientId))) {
    return Response.json({ error: SELF_BOOKING_OFF }, { status: 403 })
  }

  const employee = await employees.traveller(db, user.id)

  if (!employee) {
    return Response.json({ error: 'Employee record not found' }, { status: 404 })
  }

  if (!name) {
    return Response.json({ error: 'Trip name is required' }, { status: 400 })
  }

  // A trip belongs to a client; TMC staff have none and cannot hold one.
  // Refused, not a server error: nothing went wrong but the request.
  if (!employee.client_id) {
    return Response.json({ error: "Trips belong to a company's travellers; TMC staff cannot hold one" }, { status: 403 })
  }

  if (!(await costCentreOk(employee.client_id))) {
    return Response.json({ error: 'That cost centre is not one of your company\'s' }, { status: 422 })
  }

  const trip = await trips.create(db, { client_id: employee.client_id, created_by: employee.id, name, ...parsed.details })

  return Response.json({ ok: true, trip })
})
