import { NextRequest } from 'next/server'
import { requireUser } from '@/app/lib/auth/session'
import { db } from '@/app/lib/db'
import * as employees from '@/app/lib/repositories/employees'
import { route } from '@/app/lib/http/handler'
import { parsePageParams, pagedResponse } from '@/app/lib/pagination'
import { reach, refuse, isUuid } from '@/app/lib/book/bookingActor'

// ── GET /api/book/travellers ─────────────────────────────────────────────────
// The people the caller may book for, for the "Who's travelling?" picker:
// a corporate admin's colleagues, or the clients a TMC admin or counsellor
// reaches (app/lib/book/bookingActor.ts). Paged and server-searched, with
// `ids` for a picker naming its current selection, and `clientId` to narrow
// the desk to one client.
//
// Each row says whether the person is ready to book (date of birth and
// mobile on their profile; a passport, for abroad) as flags only. The profile
// itself is read for the one person chosen, GET /api/book/travellers/[id].
// ─────────────────────────────────────────────────────────────────────────────

export const GET = route(async (req: NextRequest) => {
  const user = await requireUser()
  const r = await reach(db, user, 'book')
  if (!r.ok) return refuse(r)

  const q = req.nextUrl.searchParams
  const params = parsePageParams(q)
  const ids = q.get('ids')?.split(',').filter(isUuid) ?? []
  const clientId = isUuid(q.get('clientId')) ? q.get('clientId') : null

  const { rows, total } = await employees.bookableList(
    db,
    'clientId' in r ? { clientId: r.clientId } : { tmcId: r.tmcId, clientIds: r.clientIds, clientId },
    ids.length > 0 ? { ids } : { search: params.search, page: params }
  )
  return Response.json(pagedResponse(rows, total, params))
})
