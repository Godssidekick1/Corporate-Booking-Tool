import { createClient } from '@/utils/supabase/server'
import { getAccessibleClientIds } from '@/app/lib/permissions/requireTmcPermission'
import { parsePageParams, pagedResponse } from '@/app/lib/pagination'
import { NextRequest } from 'next/server'
import { db } from '@/app/lib/db'
import * as employees from '@/app/lib/repositories/employees'
import * as clients from '@/app/lib/repositories/clients'
import { route } from '@/app/lib/http/handler'

// ── GET /api/tmc/clients ─────────────────────────────────────────────────────
// Paged. Serves both the clients table and every client picker in the app, so
// it takes `search` (server-side, spanning the whole set) and `ids` (resolve
// specific rows by id).
//
// `ids` exists for pickers: once a selection has been made and the search moves
// on, the selected client is no longer in the current page of results, and a
// picker that derives its label from the visible list would blank itself. The
// caller asks for that one row back instead.
// ─────────────────────────────────────────────────────────────────────────────

export const GET = route(async (req: NextRequest) => {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  // Any TMC-side caller (tmc_admin or tc) can view clients — access to
  // WHICH clients is filtered below, not gated by a specific permission key.
  const caller = await employees.accessProfile(db, user.id)

  if (!caller || !caller.tmc_id || (caller.role !== 'tmc_admin' && caller.role !== 'tc')) {
    return Response.json({ error: 'Forbidden' }, { status: 403 })
  }

  const accessibleIds = await getAccessibleClientIds(db, user.id, caller.role)
  const params = parsePageParams(req.nextUrl.searchParams)
  const ids = req.nextUrl.searchParams.get('ids')?.split(',').filter(Boolean) ?? []

  // Deactivated clients are hidden by default. Deactivation is this product's
  // delete (see DELETE /api/tmc/clients/[id]), so a removed client staying in
  // the list would make the action look like it had not worked. The list
  // offers a Show deactivated toggle rather than dropping them for good.
  //
  // `ids` is NOT filtered by status (see listForTmc): a picker must still be
  // able to name a deactivated client on an old booking.
  const includeInactive = req.nextUrl.searchParams.get('includeInactive') === '1'

  // client_code and city are searched too: the code is what a desk quotes on
  // an invoice, and searching by city is how you find "the Mumbai one".
  const { rows, total } = await clients.listForTmc(
    db,
    caller.tmc_id,
    accessibleIds,
    ids.length > 0 ? { ids } : { search: params.search, page: params, includeInactive }
  )

  // Headcount per client, for the nav and the client list. Deactivated people
  // are excluded — the number is meant to read as "how big is this client",
  // not how many rows exist.
  const headcount = await employees.activeHeadcounts(db, rows.map(c => c.id))

  return Response.json(
    pagedResponse(
      rows.map(c => ({ ...c, employeeCount: headcount.get(c.id) ?? 0 })),
      total,
      params
    )
  )
})
