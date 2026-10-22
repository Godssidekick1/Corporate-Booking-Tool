import { NextRequest } from 'next/server'
import { requireUser } from '@/app/lib/auth/session'
import { route } from '@/app/lib/http/handler'
import { CORPORATE_REPORTS } from '@/app/lib/reports/registry'
import { companyScope } from '@/app/lib/reports/access'
import { respond } from '@/app/lib/reports/respond'

// ── GET /api/reports/[report] ────────────────────────────────────────────────
// One company report: ?from&to (India dates) and its filters, as JSON; with
// &format=csv&table=<key>, one of its tables as a CSV file.
// ─────────────────────────────────────────────────────────────────────────────

type Ctx = { params: Promise<{ report: string }> }

export const GET = route(async (req: NextRequest, { params }: Ctx) => {
  const { report } = await params
  const user = await requireUser()
  const access = await companyScope(user.id)
  if ('refused' in access) return access.refused
  return respond(CORPORATE_REPORTS, report, access.scope, req.nextUrl.searchParams, user.id)
})
