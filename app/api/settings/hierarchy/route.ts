import { requireUser } from '@/app/lib/auth/session'
import { parsePageParams, pagedResponse } from '@/app/lib/pagination'
import { NextRequest } from 'next/server'
import { db } from '@/app/lib/db'
import * as employees from '@/app/lib/repositories/employees'
import { route } from '@/app/lib/http/handler'

// ── GET /api/settings/hierarchy ──────────────────────────────────────────────
// Who reports to whom in the admin's client, one searched page at a time, each
// row carrying its manager's name. `missingManager` counts the whole client's
// active people with no reporting line (not just this page's), for the warning.
// Read-only: reporting lines are the TMC's to edit.
// ─────────────────────────────────────────────────────────────────────────────

export const GET = route(async (req: NextRequest) => {
  const user = await requireUser()

  const caller = await employees.clientScope(db, user.id)
  if (!caller) {
    return Response.json({ error: 'Employee record not found' }, { status: 404 })
  }
  if (caller.role !== 'admin') {
    return Response.json({ error: 'Only admins can view the reporting hierarchy' }, { status: 403 })
  }

  const params = parsePageParams(req.nextUrl.searchParams)
  if (!caller.client_id) {
    return Response.json({ ...pagedResponse([], 0, params), missingManager: 0 })
  }

  const [{ rows, total }, missingManager] = await Promise.all([
    employees.hierarchy(db, caller.client_id, { search: params.search, page: params }),
    employees.countMissingManager(db, caller.client_id),
  ])
  return Response.json({ ...pagedResponse(rows, total, params), missingManager })
})
