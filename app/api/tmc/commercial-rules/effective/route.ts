import { requireUser } from '@/app/lib/auth/session'
import { requireTmcPermission, getAccessibleClientIds } from '@/app/lib/permissions/requireTmcPermission'
import { parsePageParams, pagedResponse } from '@/app/lib/pagination'
import { KIND_LABELS, type CommercialKind } from '@/app/lib/commercials/calcOnByKind'
import { ensureCommercialCoverage } from '@/app/lib/coverage/commercialCoverage'
import { NextRequest } from 'next/server'
import { db } from '@/app/lib/db'
import * as coverage from '@/app/lib/repositories/coverage'
import { route } from '@/app/lib/http/handler'
import { rateLimited } from '@/app/lib/http/rateLimit'

// ── GET /api/tmc/commercial-rules/effective ──────────────────────────────────
// What each client actually ends up with: one row per client, carrying the
// markup, discount and processing fee in force for them, and whether the fare
// itself loses money (app/lib/coverage/commercialCoverage.ts says how).
//
// Stored per TMC and rebuilt only when a source table changed or the date
// moved on; the request searches and pages the stored rows in SQL. Same shape
// as /api/tmc/deal-codes/effective.
// ─────────────────────────────────────────────────────────────────────────────

const KINDS: readonly CommercialKind[] = ['markup', 'discount', 'processing_fee']

export const GET = route(async (req: NextRequest) => {
  const user = await requireUser()
  const limited = await rateLimited('coverage', user.id)
  if (limited) return limited

  const auth = await requireTmcPermission(db, user.id, 'manage_commercials')
  if (!auth.authorized || !auth.tmcId) {
    return Response.json({ error: auth.error ?? 'Forbidden' }, { status: auth.status ?? 403 })
  }
  const tmcId = auth.tmcId

  const params = parsePageParams(req.nextUrl.searchParams)
  const asked = req.nextUrl.searchParams.get('kind')
  const kind = KINDS.find(k => k === asked) ?? null

  const accessibleIds = await getAccessibleClientIds(db, user.id, auth.role ?? '')
  if (accessibleIds !== null && accessibleIds.length === 0) {
    return Response.json(pagedResponse([], 0, params))
  }

  await ensureCommercialCoverage(tmcId)
  const { items, total, lossMakingCount } =
    await coverage.commercialCoveragePage(db, tmcId, { accessibleIds }, kind, params)

  return Response.json({
    ...pagedResponse(items, total, params),
    // Surfaced on the envelope rather than left for the caller to count, so the
    // screen can warn without reading every page.
    lossMakingCount,
    kindLabels: KIND_LABELS,
  })
})
