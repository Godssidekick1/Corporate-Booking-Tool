import { requireUser } from '@/app/lib/auth/session'
import { db } from '@/app/lib/db'
import { route } from '@/app/lib/http/handler'
import * as reports from '@/app/lib/repositories/reports'
import { companyScope } from '@/app/lib/reports/access'
import { defaultRange } from '@/app/lib/reports/filters'

// ── GET /api/reports ─────────────────────────────────────────────────────────
// The choices the company reports' filters offer: departments, cost centres
// and bands of the caller's own company. The reports themselves are listed
// in app/lib/reports/catalog.ts.
// ─────────────────────────────────────────────────────────────────────────────

export const GET = route(async () => {
  const user = await requireUser()
  const access = await companyScope(user.id)
  if ('refused' in access) return access.refused
  const options = await reports.corporateOptions(db, access.scope.clientId)
  return Response.json({ ok: true, options, range: defaultRange() })
})
