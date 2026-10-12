import { NextRequest } from 'next/server'
import { requireUser } from '@/app/lib/auth/session'
import { requireTmcPermission, getAccessibleClientIds } from '@/app/lib/permissions/requireTmcPermission'
import { db } from '@/app/lib/db'
import * as clientsRepo from '@/app/lib/repositories/clients'
import { route } from '@/app/lib/http/handler'
import { parsePageParams, pagedResponse } from '@/app/lib/pagination'

// ── GET /api/tmc/stats ───────────────────────────────────────────────────────
// Booking activity across the TMC's clients, for the dashboard.
//
// Aggregated on the server rather than in the browser because the client list
// is scoped per caller (a 'tc' only sees clients they have access to) and
// shipping every booking row to the browser to count them would leak the ones
// they cannot see. Counted IN THE DATABASE (clients.portfolio*): fetching
// every booking and employee to count them here took 639 ms and sent 1.8 MB
// at 10,000 clients (npm run scale).
//
// The per-client table is paged, ten at a time, busiest first; the totals,
// busiest / quietest client and the trend cover every client in scope.
//
// Everything is derived from bookings.created_at, so "last 30 days" is booking
// date, not travel date.
// ─────────────────────────────────────────────────────────────────────────────

const RECENT_DAYS = 30
const TREND_WEEKS = 8

export const GET = route(async (req: NextRequest) => {
  const user = await requireUser()

  const auth = await requireTmcPermission(db, user.id, 'view_reports')
  if (!auth.authorized || !auth.tmcId) {
    return Response.json({ error: auth.error ?? 'Forbidden' }, { status: auth.status ?? 403 })
  }

  const params = parsePageParams(req.nextUrl.searchParams)
  const accessibleIds = await getAccessibleClientIds(db, user.id, auth.role ?? 'tc')

  if (accessibleIds !== null && accessibleIds.length === 0) {
    return Response.json({ ok: true, totals: emptyTotals(), clients: [], trend: [] })
  }

  const recentSince = new Date(Date.now() - RECENT_DAYS * 24 * 60 * 60 * 1000).toISOString()

  // Week starts at midnight UTC, the oldest first, the last one this week.
  const weekStarts: string[] = []
  for (let i = TREND_WEEKS - 1; i >= 0; i--) {
    const start = new Date()
    start.setUTCHours(0, 0, 0, 0)
    start.setUTCDate(start.getUTCDate() - i * 7)
    weekStarts.push(start.toISOString())
  }

  const [{ totals, clients }, trend] = await Promise.all([
    clientsRepo.portfolio(db, auth.tmcId, accessibleIds, recentSince, params),
    clientsRepo.portfolioTrend(db, auth.tmcId, accessibleIds, weekStarts),
  ])

  if (totals.clients === 0) {
    return Response.json({ ok: true, totals: emptyTotals(), clients: [], trend: [] })
  }

  const paging = pagedResponse(clients, totals.clients, params)
  return Response.json({
    ok: true,
    totals,
    clients,
    trend,
    page: paging.page,
    pageSize: paging.pageSize,
    total: paging.total,
    totalPages: paging.totalPages,
  })
})

function emptyTotals() {
  return {
    clients: 0, activeClients: 0, employees: 0, bookings: 0,
    recentBookings: 0, spend: 0, maxBookings: 0, minBookings: 0, avgBookings: 0,
  }
}
