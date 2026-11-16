import { NextRequest } from 'next/server'
import { requireUser } from '@/app/lib/auth/session'
import { db } from '@/app/lib/db'
import { route } from '@/app/lib/http/handler'
import { parsePageParams, pagedResponse } from '@/app/lib/pagination'
import * as employees from '@/app/lib/repositories/employees'
import * as org from '@/app/lib/repositories/org'
import { visible } from '@/app/lib/org/visible'

// ── GET /api/org/people?search= ──────────────────────────────────────────────
// Find anyone in one's own company, for the Organization page's search, paged.
// ?unassigned=1 (corporate admins only): active people with no manager who are
// not marked the top, whose approvals to "their manager" cannot resolve.
// ─────────────────────────────────────────────────────────────────────────────

export const GET = route(async (req: NextRequest) => {
  const user = await requireUser()
  const me = await employees.clientScope(db, user.id)
  if (!me?.client_id) return Response.json({ error: 'The organization chart is for a company’s people' }, { status: 403 })

  const unassigned = req.nextUrl.searchParams.get('unassigned') === '1'
  if (unassigned && me.role !== 'admin') {
    return Response.json({ error: 'Only your company’s admins can see who has no manager' }, { status: 403 })
  }
  const params = parsePageParams(req.nextUrl.searchParams)
  const { rows, total } = await org.search(db, me.client_id, { search: params.search, unassigned, page: params })
  const viewer = { id: user.id, role: me.role }
  return Response.json(pagedResponse(rows.map(p => visible(p, viewer)), total, params))
})
