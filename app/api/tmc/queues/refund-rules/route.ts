import { NextRequest } from 'next/server'
import { requireUser } from '@/app/lib/auth/session'
import { db } from '@/app/lib/db'
import * as refunds from '@/app/lib/repositories/refunds'
import { refundCaller } from '@/app/lib/refunds/access'
import { route } from '@/app/lib/http/handler'
import { parsePageParams, pagedResponse } from '@/app/lib/pagination'

// ── GET /api/tmc/queues/refund-rules?search=&page= ────────────────────────────────
// Each client's refund rule, with how many refunds are waiting, for the
// "Refund rules" tab of the Cancellation queues. Read-only: the rule is saved
// through PATCH /api/tmc/clients/[id], the same as Corporate Settings.
// TMC staff with process_refunds, within their reach.
// ─────────────────────────────────────────────────────────────────────────────

export const GET = route(async (req: NextRequest) => {
  const user = await requireUser()
  const caller = await refundCaller(db, user.id)
  if (!caller.ok) return Response.json({ error: caller.error }, { status: caller.status })
  const q = req.nextUrl.searchParams
  const params = parsePageParams(q)
  const { rows, total } = await refunds.refundRules(db, { tmcId: caller.tmcId, clientIds: caller.clientIds, search: q.get('search') }, params)
  return Response.json(pagedResponse(rows, total, params))
})
