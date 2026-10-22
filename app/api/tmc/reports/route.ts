import { requireUser } from '@/app/lib/auth/session'
import { db } from '@/app/lib/db'
import { route } from '@/app/lib/http/handler'
import * as reports from '@/app/lib/repositories/reports'
import { tmcScope } from '@/app/lib/reports/access'
import { defaultRange } from '@/app/lib/reports/filters'

// ── GET /api/tmc/reports ─────────────────────────────────────────────────────
// The client groups the TMC reports' filter offers.
// Clients are picked through the usual client lookup, which is already
// scoped to a counsellor's portfolio.
// ─────────────────────────────────────────────────────────────────────────────

export const GET = route(async () => {
  const user = await requireUser()
  const access = await tmcScope(user.id, null)
  if ('refused' in access) return access.refused
  const options = await reports.tmcOptions(db, access.scope.tmcId)
  return Response.json({ ok: true, options, range: defaultRange() })
})
