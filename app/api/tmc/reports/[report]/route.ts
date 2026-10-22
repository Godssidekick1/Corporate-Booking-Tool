import { NextRequest } from 'next/server'
import { requireUser } from '@/app/lib/auth/session'
import { route } from '@/app/lib/http/handler'
import { TMC_REPORTS } from '@/app/lib/reports/registry'
import { tmcScope } from '@/app/lib/reports/access'
import { respond } from '@/app/lib/reports/respond'

// ── GET /api/tmc/reports/[report] ────────────────────────────────────────────
// One TMC report over the caller's clients (a counsellor: their portfolio),
// as JSON or, with &format=csv&table=<key>, one table as CSV.
// ─────────────────────────────────────────────────────────────────────────────

type Ctx = { params: Promise<{ report: string }> }

export const GET = route(async (req: NextRequest, { params }: Ctx) => {
  const { report } = await params
  const user = await requireUser()
  const access = await tmcScope(user.id, req.nextUrl.searchParams.get('clientId'))
  if ('refused' in access) return access.refused
  return respond(TMC_REPORTS, report, access.scope, req.nextUrl.searchParams, user.id)
})
