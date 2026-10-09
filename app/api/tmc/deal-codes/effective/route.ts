import { requireUser } from '@/app/lib/auth/session'
import * as coverage from '@/app/lib/repositories/coverage'
import { route } from '@/app/lib/http/handler'
import { rateLimited } from '@/app/lib/http/rateLimit'
import { requireTmcPermission, getAccessibleClientIds } from '@/app/lib/permissions/requireTmcPermission'
import { parsePageParams, pagedResponse } from '@/app/lib/pagination'
import { ensureDealCoverage } from '@/app/lib/coverage/dealCoverage'
import { NextRequest } from 'next/server'
import { db } from '@/app/lib/db'

// ── GET /api/tmc/deal-codes/effective ────────────────────────────────────────
// Coverage: which code actually applies, for every client, and why.
//
// Distinct from the deal-codes master beside it. The master is one row per deal
// the TMC has negotiated, whether or not anyone receives it. This is one row per
// client per airline per type, containing only the winner — the outcome of
// resolution rather than the definitions that fed it.
//
// STORED, THEN SEARCHED AND PAGED IN SQL
// A row's searchable text (client, code, "Bucket · Star Alliance FY26") exists
// only after resolution, so resolving per request meant resolving every client
// on every keystroke (0.9 s at 10,000 clients). The resolved report is stored
// per TMC and rebuilt only when a source table changed or the date moved on
// (app/lib/coverage); the request itself is two indexed queries.
// ─────────────────────────────────────────────────────────────────────────────

export const GET = route(async (req: NextRequest) => {
  const user = await requireUser()
  const limited = await rateLimited('coverage', user.id)
  if (limited) return limited

  const auth = await requireTmcPermission(db, user.id, 'manage_deal_codes')
  if (!auth.authorized || !auth.tmcId) {
    return Response.json({ error: auth.error ?? 'Forbidden' }, { status: auth.status ?? 403 })
  }
  const tmcId = auth.tmcId

  const params = parsePageParams(req.nextUrl.searchParams)
  // Optional: narrow to one client. The screen no longer requires it, but the
  // client detail page reuses this endpoint for its own section.
  const clientId = req.nextUrl.searchParams.get('clientId')

  // A counsellor sees the clients they are assigned to; null means all.
  const accessibleIds = await getAccessibleClientIds(db, user.id, auth.role ?? '')
  if (accessibleIds !== null && accessibleIds.length === 0) {
    return Response.json(pagedResponse([], 0, params))
  }

  await ensureDealCoverage(tmcId)
  const { items, total } = await coverage.dealCoveragePage(db, tmcId, { accessibleIds, clientId }, params)
  return Response.json(pagedResponse(items, total, params))
})
