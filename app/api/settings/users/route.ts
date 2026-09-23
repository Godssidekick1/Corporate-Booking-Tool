import { createClient } from '@/utils/supabase/server'
import { parsePageParams, pagedResponse } from '@/app/lib/pagination'
import { NextRequest } from 'next/server'
import { db } from '@/app/lib/db'
import * as employees from '@/app/lib/repositories/employees'
import { route } from '@/app/lib/http/handler'

// ── GET /api/settings/users ──────────────────────────────────────────────────
// List all employees in the admin's client, for the settings/users table.

export const GET = route(async (req: NextRequest) => {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const caller = await employees.clientScope(db, user.id)

  if (!caller) {
    return Response.json({ error: 'Employee record not found' }, { status: 404 })
  }

  if (caller.role !== 'admin') {
    return Response.json({ error: 'Only admins can view the user list' }, { status: 403 })
  }

  const params = parsePageParams(req.nextUrl.searchParams)
  const ids = req.nextUrl.searchParams.get('ids')?.split(',').filter(Boolean) ?? []

  // The hierarchy screen renders a reporting TREE, which needs every node to
  // resolve manager_id to a name — a tree built from ten rows is not a tree,
  // it is ten disconnected fragments. So it opts out of paging.
  //
  // Capped rather than unbounded: this is an escape hatch for one view with a
  // genuine structural need, not a way for any caller to ask for everything.
  const wantsAll = req.nextUrl.searchParams.get('all') === 'true'
  const ALL_CAP = 1000

  // An admin always belongs to a client; one who somehow does not has nobody
  // to list, which is what the old `client_id = null` filter returned too.
  if (!caller.client_id) {
    return Response.json(pagedResponse([], 0, params))
  }

  const { rows, total } = await employees.directory(
    db,
    caller.client_id,
    ids.length > 0 ? { ids }
      : wantsAll ? { cap: ALL_CAP }
      : { search: params.search, page: params }
  )

  return Response.json(pagedResponse(rows, total, params))
})