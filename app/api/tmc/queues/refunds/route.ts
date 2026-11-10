import { NextRequest } from 'next/server'
import { requireUser } from '@/app/lib/auth/session'
import { db } from '@/app/lib/db'
import * as refunds from '@/app/lib/repositories/refunds'
import { refundCaller } from '@/app/lib/refunds/access'
import { route } from '@/app/lib/http/handler'
import { parsePageParams, pagedResponse } from '@/app/lib/pagination'
import { isUuid } from '@/app/lib/book/bookingActor'

// ── GET /api/tmc/queues/refunds ──────────────────────────────────────────────
// The cancellation queue: one row per cancelled ticket, awaiting confirmation
// first, then pending, then the settled ones (app/lib/repositories/refunds.ts).
//
//   ?search=     booking ref, PNR, airline PNR, ticket no, transaction id,
//                credit note no, or passenger name
//   ?state=      cancel_requested | pending | processed | rejected
//   ?clientId= &groupId= &airline= &source=self|desk|colleague
//   ?from= &to=          requested (cancelled) between, YYYY-MM-DD
//   ?depFrom= &depTo=    departing between, YYYY-MM-DD
//   ?page=
//
// TMC staff with process_refunds, within their reach (app/lib/refunds/access.ts).
// ─────────────────────────────────────────────────────────────────────────────

const DATE = /^\d{4}-\d{2}-\d{2}$/
const date = (v: string | null) => (v && DATE.test(v) ? v : null)
const oneOf = <T extends string>(v: string | null, options: readonly T[]) => (options as readonly string[]).includes(v ?? '') ? v as T : null

export const GET = route(async (req: NextRequest) => {
  const user = await requireUser()
  const caller = await refundCaller(db, user.id)
  if (!caller.ok) return Response.json({ error: caller.error }, { status: caller.status })

  const q = req.nextUrl.searchParams
  const params = parsePageParams(q)
  const { rows, total } = await refunds.queue(db, {
    tmcId: caller.tmcId,
    clientIds: caller.clientIds,
    search: q.get('search'),
    state: oneOf(q.get('state'), refunds.QUEUE_STATES),
    clientId: isUuid(q.get('clientId')) ? q.get('clientId') : null,
    groupId: isUuid(q.get('groupId')) ? q.get('groupId') : null,
    airline: /^[A-Za-z0-9]{2}$/.test(q.get('airline') ?? '') ? q.get('airline') : null,
    source: oneOf(q.get('source'), refunds.SOURCES),
    requestedFrom: date(q.get('from')),
    requestedTo: date(q.get('to')),
    departureFrom: date(q.get('depFrom')),
    departureTo: date(q.get('depTo')),
  }, params)

  return Response.json(pagedResponse(rows, total, params))
})
